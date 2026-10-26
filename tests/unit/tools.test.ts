import { describe, expect, it } from "vitest";
import {
  ExprError,
  evalInt,
  evalReal,
  linearity,
  parseExpr,
} from "../../src/core/expr";
import {
  bcdDecode,
  bytesAsText,
  bytesToValue,
  countLeadingZeros,
  countTrailingZeros,
  decodeFloat,
  encodeFloat,
  floatBreakdown,
  formatBytes,
  formatFloatKind,
  grayToBinary,
  onesComplement,
  parseBytes,
  parseFloatText,
  valueToBytes,
} from "../../src/core/formats";
import { applyOp, ModelError, ValueModel } from "../../src/core/model";

describe("operations", () => {
  it("rotates, shifts and swaps", () => {
    expect(applyOp("rol", 0x81n, 8)).toBe(0x03n);
    expect(applyOp("ror", 0x81n, 8)).toBe(0xc0n);
    expect(applyOp("rol", 0x12345678n, 32, 8n)).toBe(0x34567812n);
    expect(applyOp("ror", 0x1n, 8, 9n)).toBe(0x80n); // amount wraps
    expect(applyOp("shl", 0xffn, 8, 4n)).toBe(0xf0n);
    expect(applyOp("shl", 0xffn, 8, 9n)).toBe(0n);
    expect(applyOp("shr", 0xf0n, 8, 4n)).toBe(0x0fn);
    expect(applyOp("asr", 0x80n, 8, 3n)).toBe(0xf0n); // sign bit copied in
    expect(applyOp("asr", 0x40n, 8, 3n)).toBe(0x08n);
    expect(applyOp("asr", 0x80n, 8, 99n)).toBe(0xffn);
    expect(applyOp("bswap", 0x12345678n, 32)).toBe(0x78563412n);
    expect(applyOp("bswap", 0x1122334455667788n, 64)).toBe(0x8877665544332211n);
    expect(() => applyOp("bswap", 0x123n, 12)).toThrow(ModelError);
    expect(applyOp("brev", 0b0001n, 4)).toBe(0b1000n);
    expect(applyOp("brev", 0x1n, 32)).toBe(0x80000000n);
  });

  it("does arithmetic with wrap-around", () => {
    expect(applyOp("neg", 1n, 8)).toBe(0xffn);
    expect(applyOp("inc", 0xffn, 8)).toBe(0n);
    expect(applyOp("dec", 0n, 8)).toBe(0xffn);
    expect(applyOp("and", 0xf0f0n, 16, 0xff00n)).toBe(0xf000n);
    expect(applyOp("or", 0x00f0n, 16, 0x0f00n)).toBe(0x0ff0n);
    expect(applyOp("xor", 0xffffn, 16, 0x00ffn)).toBe(0xff00n);
    expect(applyOp("or", 0n, 8, 0x1ffn)).toBe(0xffn); // operand masked to the width
  });

  it("applies to a bit range", () => {
    const model = new ValueModel({ width: 32, value: 0x12345678n });
    model.opBits(8, 15, "invert");
    expect(model.value).toBe(0x1234a978n);
    model.opBits(0, 7, "rol", 4n);
    expect(model.value).toBe(0x1234a987n);
  });
});

