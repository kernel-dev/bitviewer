// Extra interpretations of a value: IEEE-754 floats (half, bfloat16, single,
// double), byte sequences in either byte order, and assorted readouts
// (BCD, Gray code, one's complement, bit counts, text).
import { formatInt, maxValue, ParseError } from "./numfmt";

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

const dv = new DataView(new ArrayBuffer(8));

function f32FromBits(bits: number): number {
  dv.setUint32(0, bits >>> 0);
  return dv.getFloat32(0);
}

function f32Bits(f: number): number {
  dv.setFloat32(0, f);
  return dv.getUint32(0);
}

/** Round half to even, for x ≥ 0. */
function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** floor(log2(a)) for a > 0, exact even where Math.log2 rounds. */
function exponentOf(a: number): number {
  let e = Math.floor(Math.log2(a));
  if (2 ** e > a) e--;
  if (2 ** (e + 1) <= a) e++;
  return e;
}

function halfToNumber(b: number): number {
  const sign = b & 0x8000 ? -1 : 1;
  const exp = (b >> 10) & 0x1f;
  const frac = b & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

function numberToHalf(f: number): number {
  if (Number.isNaN(f)) return 0x7e00;
  const sign = f < 0 || Object.is(f, -0) ? 0x8000 : 0;
  const a = Math.abs(f);
  if (a >= 65520) return sign | 0x7c00; // past the largest half (65504) after rounding
  if (a === 0) return sign;
  let e = exponentOf(a);
  // subnormal: count units of 2^-24 (a result of 1024 is exactly the smallest normal)
  if (e < -14) return sign | roundEven(a / 2 ** -24);
  let m = roundEven((a / 2 ** e - 1) * 1024);
  if (m === 1024) {
    m = 0;
    e++;
  }
  if (e > 15) return sign | 0x7c00;
  return sign | ((e + 15) << 10) | m;
}

/** The number stored in the low bits of `v` as this float kind. */
export function decodeFloat(v: bigint, kind: FloatKind): number {
  switch (kind) {
    case "f64":
      dv.setBigUint64(0, v & maxValue(64));
      return dv.getFloat64(0);
    case "f32":
      return f32FromBits(Number(v & 0xffffffffn));
    case "bf16":
      return f32FromBits(Number(v & 0xffffn) << 16);
    case "f16":
      return halfToNumber(Number(v & 0xffffn));
  }
}

/** Bits of `f` as this float kind (rounded to nearest, ties to even). */
export function encodeFloat(f: number, kind: FloatKind): bigint {
  switch (kind) {
    case "f64":
      dv.setFloat64(0, f);
      return dv.getBigUint64(0);
    case "f32":
      return BigInt(f32Bits(f));
    case "bf16": {
      if (Number.isNaN(f)) return 0x7fc0n;
      const u = f32Bits(f);
      return BigInt(((u + 0x7fff + ((u >>> 16) & 1)) >>> 16) & 0xffff);
    }
    case "f16":
      return BigInt(numberToHalf(f));
  }
}

/** Shortest text that reads back as the same float of this kind. */
export function formatFloatKind(f: number, kind: FloatKind): string {
  if (Number.isNaN(f)) return "NaN";
  if (!Number.isFinite(f)) return f > 0 ? "+Inf" : "-Inf";
  if (Object.is(f, -0)) return "-0.0";
  let s = String(f);
  if (kind !== "f64") {
    const bits = encodeFloat(f, kind);
    for (let d = 1; d <= 9; d++) {
      const cand = Number(f.toPrecision(d));
      if (encodeFloat(cand, kind) === bits) {
        s = String(cand);
        break;
      }
    }
  }
  if (!/[.eEn]/.test(s)) s += ".0";
  return s;
}

/** "−1.5 × 2^3" style breakdown of a float. */
export function floatBreakdown(f: number): string {
  if (Number.isNaN(f)) return "not a number";
  if (!Number.isFinite(f)) return f > 0 ? "positive infinity" : "negative infinity";
  if (f === 0) return Object.is(f, -0) ? "negative zero" : "zero";
  const a = Math.abs(f);
  const e = exponentOf(a);
  return `${f < 0 ? "−" : "+"}${Number((a / 2 ** e).toPrecision(12))} × 2^${e}`;
}

/** Parses "1.5", "-0.1", "1e-3", "inf", "-inf" or "nan". */
export function parseFloatText(text: string): number {
  const t = text.trim().toLowerCase().replace(/_/g, "");
  if (!t) throw new ParseError("Enter a number", true);
  if (/^[+-]?(inf|infinity)$/.test(t)) {
    return t.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (t === "nan") return Number.NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(t)) throw new ParseError(`"${text.trim()}" is not a number`);
  return Number(t);
}

// ------------------------------------------------------------------ bytes
export type ByteOrder = "be" | "le";
export type ByteStyle = "c" | "py" | "hex";

/** The value as ceil(width / 8) bytes; "be" puts the most significant first. */
export function valueToBytes(v: bigint, width: number, order: ByteOrder): number[] {
  const n = Math.ceil(width / 8);
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(Number((v >> BigInt(i * 8)) & 0xffn));
  return order === "be" ? out : out.reverse();
}

/** Accepts "DE AD BE EF", "0xde, 0xad", "{0xDE, 0xAD}", "deadbeef", "bytes([…])", "b'\xde\xad'". */
export function parseBytes(text: string): number[] {
  let t = text.trim();
  if (!t) throw new ParseError("Paste some bytes", true);
  const py = /^b(['"])(.*)\1$/s.exec(t);
  if (py) {
    const out: number[] = [];
    const body = py[2];
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "\\" && body[i + 1] === "x") {
        const b = Number.parseInt(body.slice(i + 2, i + 4), 16);
        if (Number.isNaN(b)) throw new ParseError("Bad \\x escape in the bytes literal");
        out.push(b);
        i += 3;
      } else out.push(body.charCodeAt(i) & 0xff);
    }
    return out;
  }
  t = t.replace(/^(bytes|bytearray)\(/i, "").replace(/[{}[\]();]/g, " ");
  let tokens = t.split(/[\s,]+/).filter(Boolean);
  // one long run of hex digits: split it into pairs
  if (tokens.length === 1) {
    const one = tokens[0].replace(/^0x/i, "");
    if (/^[0-9a-f]+$/i.test(one) && one.length > 2) {
      tokens = (one.length % 2 ? `0${one}` : one).match(/../g) ?? [];
    }
  }
  return tokens.map((tok) => {
    const hex = tok.replace(/^0x/i, "");
    if (!/^[0-9a-f]{1,2}$/i.test(hex)) throw new ParseError(`"${tok}" is not a byte (use 00–FF)`);
    return Number.parseInt(hex, 16);
  });
}

/** Builds a `width`-bit value from bytes; fewer bytes than fit are zero-extended. */
export function bytesToValue(bytes: number[], width: number, order: ByteOrder): bigint {
  const n = Math.ceil(width / 8);
  if (bytes.length > n) throw new ParseError(`${bytes.length} bytes don't fit in ${width} bits (max ${n})`);
  const msbFirst = order === "be" ? bytes : [...bytes].reverse();
  let v = 0n;
  for (const b of msbFirst) v = (v << 8n) | BigInt(b);
  if (v > maxValue(width)) throw new ParseError(`The bytes don't fit in ${width} bits`);
  return v;
}

export function formatBytes(bytes: number[], style: ByteStyle): string {
  const hx = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");
  if (style === "hex") return bytes.map(hx).join(" ");
  if (style === "c") return `{ ${bytes.map((b) => `0x${hx(b)}`).join(", ")} }`;
  return `b'${bytes.map((b) => `\\x${hx(b).toLowerCase()}`).join("")}'`;
}

// ------------------------------------------------------------------ extra readouts
export function bitLength(v: bigint): number {
  return v === 0n ? 0 : v.toString(2).length;
}

/** Leading zeros within `width` bits. */
export function clz(v: bigint, width: number): number {
  return width - bitLength(v);
}

/** Trailing zeros (`width` when the value is 0). */
export function ctz(v: bigint, width: number): number {
  if (v === 0n) return width;
  let n = 0;
  for (let x = v; !(x & 1n); x >>= 1n) n++;
  return n;
}

/** Decimal digits if every nibble is 0–9 (binary-coded decimal), else null. */
export function bcdDecode(v: bigint, width: number): string | null {
  const digits = formatInt(v, 16, width);
  if (!/^[0-9]*$/.test(digits)) return null;
  return digits.replace(/^0+(?=.)/, "");
}

/** Binary value of a Gray-coded number. */
export function grayToBinary(g: bigint): bigint {
  let b = g;
  for (let s = g >> 1n; s; s >>= 1n) b ^= s;
  return b;
}

/** One's-complement signed interpretation. */
export function onesComplement(v: bigint, width: number): bigint {
  return (v >> BigInt(width - 1)) & 1n ? -(~v & maxValue(width)) : v;
}

/** The bytes (most significant first, leading zero bytes dropped) as text:
 *  UTF-8 when valid and printable, else ASCII with · for other bytes. */
export function bytesAsText(v: bigint, width: number): string {
  const bytes = valueToBytes(v, width, "be");
  const first = bytes.findIndex((b) => b !== 0);
  const used = first < 0 ? [] : bytes.slice(first);
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(used));
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
    if (!/[\u0000-\u001f\u007f]/.test(s)) return s;
  } catch {
    /* not UTF-8 */
  }
  return used.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·")).join("");
}
