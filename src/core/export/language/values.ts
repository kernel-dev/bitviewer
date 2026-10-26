// How template values print, compare and count as true or false. Numbers
// from the export data are Num; maths and comparisons see their plain value.

import { Num, TemplateError } from "./types";

export function valueToText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (value instanceof Num) return value.hex;
  if (typeof value === "object")
    throw new TemplateError(
      "Can't print a list or object; pick a property or use | join",
    );
  return String(value);
}

/** Numbers from the export data arrive as Num; maths and comparisons see them as plain numbers. */
export const unwrap = (value: unknown) =>
  value instanceof Num ? value.big : value;
export const isNumeric = (value: unknown) =>
  typeof unwrap(value) === "number" || typeof unwrap(value) === "bigint";

export function truthy(value: unknown): boolean {
  const plain = unwrap(value);
  return Array.isArray(plain) ? plain.length > 0 : !!plain;
}

export function sameValue(left: unknown, right: unknown): boolean {
  const [a, b] = [unwrap(left), unwrap(right)];
  if (typeof a === "bigint" && typeof b === "bigint") return a === b;
  return isNumeric(a) && isNumeric(b) ? Number(a) === Number(b) : a === b;
}

/** Orders two numbers or two strings; anything else is an error. */
export function compare(
  left: unknown,
  right: unknown,
  operator: string,
  line: number,
): boolean {
  const [a, b] = [unwrap(left), unwrap(right)] as [
    number | string,
    number | string,
  ];
  const kind = (value: unknown) => (isNumeric(value) ? "number" : typeof value);
  if (kind(a) !== kind(b))
    throw new TemplateError(
      `Can't compare ${kind(a)} with ${kind(b)} using ${operator}`,
      line,
    );
  if (operator === "<") return a < b;
  if (operator === "<=") return a <= b;
  if (operator === ">") return a > b;
  return a >= b;
}
