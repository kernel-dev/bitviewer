// Extra interpretations of a value: IEEE-754 floats (half, bfloat16, single,
// double), byte sequences in either byte order, and assorted readouts
// (BCD, Gray code, one's complement, bit counts, text).
import { formatInt, maxValue, ParseError } from "./integers";

// ------------------------------------------------------------------ floats
export type FloatKind = "f16" | "bf16" | "f32" | "f64";
export const FLOAT_NAMES: Record<FloatKind, string> = {
  f16: "float16",
  bf16: "bfloat16",
  f32: "float32",
  f64: "float64",
};

/** Float views that make sense for a value of this width. */
export function floatKinds(width: number): FloatKind[] {
  if (width === 16) return ["f16", "bf16"];
  if (width === 32) return ["f32"];
  if (width === 64) return ["f64"];
  return [];
}

const dataView = new DataView(new ArrayBuffer(8));

function f32FromBits(bits: number): number {
  dataView.setUint32(0, bits >>> 0);
  return dataView.getFloat32(0);
}

function f32Bits(value: number): number {
  dataView.setFloat32(0, value);
  return dataView.getUint32(0);
}

/** Round half to even, for x ≥ 0. */
function roundEven(value: number): number {
  const rounded = Math.round(value);
  return Math.abs(value % 1) === 0.5 && rounded % 2 !== 0
    ? rounded - 1
    : rounded;
}

/** floor(log2(a)) for a > 0, exact even where Math.log2 rounds. */
function exponentOf(absolute: number): number {
  let exponent = Math.floor(Math.log2(absolute));
  if (2 ** exponent > absolute) exponent--;
  if (2 ** (exponent + 1) <= absolute) exponent++;
  return exponent;
}

function halfToNumber(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponentBits = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponentBits === 0) return sign * fraction * 2 ** -24;
  if (exponentBits === 31)
    return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + fraction / 1024) * 2 ** (exponentBits - 15);
}

function numberToHalf(value: number): number {
  if (Number.isNaN(value)) return 0x7e00;
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
  const absolute = Math.abs(value);
  if (absolute >= 65520) return sign | 0x7c00; // past the largest half (65504) after rounding
  if (absolute === 0) return sign;
  let exponent = exponentOf(absolute);
  // subnormal: count units of 2^-24 (a result of 1024 is exactly the smallest normal)
  if (exponent < -14) return sign | roundEven(absolute / 2 ** -24);
  let mantissa = roundEven((absolute / 2 ** exponent - 1) * 1024);
  if (mantissa === 1024) {
    mantissa = 0;
    exponent++;
  }
  if (exponent > 15) return sign | 0x7c00;
  return sign | ((exponent + 15) << 10) | mantissa;
}

/** The number stored in the low bits of `v` as this float kind. */
export function decodeFloat(value: bigint, kind: FloatKind): number {
  switch (kind) {
    case "f64":
      dataView.setBigUint64(0, value & maxValue(64));
      return dataView.getFloat64(0);
    case "f32":
      return f32FromBits(Number(value & 0xffffffffn));
    case "bf16":
      return f32FromBits(Number(value & 0xffffn) << 16);
    case "f16":
      return halfToNumber(Number(value & 0xffffn));
  }
}

/** Bits of `value` as this float kind (rounded to nearest, ties to even). */
export function encodeFloat(value: number, kind: FloatKind): bigint {
  switch (kind) {
    case "f64":
      dataView.setFloat64(0, value);
      return dataView.getBigUint64(0);
    case "f32":
      return BigInt(f32Bits(value));
    case "bf16": {
      if (Number.isNaN(value)) return 0x7fc0n;
      const bits = f32Bits(value);
      return BigInt(((bits + 0x7fff + ((bits >>> 16) & 1)) >>> 16) & 0xffff);
    }
    case "f16":
      return BigInt(numberToHalf(value));
  }
}

