// Checks for values read from files or typed by the user. Anything invalid
// becomes a ModelError whose message can be shown as is.

import { type Base, isBase } from "../format/integers";

export class ModelError extends Error {}

export const MIN_WIDTH = 1;
export const MAX_WIDTH = 512;

export function checkWidth(width: number): void {
  if (!Number.isInteger(width) || width < MIN_WIDTH || width > MAX_WIDTH) {
    throw new ModelError(
      `Width must be a whole number of bits from ${MIN_WIDTH} to ${MAX_WIDTH}`,
    );
  }
}

export function checkBase(value: unknown): Base {
  if (!isBase(value)) throw new ModelError(`Unsupported base ${value}`);
  return value;
}

export function toBig(value: unknown): bigint {
  if (typeof value === "boolean")
    throw new ModelError("boolean is not a number");

  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  const trimmed = String(value).trim();

  try {
    return BigInt(trimmed); // accepts 0x / 0o / 0b prefixes and decimals
  } catch {
    throw new ModelError(`Invalid number ${JSON.stringify(value)}`);
  }
}

/** A bit position from JSON: a number or a string of digits (anything else is NaN, which is rejected later). */
export function bitPosition(value: unknown): number {
  if (typeof value === "number") return value;

  if (typeof value === "string" && /^\d+$/.test(value.trim()))
    return Number(value);

  return Number.NaN;
}

export function checkPositions(lo: number, hi: number): void {
  if (!Number.isInteger(lo) || !Number.isInteger(hi))
    throw new ModelError("Field bit positions must be whole numbers");
}
