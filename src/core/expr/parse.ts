// Tokenizer and parser for the expression language (see index.ts for the
// syntax). Binary operators use precedence climbing; ** binds tightest and
// groups to the right.

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
