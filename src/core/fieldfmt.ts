// Field interpretation: signed values, unit formulas (e.g. "x * 0.5 - 40 °C")
// and turning a typed real-world value back into raw bits.
import { ExprError, evalReal, linearity, parseExpr } from "./expr";
import type { Group } from "./model";
import { maxValue } from "./numfmt";

export interface Formula {
  f: (x: number) => number;
  /** [scale, offset] when the formula is linear, so values can be typed back in. */
  linear: [number, number] | null;
}

const cache = new Map<string, Formula>();

/** Compiles a formula in `x`. Throws ExprError for bad formulas. */
export function compileFormula(src: string): Formula {
  const hit = cache.get(src);
  if (hit) return hit;
  const expr = parseExpr(src);
  const f = (x: number) =>
    evalReal(expr, (n) => {
      if (n === "x") return x;
      return undefined;
    });
  f(1); // surfaces unknown names now rather than on every redraw
  const out: Formula = { f, linear: linearity(f, [2, 7, 1000, -3]) };
  cache.set(src, out);
  return out;
}

/** Short, readable number: integers as-is, others to 6 significant digits. */
export function formatReal(y: number): string {
  if (!Number.isFinite(y)) return Number.isNaN(y) ? "NaN" : y > 0 ? "∞" : "−∞";
  if (Number.isInteger(y) && Math.abs(y) < 1e15) return String(y);
  return String(Number(y.toPrecision(6)));
}

/** The field's number (`raw` read as signed when the field is signed). */
export function fieldNumber(g: Group, raw: bigint): bigint {
  if (!g.signed || g.width < 2) return raw;
  return (raw >> BigInt(g.width - 1)) & 1n ? raw - (1n << BigInt(g.width)) : raw;
}

export interface Decoded {
  /** e.g. "-12", "23.5 °C", "" when there's nothing beyond the raw value */
  text: string;
  error?: string;
}

/** What a field's raw bits mean, for display next to the raw value. */
export function decodeField(g: Group, raw: bigint): Decoded {
  const n = fieldNumber(g, raw);
  if (!g.formula) {
    const text = g.signed ? n.toString() : "";
    return { text: text && g.unit ? `${text} ${g.unit}` : text || (g.unit ? `${n} ${g.unit}` : "") };
  }
  try {
    const y = compileFormula(g.formula).f(Number(n));
    return { text: `${formatReal(y)}${g.unit ? ` ${g.unit}` : ""}` };
  } catch (e) {
    if (e instanceof ExprError) return { text: "", error: e.message };
    throw e;
  }
}

/** Can a real-world value be typed in for this field? */
export function isInvertible(g: Group): boolean {
  if (!g.formula) return true;
  try {
    return compileFormula(g.formula).linear !== null;
  } catch {
    return false;
  }
}

/** Raw bits for a typed real-world value `y`. Throws ExprError when it can't be represented. */
export function rawFromNumber(g: Group, y: number): bigint {
  let x = y;
  if (g.formula) {
    const lin = compileFormula(g.formula).linear;
    if (!lin) throw new ExprError("This formula can't be reversed, so type the raw value instead");
    x = (y - lin[1]) / lin[0];
  }
  if (!Number.isFinite(x)) throw new ExprError("That value can't be represented");
  const n = BigInt(Math.round(x));
  const w = BigInt(g.width);
  const lo = g.signed && g.width > 1 ? -(1n << (w - 1n)) : 0n;
  const hi = g.signed && g.width > 1 ? (1n << (w - 1n)) - 1n : maxValue(g.width);
  if (n < lo || n > hi) throw new ExprError(`Out of range for ${g.width} ${g.signed ? "signed " : ""}bits`);
  return n & maxValue(g.width);
}
