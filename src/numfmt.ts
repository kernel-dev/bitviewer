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

export function isBase(b: unknown): b is Base {
  return b === 2 || b === 8 || b === 10 || b === 16;
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
export function parseValue(text: string, base: Base, width: number, allowNegative = false): bigint {
  let s = [...text].filter((ch) => !IGNORED.has(ch)).join("");
  if (!s) throw new ParseError("Enter a value", true);
  let negative = false;
  if (s[0] === "+" || s[0] === "-") {
    negative = s[0] === "-";
    s = s.slice(1);
    if (!s) throw new ParseError("Enter a value", true);
  }
  let low = s.toLowerCase();
  let b: Base = base;
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
  for (const [p, pb] of prefixes) {
    if (low.startsWith(p)) {
      b = pb;
      low = low.slice(2);
      break;
    }
  }
  if (!low) throw new ParseError(`Enter ${BASE_NAMES[b]} digits after the prefix`, true);
  const allowed = DIGITS.slice(0, b);
  let v = 0n;
  const bb = BigInt(b);
  for (const ch of low) {
    const d = allowed.indexOf(ch);
    if (d < 0) throw new ParseError(`'${ch}' is not a valid ${BASE_NAMES[b]} digit`);
    v = v * bb + BigInt(d);
  }
  if (negative) {
    if (!allowNegative) throw new ParseError("Negative values are not allowed here");
    const limit = 1n << BigInt(width - 1);
    if (v > limit) throw new ParseError(`Below the signed ${width}-bit minimum (-${limit})`);
    return -v & maxValue(width);
  }
  if (v > maxValue(width)) {
    throw new ParseError(
      `Exceeds the ${width}-bit range (max ${formatInt(maxValue(width), b, width, { prefix: true })})`,
    );
  }
  return v;
}

function group(s: string, n = 4, sep = "_"): string {
  const head = s.length % n;
  const parts = head ? [s.slice(0, head)] : [];
  for (let i = head; i < s.length; i += n) parts.push(s.slice(i, i + n));
  return parts.join(sep);
}

/** Format `v`. HEX and BIN are zero-padded to `width` bits. */
export function formatInt(
  v: bigint,
  base: Base,
  width: number,
  opts: { prefix?: boolean; group?: boolean } = {},
): string {
  let s: string;
  if (base === 16)
    s = v
      .toString(16)
      .toUpperCase()
      .padStart(Math.ceil(width / 4), "0");
  else if (base === 2) s = v.toString(2).padStart(width, "0");
  else s = v.toString(base);
  if (opts.group && (base === 2 || base === 16) && s.length > 4) s = group(s);
  return opts.prefix ? PREFIXES[base] + s : s;
}

export function toSigned(v: bigint, width: number): bigint {
  return (v >> BigInt(width - 1)) & 1n ? v - (1n << BigInt(width)) : v;
}

export function asFloat(v: bigint, width: number): number {
  const dv = new DataView(new ArrayBuffer(8));
  if (width === 32) {
    dv.setUint32(0, Number(v & 0xffffffffn));
    return dv.getFloat32(0);
  }
  if (width === 64) {
    dv.setBigUint64(0, v & maxValue(64));
    return dv.getFloat64(0);
  }
  throw new Error("float interpretation needs a 32- or 64-bit value");
}

/** Shortest text that round-trips to the same float32 / float64. */
export function formatFloat(f: number, width: number): string {
  if (Number.isNaN(f)) return "NaN";
  if (!Number.isFinite(f)) return f > 0 ? "+Inf" : "-Inf";
  if (Object.is(f, -0)) return "-0.0";
  let s = String(f);
  if (width === 32) {
    for (let d = 1; d <= 9; d++) {
      const cand = Number(f.toPrecision(d));
      if (Math.fround(cand) === f) {
        s = String(cand);
        break;
      }
    }
  }
  if (!/[.eEn]/.test(s)) s += ".0";
  return s;
}

export function popcount(v: bigint): number {
  let n = 0;
  for (let x = v; x > 0n; x >>= 1n) n += Number(x & 1n);
  return n;
}
