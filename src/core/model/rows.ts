// Rows: how a value is split up on screen. The "line" view shows the whole
// value as one row; "byte" and "nibble" split it into 8- or 4-bit rows. A row
// is identified by its lowest bit `lo`; only the top row can be shorter.

import { type Base, maxValue } from "../format/integers";

export type View = "line" | "byte" | "nibble";

export const VIEWS: readonly View[] = ["line", "byte", "nibble"];
const VIEW_WIDTHS: Partial<Record<View, number>> = { byte: 8, nibble: 4 };

/** Nominal row width of `view` for a `width`-bit value. */
export function rowWidthFor(view: View, width: number): number {
  return Math.min(VIEW_WIDTHS[view] ?? width, width);
}

/** Re-maps rows of values (compare rows) from `oldRowWidth`-bit rows to
 *  `newRowWidth`-bit rows. Each old row is laid over the parent `value`; a
 *  new row gets an entry if any old row covered part of it (the rest of its
 *  bits come from the parent). */
export function remapRows(
  value: bigint,
  width: number,
  rows: Map<number, bigint>,
  oldRowWidth: number,
  newRowWidth: number,
): Map<number, bigint> {
  const valueMask = maxValue(width);
  let overlay = value;
  let covered = 0n;

  for (const [lo, rowValue] of rows) {
    const mask = (maxValue(oldRowWidth) << BigInt(lo)) & valueMask;
    overlay = (overlay & ~mask) | ((rowValue << BigInt(lo)) & mask);
    covered |= mask;
  }

  const out = new Map<number, bigint>();

  for (let lo = 0; lo < width; lo += newRowWidth) {
    const rowWidth = Math.min(newRowWidth, width - lo);
    if (covered & (maxValue(rowWidth) << BigInt(lo)))
      out.set(lo, (overlay >> BigInt(lo)) & maxValue(rowWidth));
  }

  return out;
}

/** Display bases for the new rows: each new row keeps the explicit base of
 *  the lowest old row it overlaps. */
export function remapRowBases(
  rowBases: Map<number, Base>,
  width: number,
  oldRowWidth: number,
  newRowWidth: number,
): Map<number, Base> {
  const bases = new Map<number, Base>();
  const oldRowStarts = [...rowBases.keys()].sort(
    (first, second) => first - second,
  );

  for (let lo = 0; lo < width; lo += newRowWidth) {
    for (const oldRowStart of oldRowStarts) {
      if (oldRowStart + oldRowWidth > lo && oldRowStart < lo + newRowWidth) {
        bases.set(lo, rowBases.get(oldRowStart)!);
        break;
      }
    }
  }

  return bases;
}
