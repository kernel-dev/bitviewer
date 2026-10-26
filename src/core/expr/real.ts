// Real-number evaluation, used for field unit formulas such as
// `x * 0.5 - 40`, and the linearity check that decides whether a formula can
// be turned around to type in a real-world value.

import { smallInt } from "./integer";
import { type Expr, ExprError } from "./parse";

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