describe("expressions", () => {
  const variables: Record<string, bigint> = {
    x: 10n,
    CTRL: 0xf0n,
    "Value 1": 3n,
  };
  const evaluateInteger = (text: string) =>
    evalInt(parseExpr(text), (name) => variables[name]);

  it("follows C-like precedence", () => {
    expect(evaluateInteger("1 + 2 * 3")).toBe(7n);
    expect(evaluateInteger("(1 + 2) * 3")).toBe(9n);
    expect(evaluateInteger("1 << 4 | 1")).toBe(17n);
    expect(evaluateInteger("0x1F << 3 | (1 << 31)")).toBe(0x800000f8n);
    expect(evaluateInteger("2 ** 3 ** 2")).toBe(512n);
    expect(evaluateInteger("-2 ** 2")).toBe(-4n);
    expect(evaluateInteger("~0 & 0xff")).toBe(0xffn);
    expect(evaluateInteger("7 / 2")).toBe(3n);
    expect(evaluateInteger("-7 / 2")).toBe(-3n);
    expect(evaluateInteger("!0 + !5")).toBe(1n);
    expect(evaluateInteger("1_000 + 0b1010 + 0o17")).toBe(1025n);
  });

  it("resolves names and functions", () => {
    expect(evaluateInteger("x + 1")).toBe(11n);
    expect(evaluateInteger("CTRL >> 4")).toBe(0xfn);
    expect(evaluateInteger("{Value 1} * 2")).toBe(6n);
    expect(evaluateInteger("`Value 1` + bit(4)")).toBe(19n);
    expect(evaluateInteger("mask(8) ^ CTRL")).toBe(0x0fn);
    expect(evaluateInteger("min(5, x, 7) + max(1, 2)")).toBe(7n);
    expect(evaluateInteger("popcount(0xff)")).toBe(8n);
    expect(evaluateInteger("2 ** 511")).toBe(1n << 511n);
  });

  it("reports errors clearly", () => {
    expect(() => evaluateInteger("1 +")).toThrow(/ends too early/);
    expect(() => evaluateInteger("(1 + 2")).toThrow(/Missing "\)"/);
    expect(() => evaluateInteger("y + 1")).toThrow(/Unknown name "y"/);
    expect(() => evaluateInteger("1 / 0")).toThrow(/Division by zero/);
    expect(() => evaluateInteger("1.5 + 1")).toThrow(/not a whole number/);
    expect(() => evaluateInteger("2 ** 100000")).toThrow(/too large/);
    expect(() => evaluateInteger("1 $ 2")).toThrow(ExprError);
    expect(() => evaluateInteger("foo(1)")).toThrow(/Unknown function/);
  });

  it("evaluates real formulas and detects linear ones", () => {
    const compile = (source: string) => {
      const expression = parseExpr(source);
      return (x: number) =>
        evalReal(expression, (name) => (name === "x" ? x : undefined));
    };
    expect(compile("x * 0.5 - 40")(100)).toBe(10);
    expect(compile("sqrt(x)")(16)).toBe(4);
    expect(compile("pi * 2")(0)).toBeCloseTo(6.283185, 5);
    expect(linearity(compile("x * 0.5 - 40"), [2, 7, 1000])).toEqual([
      0.5, -40,
    ]);
    expect(linearity(compile("x / 4 + 1.25"), [2, 7, 1000])).toEqual([
      0.25, 1.25,
    ]);
    expect(linearity(compile("x * x"), [2, 7, 1000])).toBeNull();
    expect(linearity(compile("sqrt(x)"), [2, 7, 1000])).toBeNull();
  });
});

