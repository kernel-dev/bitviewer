// Parsing and formatting of integers in binary / octal / decimal / hexadecimal.
// Values are BigInt so 64-bit numbers stay exact.

export type Base = 2 | 8 | 10 | 16;
export const BASE_ORDER: readonly Base[] = [2, 8, 10, 16];
export const BASE_NAMES: Record<Base, string> = {
  2: "BIN",
  8: "OCT",
  10: "DEC",
  16: "HEX",
};
export const PREFIXES: Record<Base, string> = {
  2: "0b",
  8: "0o",
  10: "",
  16: "0x",
};
const DIGITS = "0123456789abcdef";
const IGNORED = new Set([" ", "_", "'", "\t"]);

export function isBase(value: unknown): value is Base {
  return value === 2 || value === 8 || value === 10 || value === 16;
}

/** Thrown when text cannot become a value. `incomplete` marks input the user is
 *  probably still typing (empty, or just a prefix), so the UI can stay neutral. */
export class ParseError extends Error {
  constructor(
    message: string,
    public incomplete = false,
  ) {
    super(message);
  }
}

export function maxValue(width: number): bigint {
  return (1n << BigInt(width)) - 1n;
}

/**
 * Parse `text` in `base` into an unsigned `width`-bit value.
 * - Spaces, underscores and apostrophes are ignored as digit separators.
 * - Prefixes 0x / 0b / 0o override the base. In HEX mode 0b is *not* a
 *   prefix, because 0B is a valid hex number.
 * - With `allowNegative` a leading "-" stores the two's-complement value.
 */
export function parseValue(
  text: string,
  base: Base,
  width: number,
  allowNegative = false,
): bigint {
  let cleaned = [...text]
    .filter((character) => !IGNORED.has(character))
    .join("");
  if (!cleaned) throw new ParseError("Enter a value", true);
  let negative = false;
  if (cleaned[0] === "+" || cleaned[0] === "-") {
    negative = cleaned[0] === "-";
    cleaned = cleaned.slice(1);
    if (!cleaned) throw new ParseError("Enter a value", true);
  }
  let lowercased = cleaned.toLowerCase();
  let activeBase: Base = base;
  const prefixes: [string, Base][] =
    base === 16
      ? [
          ["0x", 16],
          ["0o", 8],
        ]
      : [
          ["0x", 16],
          ["0b", 2],
          ["0o", 8],
        ];
  for (const [prefixText, prefixBase] of prefixes) {
    if (lowercased.startsWith(prefixText)) {
      activeBase = prefixBase;
      lowercased = lowercased.slice(2);
      break;
    }
  }
  if (!lowercased)
    throw new ParseError(
      `Enter ${BASE_NAMES[activeBase]} digits after the prefix`,
      true,
    );
  const allowed = DIGITS.slice(0, activeBase);
  let value = 0n;
  const baseBig = BigInt(activeBase);
  for (const character of lowercased) {
    const digit = allowed.indexOf(character);
    if (digit < 0)
      throw new ParseError(
        `'${character}' is not a valid ${BASE_NAMES[activeBase]} digit`,
      );
    value = value * baseBig + BigInt(digit);
  }
  if (negative) {
    if (!allowNegative)
      throw new ParseError("Negative values are not allowed here");
    const limit = 1n << BigInt(width - 1);
    if (value > limit)
      throw new ParseError(`Below the signed ${width}-bit minimum (-${limit})`);
    return -value & maxValue(width);
  }
  if (value > maxValue(width)) {
    throw new ParseError(
      `Exceeds the ${width}-bit range (max ${formatInt(maxValue(width), activeBase, width, { prefix: true })})`,
    );
  }
  return value;
}

function group(text: string, size = 4, sep = "_"): string {
  const head = text.length % size;
  const parts = head ? [text.slice(0, head)] : [];
  for (let i = head; i < text.length; i += size)
    parts.push(text.slice(i, i + size));
  return parts.join(sep);
}

/** Format `v`. HEX and BIN are zero-padded to `width` bits. */
export function formatInt(
  value: bigint,
  base: Base,
  width: number,
  options: { prefix?: boolean; group?: boolean } = {},
): string {
  let formatted: string;
  if (base === 16)
    formatted = value
      .toString(16)
      .toUpperCase()
      .padStart(Math.ceil(width / 4), "0");
  else if (base === 2) formatted = value.toString(2).padStart(width, "0");
  else formatted = value.toString(base);
  if (options.group && (base === 2 || base === 16) && formatted.length > 4)
    formatted = group(formatted);
  return options.prefix ? PREFIXES[base] + formatted : formatted;
}

export function toSigned(value: bigint, width: number): bigint {
  return (value >> BigInt(width - 1)) & 1n
    ? value - (1n << BigInt(width))
    : value;
}

export function popcount(value: bigint): number {
  let count = 0;
  for (let remaining = value; remaining > 0n; remaining >>= 1n)
    count += Number(remaining & 1n);
  return count;
}
