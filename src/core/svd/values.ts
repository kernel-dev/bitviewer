// Numbers and arrays as SVD writes them: 0x / # / 0b numbers with k M G T
// suffixes, enumerated values with don't-care bits, and dim arrays.

import { childText, type XmlElement } from "./xml";

const MAX_DONT_CARE = 8; // enumerated values like #1xxx expand to at most 256 values

/** A number as SVD writes them: 0x1F, 0X1F, #11111 (binary) or 31. Optional
 *  k / M / G / T suffix (kilo… tera, ×1024). Returns null when not a number. */
export function parseSvdNumber(text: string | undefined): bigint | null {
  if (text === undefined) return null;
  const match = /^\+?(0x[0-9a-f]+|#[01]+|0b[01]+|\d+)([kmgt])?$/i.exec(
    text.trim(),
  );
  if (!match) return null;
  const digits = match[1];
  let value =
    digits[0] === "#"
      ? BigInt(`0b${digits.slice(1)}`)
      : /^0b/i.test(digits)
        ? BigInt(`0b${digits.slice(2)}`)
        : BigInt(digits.toLowerCase());

  if (match[2])
    value <<= BigInt(10 * ("kmgt".indexOf(match[2].toLowerCase()) + 1));

  return value;
}

/** Enumerated value text: a number, or binary with x don't-care bits ("#1x0",
 *  "0b1x0") which stands for every value it matches. */
export function enumValues(text: string): bigint[] | null {
  const binary = /^(?:#|0b)([01x]+)$/i.exec(text.trim());
  if (!binary || !/x/i.test(binary[1])) {
    const value = parseSvdNumber(text);
    return value === null ? null : [value];
  }

  const pattern = binary[1].toLowerCase();
  const free = [...pattern].filter((digit) => digit === "x").length;
  if (free > MAX_DONT_CARE) return null;
  const values: bigint[] = [];

  for (let combination = 0; combination < 1 << free; combination++) {
    let bit = free;
    const digits = [...pattern].map((digit) =>
      digit === "x" ? String((combination >> --bit) & 1) : digit,
    );
    values.push(BigInt(`0b${digits.join("")}`));
  }

  return values;
}

/** A dim array, described rather than expanded: copies are named on demand,
 *  so an array of any size costs the same to read. */
export interface Dim {
  /** Number of copies (1 when the element has no dim). */
  count: number;
  /** dimIncrement: bytes between copies (bits, for fields). */
  step: bigint;
  /** The text that replaces %s in copy `position` (0 … count-1). */
  index(position: number): string;
  /** Every index in short: "0-4095", "A-C" or "a,b,c". */
  range: string;
}

/** An element without dim: one copy, and %s stands for nothing. */
const SINGLE: Dim = { count: 1, step: 0n, index: () => "", range: "" };

/** Numbered copies: first, first + 1, … */
function numbered(count: number, first = 0n): Pick<Dim, "index" | "range"> {
  return {
    index: (position) => String(first + BigInt(position)),
    range:
      count === 1 ? String(first) : `${first}-${first + BigInt(count - 1)}`,
  };
}

/** dimIndex: "0-7", "A-D" or "a,b,c". Defaults to 0 … count-1. When it
 *  doesn't fit the dim, says so and falls back to numbers. */
function dimIndex(
  count: number,
  text: string | undefined,
  name: string,
  warnings: string[],
): Pick<Dim, "index" | "range"> {
  if (!text) return numbered(count);

  const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(text);
  if (range) {
    const first = BigInt(range[1]);
    if (BigInt(range[2]) - first + 1n !== BigInt(count))
      warnings.push(
        `${name}: dimIndex ${text.trim()} doesn't match dim ${count}; numbered from ${first}`,
      );
    return numbered(count, first);
  }

  const letters =
    /^\s*([A-Z])\s*-\s*([A-Z])\s*$/.exec(text) ??
    /^\s*([a-z])\s*-\s*([a-z])\s*$/.exec(text);
  if (letters) {
    const first = letters[1].charCodeAt(0);
    const last = first + count - 1;
    const end = (letters[1] <= "Z" ? "Z" : "z").charCodeAt(0);

    // past Z there are no more letters, so the copies are numbered instead
    if (last > end) {
      warnings.push(
        `${name}: dimIndex ${text.trim()} runs out of letters for dim ${count}; numbered 0-${count - 1}`,
      );
      return numbered(count);
    }

    if (last !== letters[2].charCodeAt(0))
      warnings.push(
        `${name}: dimIndex ${text.trim()} doesn't match dim ${count}; lettered from ${letters[1]}`,
      );

    return {
      index: (position) => String.fromCharCode(first + position),
      range:
        count === 1 ? letters[1] : `${letters[1]}-${String.fromCharCode(last)}`,
    };
  }

  const list = text.split(",").map((part) => part.trim());
  if (list.length !== count) {
    warnings.push(
      `${name}: dimIndex lists ${list.length} name${list.length === 1 ? "" : "s"} for dim ${count}; numbered 0-${count - 1}`,
    );
    return numbered(count);
  }

  return {
    index: (position) => list[position],
    range: count <= 4 ? list.join(",") : `${list[0]},…,${list[count - 1]}`,
  };
}

/** The element's dim array (SINGLE when it has none), or null when the dim
 *  is too large to count, which the warning explains. */
export function readDim(
  element: XmlElement,
  name: string,
  warnings: string[],
): Dim | null {
  const dim = parseSvdNumber(childText(element, "dim")) ?? 0n;
  if (!dim) return SINGLE;

  if (dim > BigInt(Number.MAX_SAFE_INTEGER)) {
    warnings.push(`${name}: dim ${dim} is too large to count; skipped`);
    return null;
  }

  const count = Number(dim);
  return {
    count,
    step: parseSvdNumber(childText(element, "dimIncrement")) ?? 0n,
    ...dimIndex(count, childText(element, "dimIndex"), name, warnings),
  };
}

/** The name of one copy: "[%s]" marks a C array (CCR[4]); as separate values
 *  it becomes CCR0 … CCR3. Without a dim, %s stands for nothing. */
export const copyName = (name: string, index: string) =>
  name.replace(/\[%s\]/g, index).replace(/%s/g, index);

/** The name of the whole array, with its indices: "CCR[0-3]". */
export function arrayName(name: string, dim: Dim): string {
  if (dim.count === 1) return copyName(name, dim.index(0));
  const indices = `[${dim.range}]`;
  return /%s/.test(name)
    ? name.replace(/\[%s\]|%s/g, indices)
    : `${name}${indices}`;
}