describe("floats", () => {
  it("decodes and encodes half precision exactly", () => {
    const cases: [number, number][] = [
      [0x3c00, 1],
      [0xc000, -2],
      [0x7bff, 65504],
      [0x0001, 2 ** -24],
      [0x0400, 2 ** -14],
      [0x3555, 0.333251953125],
    ];
    for (const [bits, floatValue] of cases) {
      expect(decodeFloat(BigInt(bits), "f16")).toBe(floatValue);
      expect(encodeFloat(floatValue, "f16")).toBe(BigInt(bits));
    }
    expect(encodeFloat(1 / 3, "f16")).toBe(0x3555n);
    expect(encodeFloat(65520, "f16")).toBe(0x7c00n); // rounds to infinity
    expect(encodeFloat(1 + 2 ** -11, "f16")).toBe(0x3c00n); // tie → even
    expect(encodeFloat(1 + 3 * 2 ** -11, "f16")).toBe(0x3c02n); // tie → even (up)
    expect(Number.isNaN(decodeFloat(0x7e00n, "f16"))).toBe(true);
    expect(decodeFloat(0xfc00n, "f16")).toBe(Number.NEGATIVE_INFINITY);
    expect(Object.is(decodeFloat(0x8000n, "f16"), -0)).toBe(true);
  });

  it("handles bfloat16, float32 and float64", () => {
    expect(decodeFloat(0x3f80n, "bf16")).toBe(1);
    expect(encodeFloat(1, "bf16")).toBe(0x3f80n);
    expect(encodeFloat(3.140625, "bf16")).toBe(0x4049n);
    expect(encodeFloat(1.5, "f32")).toBe(0x3fc00000n);
    expect(encodeFloat(0.1, "f64")).toBe(0x3fb999999999999an);
    expect(formatFloatKind(decodeFloat(0x3555n, "f16"), "f16")).toBe("0.3333");
    expect(formatFloatKind(decodeFloat(0x3dcccccdn, "f32"), "f32")).toBe("0.1");
    expect(formatFloatKind(decodeFloat(0x3c00n, "f16"), "f16")).toBe("1.0");
  });

  it("parses and explains floats", () => {
    expect(parseFloatText(" -1.5e3 ")).toBe(-1500);
    expect(parseFloatText(".5")).toBe(0.5);
    expect(parseFloatText("-inf")).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(parseFloatText("NaN"))).toBe(true);
    expect(() => parseFloatText("1.2.3")).toThrow();
    expect(floatBreakdown(1.5)).toBe("+1.5 × 2^0");
    expect(floatBreakdown(-12)).toBe("−1.5 × 2^3");
    expect(floatBreakdown(0)).toBe("zero");
  });
});

describe("bytes", () => {
  it("parses many notations", () => {
    expect(parseBytes("DE AD BE EF")).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(parseBytes("{0xDE, 0xAD}")).toEqual([0xde, 0xad]);
    expect(parseBytes("deadbeef")).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(parseBytes("0xdeadbeef")).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(parseBytes("bytes([0x01, 0x02])")).toEqual([1, 2]);
    expect(parseBytes("b'\\xde\\xadA'")).toEqual([0xde, 0xad, 0x41]);
    expect(() => parseBytes("1FF")).not.toThrow(); // odd length: leading 0 added
    expect(() => parseBytes("GG")).toThrow();
  });

  it("converts in both byte orders", () => {
    expect(valueToBytes(0x12345678n, 32, "be")).toEqual([
      0x12, 0x34, 0x56, 0x78,
    ]);
    expect(valueToBytes(0x12345678n, 32, "le")).toEqual([
      0x78, 0x56, 0x34, 0x12,
    ]);
    expect(bytesToValue([0x78, 0x56, 0x34, 0x12], 32, "le")).toBe(0x12345678n);
    expect(bytesToValue([0xab], 32, "be")).toBe(0xabn); // zero-extended
    expect(() => bytesToValue([1, 2, 3], 16, "be")).toThrow();
    expect(() => bytesToValue([0xff, 0xff], 12, "be")).toThrow();
    expect(formatBytes([0xde, 0xad], "c")).toBe("{ 0xDE, 0xAD }");
    expect(formatBytes([0xde, 0xad], "py")).toBe("b'\\xde\\xad'");
    expect(formatBytes([0xde, 0xad], "hex")).toBe("DE AD");
  });
});

describe("extra readouts", () => {
  it("computes BCD, Gray, one's complement, counts and text", () => {
    expect(bcdDecode(0x1234n, 16)).toBe("1234");
    expect(bcdDecode(0x0042n, 16)).toBe("42");
    expect(bcdDecode(0x12a4n, 16)).toBeNull();
    expect(grayToBinary(0b110n)).toBe(0b100n);
    expect(onesComplement(0xfen, 8)).toBe(-1n);
    expect(onesComplement(0x05n, 8)).toBe(5n);
    expect(countLeadingZeros(0x00ffn, 16)).toBe(8);
    expect(countTrailingZeros(0x0100n, 16)).toBe(8);
    expect(countTrailingZeros(0n, 16)).toBe(16);
    expect(bytesAsText(0x4869n, 32)).toBe("Hi");
    expect(bytesAsText(0x48ff69n, 32)).toBe("H·i");
    expect(bytesAsText(0xe282acn, 32)).toBe("€");
  });
});
