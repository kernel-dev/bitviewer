// A small expression language, parsed by hand (no eval):
//
//   numbers   42  0x2A  0b101010  0o52  1_000  (and 1.5 / 2e-3 in real mode)
//   names     CTRL  x  {Value 1}  `Value 1`   (braces/backticks allow spaces)
//   operators ( )  unary - + ~ !  **  * / %  + -  << >>  &  ^  |
//   calls     min(a, b)  max  abs  bit(n)  mask(n)  popcount(x)
//             real mode also: round floor ceil sqrt pow log log2 log10 exp
//
// Integer mode works on BigInt (exact at 512 bits); real mode on numbers,
// used for field unit formulas such as `x * 0.5 - 40`.

export class ExprError extends Error {}

export type Expr =
  | { kind: "num"; integer: bigint | null; real: number; text: string }
  | { kind: "name"; name: string }
  | { kind: "unary"; operator: string; operand: Expr }
  | { kind: "binary"; operator: string; left: Expr; right: Expr }
  | { kind: "call"; functionName: string; argumentExpressions: Expr[] };

type Tok = {
  kind: "num" | "name" | "op" | "end";
  text: string;
  position: number;
};

const TWO_CHARACTER_OPERATORS = new Set(["**", "<<", ">>"]);
const SINGLE_CHARACTER_OPERATORS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "~",
  "!",
  "(",
  ")",
  ",",
]);
const BINARY_PREC: Record<string, number> = {
  "|": 1,
  "^": 2,
  "&": 3,
  "<<": 4,
  ">>": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};
const MAX_BITS = 4096; // guards against 2 ** 1e9 style requests

