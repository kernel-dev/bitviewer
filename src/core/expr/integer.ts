// Integer evaluation on BigInt: exact at any width, with limits so a request
// like 2 ** 1e9 fails with a message instead of freezing the app.

import { type Expr, ExprError } from "./parse";

const MAX_BITS = 4096; // guards against 2 ** 1e9 style requests

function guardBits(value: bigint): bigint {
  const bits = (value < 0n ? -value : value).toString(2).length;
  if (bits > MAX_BITS)
    throw new ExprError(`The result is too large (over ${MAX_BITS} bits)`);
  return value;
}

/** A shift amount or bit number: a whole number from 0 to MAX_BITS. */
export function smallInt(value: bigint, description: string): number {
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