/** Shortest text that reads back as the same float of this kind. */
export function formatFloatKind(value: number, kind: FloatKind): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  if (Object.is(value, -0)) return "-0.0";
  let formatted = String(value);
  if (kind !== "f64") {
    const bits = encodeFloat(value, kind);
    for (let digits = 1; digits <= 9; digits++) {
      const cand = Number(value.toPrecision(digits));
      if (encodeFloat(cand, kind) === bits) {
        formatted = String(cand);
        break;
      }
    }
  }
  if (!/[.eEn]/.test(formatted)) formatted += ".0";
  return formatted;
}

/** "−1.5 × 2^3" style breakdown of a float. */
export function floatBreakdown(value: number): string {
  if (Number.isNaN(value)) return "not a number";
  if (!Number.isFinite(value))
    return value > 0 ? "positive infinity" : "negative infinity";
  if (value === 0) return Object.is(value, -0) ? "negative zero" : "zero";
  const absolute = Math.abs(value);
  const exponent = exponentOf(absolute);
  return `${value < 0 ? "−" : "+"}${Number((absolute / 2 ** exponent).toPrecision(12))} × 2^${exponent}`;
}

/** Parses "1.5", "-0.1", "1e-3", "inf", "-inf" or "nan". */
export function parseFloatText(text: string): number {
  const cleaned = text.trim().toLowerCase().replace(/_/g, "");
  if (!cleaned) throw new ParseError("Enter a number", true);
  if (/^[+-]?(inf|infinity)$/.test(cleaned)) {
    return cleaned.startsWith("-")
      ? Number.NEGATIVE_INFINITY
      : Number.POSITIVE_INFINITY;
  }
  if (cleaned === "nan") return Number.NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(cleaned))
    throw new ParseError(`"${text.trim()}" is not a number`);
  return Number(cleaned);
}

// ------------------------------------------------------------------ bytes
export type ByteOrder = "be" | "le";
export type ByteStyle = "c" | "py" | "hex";

/** The value as ceil(width / 8) bytes; "be" puts the most significant first. */
export function valueToBytes(
  value: bigint,
  width: number,
  order: ByteOrder,
): number[] {
  const byteCount = Math.ceil(width / 8);
  const out: number[] = [];
  for (let i = byteCount - 1; i >= 0; i--)
    out.push(Number((value >> BigInt(i * 8)) & 0xffn));
  return order === "be" ? out : out.reverse();
}

const PYTHON_ESCAPES: Record<string, number> = {
  "\\": 0x5c,
  "'": 0x27,
  '"': 0x22,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

/** The body of a Python bytes literal (between the quotes) as bytes. */
function parsePythonBytes(body: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const character = body[i];
    if (character !== "\\") {
      const code = character.charCodeAt(0);
      if (code > 0x7f)
        throw new ParseError(
          `"${character}" isn't ASCII; write it as \\x escapes`,
        );
      out.push(code);
      continue;
    }
    const escaped = body[i + 1] ?? "";
    if (escaped === "x") {
      const hex = body.slice(i + 2, i + 4);
      if (!/^[0-9a-f]{2}$/i.test(hex))
        throw new ParseError("Bad \\x escape in the bytes literal");
      out.push(Number.parseInt(hex, 16));
      i += 3;
    } else if (/[0-7]/.test(escaped)) {
      const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0];
      const byte = Number.parseInt(octal, 8);
      if (byte > 0xff) throw new ParseError(`\\${octal} is more than a byte`);
      out.push(byte);
      i += octal.length;
    } else if (Object.hasOwn(PYTHON_ESCAPES, escaped)) {
      out.push(PYTHON_ESCAPES[escaped]);
      i += 1;
    } else {
      out.push(0x5c); // Python keeps unknown escapes as a backslash and the character
    }
  }
  return out;
}

