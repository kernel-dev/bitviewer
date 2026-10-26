// Numbers and arrays as SVD writes them: 0x / # / 0b numbers with k M G T
// suffixes, enumerated values with don't-care bits, and dim arrays.

import { childText, type XmlElement } from "./xml";

const MAX_DIM = 1024; // per array, so a typo can't ask for millions of registers
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

/** dimIndex as a list: "0-7", "A-D" or "a,b,c". Defaults to 0 … dim-1. */
function dimIndices(dim: number, indexText: string | undefined): string[] {
  if (indexText) {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(indexText);
    if (range) {
      const first = Number(range[1]);
      return Array.from({ length: dim }, (_, index) => String(first + index));
    }

    const letters = /^\s*([A-Z])\s*-\s*([A-Z])\s*$/.exec(indexText);
    if (letters) {
      const first = letters[1].charCodeAt(0);
      return Array.from({ length: dim }, (_, index) =>
        String.fromCharCode(first + index),
      );
    }

    const list = indexText.split(",").map((part) => part.trim());
    if (list.length === dim) return list;
  }

  return Array.from({ length: dim }, (_, index) => String(index));
}

/** One element, or its copies when it is a dim array: [name, offset step index]. */
export function expandDim(
  element: XmlElement,
  name: string,
  warnings: string[],
): { name: string; index: number }[] {
  const dim = Number(parseSvdNumber(childText(element, "dim")) ?? 0n);
  if (!dim) return [{ name: name.replace(/\[%s\]|%s/g, ""), index: 0 }];

  if (dim > MAX_DIM) {
    warnings.push(
      `${name}: dim ${dim} is more than ${MAX_DIM}; only the first ${MAX_DIM} are read`,
    );
  }

  const count = Math.min(dim, MAX_DIM);
  const indices = dimIndices(count, childText(element, "dimIndex"));
  return indices.map((index, position) => ({
    // "[%s]" marks a C array (CCR[4]); as separate values it becomes CCR0 … CCR3
    name: name.replace(/\[%s\]/g, index).replace(/%s/g, index),
    index: position,
  }));
}