function tokenize(source: string): Tok[] {
  const out: Tok[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (/\s/.test(character)) {
      cursor++;
      continue;
    }
    const start = cursor;
    if (character === "{" || character === "`") {
      const close = character === "{" ? "}" : "`";
      const closeIndex = source.indexOf(close, cursor + 1);
      if (closeIndex < 0)
        throw new ExprError(
          `Missing ${close} for the name at position ${cursor + 1}`,
        );
      out.push({
        kind: "name",
        text: source.slice(cursor + 1, closeIndex).trim(),
        position: start,
      });
      cursor = closeIndex + 1;
      continue;
    }
    const numberMatch =
      /^(0x[0-9a-f_]+|0b[01_]+|0o[0-7_]+|(\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(e[+-]?\d+)?)/i.exec(
        source.slice(cursor),
      );
    if (numberMatch && /[0-9.]/.test(character)) {
      out.push({ kind: "num", text: numberMatch[0], position: start });
      cursor += numberMatch[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(cursor));
    if (name) {
      out.push({ kind: "name", text: name[0], position: start });
      cursor += name[0].length;
      continue;
    }
    const two = source.slice(cursor, cursor + 2);
    if (TWO_CHARACTER_OPERATORS.has(two)) {
      out.push({ kind: "op", text: two, position: start });
      cursor += 2;
      continue;
    }
    if (SINGLE_CHARACTER_OPERATORS.has(character)) {
      out.push({ kind: "op", text: character, position: start });
      cursor++;
      continue;
    }
    throw new ExprError(`Unexpected "${character}" at position ${cursor + 1}`);
  }
  out.push({ kind: "end", text: "", position: source.length });
  return out;
}

function numberNode(text: string): Expr {
  const cleaned = text.replace(/_/g, "").toLowerCase();
  if (/^0[xbo]/.test(cleaned)) {
    if (cleaned.length < 3)
      throw new ExprError(`"${text}" needs digits after the prefix`);
    const value = BigInt(cleaned); // BigInt understands 0x / 0b / 0o
    return { kind: "num", integer: value, real: Number(value), text };
  }
  if (/[.e]/.test(cleaned)) {
    const real = Number(cleaned);
    if (Number.isNaN(real)) throw new ExprError(`"${text}" is not a number`);
    return {
      kind: "num",
      integer:
        Number.isInteger(real) && Math.abs(real) < 2 ** 53
          ? BigInt(real)
          : null,
      real,
      text,
    };
  }
  const newValue = BigInt(cleaned);
  return { kind: "num", integer: newValue, real: Number(newValue), text };
}

export function parseExpr(source: string): Expr {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];
  const expect = (expected: string) => {
    const token = next();
    if (token.text !== expected)
      throw new ExprError(
        token.kind === "end"
          ? `Missing "${expected}"`
          : `Expected "${expected}" at position ${token.position + 1}`,
      );
  };

  const parsePrimary = (): Expr => {
    const token = next();
    if (token.kind === "num") return numberNode(token.text);
    if (token.kind === "name") {
      if (peek().text === "(") {
        next();
        const argumentExpressions: Expr[] = [];
        if (peek().text !== ")") {
          argumentExpressions.push(parseBinary(1));
          while (peek().text === ",") {
            next();
            argumentExpressions.push(parseBinary(1));
          }
        }
        expect(")");
        return {
          kind: "call",
          functionName: token.text.toLowerCase(),
          argumentExpressions,
        };
      }
      return { kind: "name", name: token.text };
    }
    if (token.text === "(") {
      const expression = parseBinary(1);
      expect(")");
      return expression;
    }
    throw new ExprError(
      token.kind === "end"
        ? "The expression ends too early"
        : `Unexpected "${token.text}" at position ${token.position + 1}`,
    );
  };
  const parsePower = (): Expr => {
    const base = parsePrimary();
    if (peek().text === "**") {
      next();
      return {
        kind: "binary",
        operator: "**",
        left: base,
        right: parseUnary(),
      }; // right-associative, binds tighter than unary minus on the left
    }
    return base;
  };
  const parseUnary = (): Expr => {
    const token = peek();
    if (token.kind === "op" && ["-", "+", "~", "!"].includes(token.text)) {
      next();
      return { kind: "unary", operator: token.text, operand: parseUnary() };
    }
    return parsePower();
  };
  const parseBinary = (minPrec: number): Expr => {
    let left = parseUnary();
    for (;;) {
      const token = peek();
      const precedence =
        token.kind === "op" ? BINARY_PREC[token.text] : undefined;
      if (precedence === undefined || precedence < minPrec) return left;
      next();
      left = {
        kind: "binary",
        operator: token.text,
        left: left,
        right: parseBinary(precedence + 1),
      };
    }
  };

  if (peek().kind === "end") throw new ExprError("Enter an expression");
  const parsed = parseBinary(1);
  if (peek().kind !== "end")
    throw new ExprError(
      `Unexpected "${peek().text}" at position ${peek().position + 1}`,
    );
  return parsed;
}

/** Names the expression refers to (not counting function names). */
export function namesIn(
  expression: Expr,
  out = new Set<string>(),
): Set<string> {
  if (expression.kind === "name") out.add(expression.name);
  else if (expression.kind === "unary") namesIn(expression.operand, out);
  else if (expression.kind === "binary") {
    namesIn(expression.left, out);
    namesIn(expression.right, out);
  } else if (expression.kind === "call")
    for (const argument of expression.argumentExpressions)
      namesIn(argument, out);
  return out;
}

// ------------------------------------------------------------------ integer evaluation
function guardBits(value: bigint): bigint {
  const bits = (value < 0n ? -value : value).toString(2).length;
  if (bits > MAX_BITS)
    throw new ExprError(`The result is too large (over ${MAX_BITS} bits)`);
  return value;
}

function smallInt(value: bigint, description: string): number {
  if (value < 0n || value > BigInt(MAX_BITS))
    throw new ExprError(`${description} must be between 0 and ${MAX_BITS}`);
  return Number(value);
}

export function evalInt(
  expression: Expr,
  lookup: (name: string) => bigint | undefined,
): bigint {
  const evaluate = (expression: Expr): bigint => evalInt(expression, lookup);
  switch (expression.kind) {
    case "num":
      if (expression.integer === null)
        throw new ExprError(`${expression.text} is not a whole number`);
      return expression.integer;
    case "name": {
      const value = lookup(expression.name);
      if (value === undefined)
        throw new ExprError(`Unknown name "${expression.name}"`);
      return value;
    }
    case "unary": {
      const operand = evaluate(expression.operand);
      if (expression.operator === "-") return -operand;
      if (expression.operator === "+") return operand;
      if (expression.operator === "~") return ~operand;
      return operand === 0n ? 1n : 0n; // !
    }
    case "binary": {
      const left = evaluate(expression.left);
      const right = evaluate(expression.right);
      switch (expression.operator) {
        case "+":
          return guardBits(left + right);
        case "-":
          return guardBits(left - right);
        case "*":
          return guardBits(left * right);
        case "/":
          if (right === 0n) throw new ExprError("Division by zero");
          return left / right;
        case "%":
          if (right === 0n) throw new ExprError("Division by zero");
          return left % right;
        case "**": {
          if (right < 0n)
            throw new ExprError("Negative exponents don't give whole numbers");
          const magnitude = left < 0n ? -left : left;
          const bits = magnitude.toString(2).length;
          if (magnitude > 1n && Number(right) * bits > MAX_BITS)
            throw new ExprError(
              `The result is too large (over ${MAX_BITS} bits)`,
            );
          return left ** right;
        }
        case "<<":
          return guardBits(left << BigInt(smallInt(right, "Shift amount")));
        case ">>":
          return left >> BigInt(smallInt(right, "Shift amount"));
        case "&":
          return left & right;
        case "|":
          return left | right;
        case "^":
          return left ^ right;
      }
      throw new ExprError(`Unknown operator ${expression.operator}`);
    }
    case "call": {
      const argumentValues = expression.argumentExpressions.map(evaluate);
      const requireArgumentCount = (expected: number) => {
        if (argumentValues.length !== expected)
          throw new ExprError(
            `${expression.functionName}() takes ${expected} argument${expected > 1 ? "s" : ""}`,
          );
      };
      switch (expression.functionName) {
        case "min":
        case "max":
          if (!argumentValues.length)
            throw new ExprError(
              `${expression.functionName}() needs at least one argument`,
            );
          return argumentValues.reduce((best, value) =>
            (expression.functionName === "min" ? value < best : value > best)
              ? value
              : best,
          );
        case "abs":
          requireArgumentCount(1);
          return argumentValues[0] < 0n
            ? -argumentValues[0]
            : argumentValues[0];
        case "bit":
          requireArgumentCount(1);
          return 1n << BigInt(smallInt(argumentValues[0], "Bit number"));
        case "mask":
          requireArgumentCount(1);
          return (1n << BigInt(smallInt(argumentValues[0], "Mask width"))) - 1n;
        case "popcount": {
          requireArgumentCount(1);
          if (argumentValues[0] < 0n)
            throw new ExprError("popcount() needs a non-negative number");
          return BigInt(argumentValues[0].toString(2).replace(/0/g, "").length);
        }
      }
      throw new ExprError(
        `Unknown function ${expression.functionName}() — try min, max, abs, bit, mask, popcount`,
      );
    }
  }
}

// ------------------------------------------------------------------ real evaluation
// Looked up with Object.hasOwn, so names like "constructor" are not functions.
const REAL_FUNCS: Record<string, (...numbers: number[]) => number> = {
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sqrt: Math.sqrt,
  pow: Math.pow,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  exp: Math.exp,
};
const REAL_CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

function asInteger(value: number, operator: string): bigint {
  if (!Number.isInteger(value))
    throw new ExprError(`"${operator}" needs whole numbers`);
  return BigInt(value);
}

/** Shift amount for real mode: a whole number from 0 to MAX_BITS. */
function shiftAmount(value: number): bigint {
  return BigInt(smallInt(asInteger(value, "shift"), "Shift amount"));
}

export function evalReal(
  expression: Expr,
  lookup: (name: string) => number | undefined,
): number {
  const evaluate = (expression: Expr): number => evalReal(expression, lookup);
  switch (expression.kind) {
    case "num":
      return expression.real;
    case "name": {
      const constant = expression.name.toLowerCase();
      const value =
        lookup(expression.name) ??
        (Object.hasOwn(REAL_CONSTS, constant)
          ? REAL_CONSTS[constant]
          : undefined);
      if (value === undefined)
        throw new ExprError(`Unknown name "${expression.name}"`);
      return value;
    }
    case "unary": {
      const operand = evaluate(expression.operand);
      if (expression.operator === "-") return -operand;
      if (expression.operator === "+") return operand;
      if (expression.operator === "!") return operand === 0 ? 1 : 0;
      return Number(~asInteger(operand, "~"));
    }
    case "binary": {
      const left = evaluate(expression.left);
      const right = evaluate(expression.right);
      switch (expression.operator) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
        case "%":
          return left % right;
        case "**":
          return left ** right;
        case "<<":
          return Number(asInteger(left, "<<") << shiftAmount(right));
        case ">>":
          return Number(asInteger(left, ">>") >> shiftAmount(right));
        case "&":
          return Number(asInteger(left, "&") & asInteger(right, "&"));
        case "|":
          return Number(asInteger(left, "|") | asInteger(right, "|"));
        case "^":
          return Number(asInteger(left, "^") ^ asInteger(right, "^"));
      }
      throw new ExprError(`Unknown operator ${expression.operator}`);
    }
    case "call": {
      const realFunction = Object.hasOwn(REAL_FUNCS, expression.functionName)
        ? REAL_FUNCS[expression.functionName]
        : undefined;
      if (!realFunction)
        throw new ExprError(
          `Unknown function ${expression.functionName}() — try ${Object.keys(REAL_FUNCS).join(", ")}`,
        );
      return realFunction(...expression.argumentExpressions.map(evaluate));
    }
  }
}

/** If `f(x)` is linear (f(x) = a·x + b) over the sample points, returns [a, b]. */
export function linearity(
  evaluate: (x: number) => number,
  samples: number[],
): [number, number] | null {
  const intercept = evaluate(0);
  const slope = evaluate(1) - intercept;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept) || slope === 0)
    return null;
  for (const x of samples) {
    const expected = slope * x + intercept;
    const actual = evaluate(x);
    if (
      !(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)))
    )
      return null;
  }
  return [slope, intercept];
}
