// Field interpretation: signed values, unit formulas (e.g. "x * 0.5 - 40 °C")
// and turning a typed real-world value back into raw bits.
import { ExprError, evalReal, linearity, parseExpr } from "./expr";
import type { Group } from "./model";
import { maxValue } from "./numfmt";

export interface Formula {
  evaluate: (x: number) => number;
  /** [scale, offset] when the formula is linear, so values can be typed back in. */
  linear: [number, number] | null;
}

const cache = new Map<string, Formula>();

/** Compiles a formula in `x`. Throws ExprError for bad formulas. */
export function compileFormula(source: string): Formula {
  const hit = cache.get(source);
  if (hit) return hit;
  const expression = parseExpr(source);
  const evaluate = (x: number) =>
    evalReal(expression, (name) => {
      if (name === "x") return x;
      return undefined;
    });
  evaluate(1); // surfaces unknown names now rather than on every redraw
  const out: Formula = {
    evaluate,
    linear: linearity(evaluate, [2, 7, 1000, -3]),
  };
  cache.set(source, out);
  return out;
}

/** Short, readable number: integers as-is, others to 6 significant digits. */
export function formatReal(value: number): string {
  if (!Number.isFinite(value))
    return Number.isNaN(value) ? "NaN" : value > 0 ? "∞" : "−∞";
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  return String(Number(value.toPrecision(6)));
}

/** The field's number (`raw` read as signed when the field is signed). */
export function fieldNumber(group: Group, raw: bigint): bigint {
  if (!group.signed || group.width < 2) return raw;
  return (raw >> BigInt(group.width - 1)) & 1n
    ? raw - (1n << BigInt(group.width))
    : raw;
}

export interface Decoded {
  /** e.g. "-12", "23.5 °C", "" when there's nothing beyond the raw value */
  text: string;
  error?: string;
}

/** What a field's raw bits mean, for display next to the raw value. */
export function decodeField(group: Group, raw: bigint): Decoded {
  const fieldValue = fieldNumber(group, raw);
  if (!group.formula) {
    const text = group.signed ? fieldValue.toString() : "";
    return {
      text:
        text && group.unit
          ? `${text} ${group.unit}`
          : text || (group.unit ? `${fieldValue} ${group.unit}` : ""),
    };
  }
  try {
    const decoded = compileFormula(group.formula).evaluate(Number(fieldValue));
    return {
      text: `${formatReal(decoded)}${group.unit ? ` ${group.unit}` : ""}`,
    };
  } catch (error) {
    // RangeError: a formula that makes a number too big to handle
    if (error instanceof ExprError || error instanceof RangeError)
      return { text: "", error: error.message };
    throw error;
  }
}

/** Can a real-world value be typed in for this field? */
export function isInvertible(group: Group): boolean {
  if (!group.formula) return true;
  try {
    return compileFormula(group.formula).linear !== null;
  } catch {
    return false;
  }
}

/** Raw bits for a typed real-world value `y`. Throws ExprError when it can't be represented. */
export function rawFromNumber(group: Group, realValue: number): bigint {
  let rawNumber = realValue;
  if (group.formula) {
    const linearFit = compileFormula(group.formula).linear;
    if (!linearFit)
      throw new ExprError(
        "This formula can't be reversed, so type the raw value instead",
      );
    rawNumber = (realValue - linearFit[1]) / linearFit[0];
  }
  if (!Number.isFinite(rawNumber))
    throw new ExprError("That value can't be represented");
  const rounded = BigInt(Math.round(rawNumber));
  const fieldWidth = BigInt(group.width);
  const lo = group.signed && group.width > 1 ? -(1n << (fieldWidth - 1n)) : 0n;
  const hi =
    group.signed && group.width > 1
      ? (1n << (fieldWidth - 1n)) - 1n
      : maxValue(group.width);
  if (rounded < lo || rounded > hi)
    throw new ExprError(
      `Out of range for ${group.width} ${group.signed ? "signed " : ""}bits`,
    );
  return rounded & maxValue(group.width);
}