/** Accepts "DE AD BE EF", "0xde, 0xad", "{0xDE, 0xAD}", "deadbeef", "bytes([…])", "b'\xde\xad'". */
export function parseBytes(text: string): number[] {
  let cleaned = text.trim();
  if (!cleaned) throw new ParseError("Paste some bytes", true);
  const pythonMatch = /^b(['"])(.*)\1$/s.exec(cleaned);
  if (pythonMatch) return parsePythonBytes(pythonMatch[2]);
  cleaned = cleaned
    .replace(/^(bytes|bytearray)\(/i, "")
    .replace(/[{}[\]();]/g, " ");
  let tokens = cleaned.split(/[\s,]+/).filter(Boolean);
  // one long run of hex digits: split it into pairs
  if (tokens.length === 1) {
    const one = tokens[0].replace(/^0x/i, "");
    if (/^[0-9a-f]+$/i.test(one) && one.length > 2) {
      tokens = (one.length % 2 ? `0${one}` : one).match(/../g) ?? [];
    }
  }
  return tokens.map((token) => {
    const hex = token.replace(/^0x/i, "");
    if (!/^[0-9a-f]{1,2}$/i.test(hex))
      throw new ParseError(`"${token}" is not a byte (use 00–FF)`);
    return Number.parseInt(hex, 16);
  });
}

/** Builds a `width`-bit value from bytes; fewer bytes than fit are zero-extended. */
export function bytesToValue(
  bytes: number[],
  width: number,
  order: ByteOrder,
): bigint {
  const byteCount = Math.ceil(width / 8);
  if (bytes.length > byteCount)
    throw new ParseError(
      `${bytes.length} bytes don't fit in ${width} bits (max ${byteCount})`,
    );
  const msbFirst = order === "be" ? bytes : [...bytes].reverse();
  let value = 0n;
  for (const byte of msbFirst) value = (value << 8n) | BigInt(byte);
  if (value > maxValue(width))
    throw new ParseError(`The bytes don't fit in ${width} bits`);
  return value;
}

export function formatBytes(bytes: number[], style: ByteStyle): string {
  const toHexByte = (byte: number) =>
    byte.toString(16).toUpperCase().padStart(2, "0");
  if (style === "hex") return bytes.map(toHexByte).join(" ");
  if (style === "c")
    return `{ ${bytes.map((byte) => `0x${toHexByte(byte)}`).join(", ")} }`;
  return `b'${bytes.map((byte) => `\\x${toHexByte(byte).toLowerCase()}`).join("")}'`;
}

// ------------------------------------------------------------------ extra readouts
export function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

/** Leading zeros within `width` bits. */
export function countLeadingZeros(value: bigint, width: number): number {
  return width - bitLength(value);
}

/** Trailing zeros (`width` when the value is 0). */
export function countTrailingZeros(value: bigint, width: number): number {
  if (value === 0n) return width;
  let count = 0;
  for (let remaining = value; !(remaining & 1n); remaining >>= 1n) count++;
  return count;
}

/** Decimal digits if every nibble is 0–9 (binary-coded decimal), else null. */
export function bcdDecode(value: bigint, width: number): string | null {
  const digits = formatInt(value, 16, width);
  if (!/^[0-9]*$/.test(digits)) return null;
  return digits.replace(/^0+(?=.)/, "");
}

/** Binary value of a Gray-coded number. */
export function grayToBinary(gray: bigint): bigint {
  let binary = gray;
  for (let shifted = gray >> 1n; shifted; shifted >>= 1n) binary ^= shifted;
  return binary;
}

/** One's-complement signed interpretation. */
export function onesComplement(value: bigint, width: number): bigint {
  return (value >> BigInt(width - 1)) & 1n
    ? -(~value & maxValue(width))
    : value;
}

/** The bytes (most significant first, leading zero bytes dropped) as text:
 *  UTF-8 when valid and printable, else ASCII with · for other bytes. */
export function bytesAsText(value: bigint, width: number): string {
  const bytes = valueToBytes(value, width, "be");
  const first = bytes.findIndex((byte) => byte !== 0);
  const used = first < 0 ? [] : bytes.slice(first);
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(used),
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
    if (!/[\u0000-\u001f\u007f]/.test(decoded)) return decoded;
  } catch {
    /* not UTF-8 */
  }
  return used
    .map((byte) =>
      byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "·",
    )
    .join("");
}
