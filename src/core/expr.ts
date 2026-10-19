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
  | { t: "num"; int: bigint | null; real: number; text: string }
  | { t: "name"; name: string }
  | { t: "unary"; op: string; a: Expr }
  | { t: "binary"; op: string; a: Expr; b: Expr }
  | { t: "call"; fn: string; args: Expr[] };

type Tok = { k: "num" | "name" | "op" | "end"; s: string; pos: number };

const OPS3 = new Set(["**", "<<", ">>"]);
const OPS1 = new Set(["+", "-", "*", "/", "%", "&", "|", "^", "~", "!", "(", ")", ","]);
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

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (c === "{" || c === "`") {
      const close = c === "{" ? "}" : "`";
      const j = src.indexOf(close, i + 1);
      if (j < 0) throw new ExprError(`Missing ${close} for the name at position ${i + 1}`);
      out.push({ k: "name", s: src.slice(i + 1, j).trim(), pos: start });
      i = j + 1;
      continue;
    }
    const num = /^(0x[0-9a-f_]+|0b[01_]+|0o[0-7_]+|(\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(e[+-]?\d+)?)/i.exec(src.slice(i));
    if (num && /[0-9.]/.test(c)) {
      out.push({ k: "num", s: num[0], pos: start });
      i += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (name) {
      out.push({ k: "name", s: name[0], pos: start });
      i += name[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS3.has(two)) {
      out.push({ k: "op", s: two, pos: start });
      i += 2;
      continue;
    }
    if (OPS1.has(c)) {
      out.push({ k: "op", s: c, pos: start });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected "${c}" at position ${i + 1}`);
  }
  out.push({ k: "end", s: "", pos: src.length });
  return out;
}

function numberNode(text: string): Expr {
  const s = text.replace(/_/g, "").toLowerCase();
  if (/^0[xbo]/.test(s)) {
    const v = BigInt(s); // BigInt understands 0x / 0b / 0o
    return { t: "num", int: v, real: Number(v), text };
  }
  if (/[.e]/.test(s)) {
    const real = Number(s);
    if (Number.isNaN(real)) throw new ExprError(`"${text}" is not a number`);
    return { t: "num", int: Number.isInteger(real) && Math.abs(real) < 2 ** 53 ? BigInt(real) : null, real, text };
  }
  const v = BigInt(s);
  return { t: "num", int: v, real: Number(v), text };
}

export function parseExpr(src: string): Expr {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (s: string) => {
    const t = next();
    if (t.s !== s) throw new ExprError(t.k === "end" ? `Missing "${s}"` : `Expected "${s}" at position ${t.pos + 1}`);
  };

  const primary = (): Expr => {
    const t = next();
    if (t.k === "num") return numberNode(t.s);
    if (t.k === "name") {
      if (peek().s === "(") {
        next();
        const args: Expr[] = [];
        if (peek().s !== ")") {
          args.push(binary(1));
          while (peek().s === ",") {
            next();
            args.push(binary(1));
          }
        }
        expect(")");
        return { t: "call", fn: t.s.toLowerCase(), args };
      }
      return { t: "name", name: t.s };
    }
    if (t.s === "(") {
      const e = binary(1);
      expect(")");
      return e;
    }
    throw new ExprError(
      t.k === "end" ? "The expression ends too early" : `Unexpected "${t.s}" at position ${t.pos + 1}`,
    );
  };
  const power = (): Expr => {
    const base = primary();
    if (peek().s === "**") {
      next();
      return { t: "binary", op: "**", a: base, b: unary() }; // right-associative, binds tighter than unary minus on the left
    }
    return base;
  };
  const unary = (): Expr => {
    const t = peek();
    if (t.k === "op" && ["-", "+", "~", "!"].includes(t.s)) {
      next();
      return { t: "unary", op: t.s, a: unary() };
    }
    return power();
  };
  const binary = (minPrec: number): Expr => {
    let left = unary();
    for (;;) {
      const t = peek();
      const prec = t.k === "op" ? BINARY_PREC[t.s] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      next();
      left = { t: "binary", op: t.s, a: left, b: binary(prec + 1) };
    }
  };

  if (peek().k === "end") throw new ExprError("Enter an expression");
  const e = binary(1);
  if (peek().k !== "end") throw new ExprError(`Unexpected "${peek().s}" at position ${peek().pos + 1}`);
  return e;
}

/** Names the expression refers to (not counting function names). */
export function namesIn(e: Expr, out = new Set<string>()): Set<string> {
  if (e.t === "name") out.add(e.name);
  else if (e.t === "unary") namesIn(e.a, out);
  else if (e.t === "binary") {
    namesIn(e.a, out);
    namesIn(e.b, out);
  } else if (e.t === "call") for (const a of e.args) namesIn(a, out);
  return out;
}

// ------------------------------------------------------------------ integer evaluation
function guardBits(v: bigint): bigint {
  const bits = (v < 0n ? -v : v).toString(2).length;
  if (bits > MAX_BITS) throw new ExprError(`The result is too large (over ${MAX_BITS} bits)`);
  return v;
}

function smallInt(v: bigint, what: string): number {
  if (v < 0n || v > BigInt(MAX_BITS)) throw new ExprError(`${what} must be between 0 and ${MAX_BITS}`);
  return Number(v);
}

export function evalInt(e: Expr, lookup: (name: string) => bigint | undefined): bigint {
  const ev = (x: Expr): bigint => evalInt(x, lookup);
  switch (e.t) {
    case "num":
      if (e.int === null) throw new ExprError(`${e.text} is not a whole number`);
      return e.int;
    case "name": {
      const v = lookup(e.name);
      if (v === undefined) throw new ExprError(`Unknown name "${e.name}"`);
      return v;
    }
    case "unary": {
      const a = ev(e.a);
      if (e.op === "-") return -a;
      if (e.op === "+") return a;
      if (e.op === "~") return ~a;
      return a === 0n ? 1n : 0n; // !
    }
    case "binary": {
      const a = ev(e.a);
      const b = ev(e.b);
      switch (e.op) {
        case "+":
          return guardBits(a + b);
        case "-":
          return guardBits(a - b);
        case "*":
          return guardBits(a * b);
        case "/":
          if (b === 0n) throw new ExprError("Division by zero");
          return a / b;
        case "%":
          if (b === 0n) throw new ExprError("Division by zero");
          return a % b;
        case "**": {
          if (b < 0n) throw new ExprError("Negative exponents don't give whole numbers");
          const bits = (a < 0n ? -a : a).toString(2).length;
          if (a > 1n && Number(b) * bits > MAX_BITS)
            throw new ExprError(`The result is too large (over ${MAX_BITS} bits)`);
          return a ** b;
        }
        case "<<":
          return guardBits(a << BigInt(smallInt(b, "Shift amount")));
        case ">>":
          return a >> BigInt(smallInt(b, "Shift amount"));
        case "&":
          return a & b;
        case "|":
          return a | b;
        case "^":
          return a ^ b;
      }
      throw new ExprError(`Unknown operator ${e.op}`);
    }
    case "call": {
      const args = e.args.map(ev);
      const need = (n: number) => {
        if (args.length !== n) throw new ExprError(`${e.fn}() takes ${n} argument${n > 1 ? "s" : ""}`);
      };
      switch (e.fn) {
        case "min":
        case "max":
          if (!args.length) throw new ExprError(`${e.fn}() needs at least one argument`);
          return args.reduce((m, v) => ((e.fn === "min" ? v < m : v > m) ? v : m));
        case "abs":
          need(1);
          return args[0] < 0n ? -args[0] : args[0];
        case "bit":
          need(1);
          return 1n << BigInt(smallInt(args[0], "Bit number"));
        case "mask":
          need(1);
          return (1n << BigInt(smallInt(args[0], "Mask width"))) - 1n;
        case "popcount": {
          need(1);
          if (args[0] < 0n) throw new ExprError("popcount() needs a non-negative number");
          return BigInt(args[0].toString(2).replace(/0/g, "").length);
        }
      }
      throw new ExprError(`Unknown function ${e.fn}() — try min, max, abs, bit, mask, popcount`);
    }
  }
}

// ------------------------------------------------------------------ real evaluation
const REAL_FUNCS: Record<string, (...a: number[]) => number> = {
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

function asInteger(v: number, op: string): bigint {
  if (!Number.isInteger(v)) throw new ExprError(`"${op}" needs whole numbers`);
  return BigInt(v);
}

export function evalReal(e: Expr, lookup: (name: string) => number | undefined): number {
  const ev = (x: Expr): number => evalReal(x, lookup);
  switch (e.t) {
    case "num":
      return e.real;
    case "name": {
      const v = lookup(e.name) ?? REAL_CONSTS[e.name.toLowerCase()];
      if (v === undefined) throw new ExprError(`Unknown name "${e.name}"`);
      return v;
    }
    case "unary": {
      const a = ev(e.a);
      if (e.op === "-") return -a;
      if (e.op === "+") return a;
      if (e.op === "!") return a === 0 ? 1 : 0;
      return Number(~asInteger(a, "~"));
    }
    case "binary": {
      const a = ev(e.a);
      const b = ev(e.b);
      switch (e.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return a / b;
        case "%":
          return a % b;
        case "**":
          return a ** b;
        case "<<":
          return Number(asInteger(a, "<<") << asInteger(b, "<<"));
        case ">>":
          return Number(asInteger(a, ">>") >> asInteger(b, ">>"));
        case "&":
          return Number(asInteger(a, "&") & asInteger(b, "&"));
        case "|":
          return Number(asInteger(a, "|") | asInteger(b, "|"));
        case "^":
          return Number(asInteger(a, "^") ^ asInteger(b, "^"));
      }
      throw new ExprError(`Unknown operator ${e.op}`);
    }
    case "call": {
      const f = REAL_FUNCS[e.fn];
      if (!f) throw new ExprError(`Unknown function ${e.fn}() — try ${Object.keys(REAL_FUNCS).join(", ")}`);
      return f(...e.args.map(ev));
    }
  }
}

/** If `f(x)` is linear (f(x) = a·x + b) over the sample points, returns [a, b]. */
export function linearity(f: (x: number) => number, samples: number[]): [number, number] | null {
  const b = f(0);
  const a = f(1) - b;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  for (const x of samples) {
    const want = a * x + b;
    const got = f(x);
    if (!(Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want)))) return null;
  }
  return [a, b];
}
