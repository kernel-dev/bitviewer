import { describe, expect, it } from "vitest";
import { applyOp, ModelError, ValueModel } from "./model";
import { asFloat, formatFloat, formatInt, ParseError, parseValue, toSigned } from "./numfmt";

describe("parse", () => {
  it("handles every base", () => {
    expect(parseValue("1010", 2, 8)).toBe(10n);
    expect(parseValue("17", 8, 8)).toBe(15n);
    expect(parseValue("255", 10, 8)).toBe(255n);
    expect(parseValue("fF", 16, 8)).toBe(255n);
  });
  it("lets prefixes override and ignores separators", () => {
    expect(parseValue("0xff", 10, 8)).toBe(255n);
    expect(parseValue("0b1010", 10, 8)).toBe(10n);
    expect(parseValue("0o17", 2, 8)).toBe(15n);
    expect(parseValue("dead_beef", 16, 32)).toBe(0xdeadbeefn);
    expect(parseValue("1111 0000", 2, 8)).toBe(0xf0n);
  });
  it("reads 0b as hex digits in HEX mode", () => {
    expect(parseValue("0b1", 16, 32)).toBe(0xb1n);
  });
  it("rejects bad input and flags incomplete input", () => {
    expect(() => parseValue("256", 10, 8)).toThrow(ParseError);
    expect(() => parseValue("12", 2, 8)).toThrow(ParseError);
    for (const t of ["", "0x"]) {
      try {
        parseValue(t, t ? 10 : 16, 8);
        expect.unreachable();
      } catch (e) {
        expect((e as ParseError).incomplete).toBe(true);
      }
    }
  });
  it("stores negatives as two's complement", () => {
    expect(parseValue("-1", 10, 32, true)).toBe(0xffffffffn);
    expect(parseValue("-2147483648", 10, 32, true)).toBe(0x80000000n);
    expect(() => parseValue("-2147483649", 10, 32, true)).toThrow(ParseError);
    expect(() => parseValue("-1", 10, 8)).toThrow(ParseError);
    expect(parseValue("-1", 10, 64, true)).toBe(0xffffffffffffffffn);
  });
});

describe("format", () => {
  it("formats integers", () => {
    expect(formatInt(10n, 16, 8)).toBe("0A");
    expect(formatInt(5n, 2, 4)).toBe("0101");
    expect(formatInt(0xdeadbeefn, 16, 32, { prefix: true, group: true })).toBe("0xDEAD_BEEF");
    expect(formatInt(8n, 8, 8, { prefix: true })).toBe("0o10");
  });
  it("interprets signed and float values", () => {
    expect(toSigned(0xffffffffn, 32)).toBe(-1n);
    expect(formatFloat(asFloat(0x3f800000n, 32), 32)).toBe("1.0");
    expect(formatFloat(asFloat(0x3dcccccdn, 32), 32)).toBe("0.1");
    expect(formatFloat(asFloat(0x7fc00000n, 32), 32)).toBe("NaN");
    expect(formatFloat(asFloat(0xff800000n, 32), 32)).toBe("-Inf");
    expect(formatFloat(asFloat(0x3ff0000000000000n, 64), 64)).toBe("1.0");
    expect(formatFloat(asFloat(0x80000000n, 32), 32)).toBe("-0.0");
  });
});

describe("model", () => {
  it("maps rows and bits", () => {
    const m = new ValueModel({ width: 32, value: 0x12345678n });
    expect(m.rowLos()).toEqual([24, 16, 8, 0]);
    expect(m.rowValue(24)).toBe(0x12n);
    m.setRowValue(0, 0xffn);
    expect(m.value).toBe(0x123456ffn);
    m.flipBit(31);
    expect(m.value).toBe(0x923456ffn);
    m.setMsbFirst(false);
    expect(m.rowLos()).toEqual([0, 8, 16, 24]);
    m.setView("nibble");
    expect(m.rowLos().length).toBe(8);
    expect(m.rowValue(4)).toBe(0xfn);
  });

  it("applies operations", () => {
    expect(applyOp("invert", 0x0fn, 8)).toBe(0xf0n);
    expect(applyOp("shl", 0x81n, 8)).toBe(0x02n);
    expect(applyOp("shr", 0x81n, 8)).toBe(0x40n);
    const m = new ValueModel({ width: 32, value: 0xf0n });
    m.opRow(0, "shr");
    expect(m.value).toBe(0x78n);
    m.opValue("set");
    expect(m.value).toBe(0xffffffffn);
  });

  it("keeps compares across view switches", () => {
    const m = new ValueModel({ width: 32, value: 0xabn });
    m.addCompare(0);
    m.setCompare(0, 0xcdn);
    expect(m.compareDiff(0)).toBe(0xabn ^ 0xcdn);
    m.setView("nibble");
    expect([...m.compares]).toEqual([
      [0, 0xdn],
      [4, 0xcn],
    ]);
    m.removeCompare(4);
    m.setView("byte");
    expect([...m.compares]).toEqual([[0, 0xadn]]); // missing high nibble filled from parent
  });

  it("keeps snapshots and the collapsed state in files", () => {
    const m = new ValueModel({ width: 16, value: 0x1234n });
    const a = m.takeSnapshot("after reset", 1000);
    m.setValue(0xbeefn);
    m.takeSnapshot("", 2000);
    m.setCollapsed(true);
    expect(m.snapshots.map((s) => s.name)).toEqual(["after reset", "Snapshot 2"]);
    const back = ValueModel.fromJSON(JSON.parse(JSON.stringify(m)));
    expect(back.collapsed).toBe(true);
    expect(back.snapshots).toEqual([
      { name: "after reset", value: 0x1234n, at: 1000 },
      { name: "Snapshot 2", value: 0xbeefn, at: 2000 },
    ]);
    m.removeSnapshot(a);
    expect(m.snapshots.length).toBe(1);
    expect(
      ValueModel.fromJSON({
        width: 8,
        snapshots: [
          { name: "x", value: "zz" },
          { name: "y", value: "0x1ff" },
        ],
      }).snapshots,
    ).toEqual([{ name: "y", value: 0xffn, at: 0 }]);
  });

  it("remembers a closed compare row's value", () => {
    const m = new ValueModel({ width: 32, value: 0x1n, view: "line" });
    m.addCompare(0);
    m.setCompare(0, 0x80001n);
    m.removeCompare(0);
    expect(m.hasCompare(0)).toBe(false);
    m.setValue(0x2n); // the parent can change meanwhile
    m.addCompare(0);
    expect(m.compareValue(0)).toBe(0x80001n); // edits come back on reopen

    // survives save / load while closed
    m.removeCompare(0);
    const loaded = ValueModel.fromJSON(JSON.parse(JSON.stringify(m)));
    expect(loaded.hasCompare(0)).toBe(false);
    loaded.addCompare(0);
    expect(loaded.compareValue(0)).toBe(0x80001n);

    // survives switching views while closed
    loaded.removeCompare(0);
    loaded.setView("byte");
    loaded.addCompare(16);
    expect(loaded.compareValue(16)).toBe(0x08n);
    loaded.addCompare(8);
    expect(loaded.compareValue(8)).toBe(0x00n);
    loaded.addCompare(0);
    expect(loaded.compareValue(0)).toBe(0x01n);
    expect([...loaded.hiddenCompares.keys()]).toEqual([24]); // byte 3 still closed, still remembered
  });

  it("supports the line view", () => {
    const m = new ValueModel({ width: 64, value: 0x1122334455667788n, view: "line" });
    expect(m.rowWidth).toBe(64);
    expect(m.rowLos()).toEqual([0]);
    m.setView("byte");
    m.addCompare(8);
    m.setCompare(8, 0xffn);
    m.setRowBase(16, 2);
    m.setView("line");
    expect([...m.compares]).toEqual([[0, 0x112233445566ff88n]]);
    expect([...m.rowBases]).toEqual([[0, 2]]);
    m.setView("nibble");
    expect(m.compares.size).toBe(16);
    expect(m.compareValue(8)).toBe(0xfn);
  });

  it("supports any width from 1 to 512 bits", () => {
    expect(() => new ValueModel({ width: 0 })).toThrow(ModelError);
    expect(() => new ValueModel({ width: 513 })).toThrow(ModelError);
    expect(() => new ValueModel({ width: 12.5 })).toThrow(ModelError);
    const m = new ValueModel({ width: 12, value: 0xabcn });
    expect(m.rowLos()).toEqual([8, 0]);
    expect(m.rowWidthAt(8)).toBe(4); // partial top byte
    expect(m.rowValue(8)).toBe(0xan);
    m.setRowValue(8, 0xffn); // masked to the 4 bits that exist
    expect(m.value).toBe(0xfbcn);
    m.opRow(8, "invert");
    expect(m.value).toBe(0x0bcn);
    m.addCompare(8);
    m.setCompare(8, 0xffn);
    expect(m.compareValue(8)).toBe(0xfn);
    m.setView("nibble");
    expect([...m.compares]).toEqual([[8, 0xfn]]);
    m.setView("line");
    expect([...m.compares]).toEqual([[0, 0xfbcn]]);

    const big = new ValueModel({ width: 512, view: "byte" });
    big.opValue("set");
    expect(big.value).toBe((1n << 512n) - 1n);
    expect(big.rowLos().length).toBe(64);
    expect(parseValue("-1", 10, 512, true)).toBe((1n << 512n) - 1n);
    expect(formatInt(1n << 511n, 16, 512).length).toBe(128);
    const one = new ValueModel({ width: 1, view: "byte" });
    expect(one.rowLos()).toEqual([0]);
    one.flipBit(0);
    expect(one.value).toBe(1n);
  });

  it("resizes values", () => {
    const m = new ValueModel({ width: 32, value: 0xdeadbeefn, view: "byte" });
    m.addGroup(24, 31, "TOP");
    m.addGroup(0, 7, "LOW");
    m.addCompare(24);
    m.addCompare(0);
    expect(m.lostOnResize(16).groups.map((g) => g.name)).toEqual(["TOP"]);
    expect(m.lostOnResize(16).compares).toBe(1);
    // named fields are never dropped implicitly: shrinking below one is refused
    expect(m.minWidthForGroups).toBe(32);
    expect(() => m.setWidth(16)).toThrow(ModelError);
    expect(m.width).toBe(32);
    expect(m.groups.map((g) => g.name)).toEqual(["TOP", "LOW"]);
    m.removeGroup(m.groups[0]);
    m.setWidth(16);
    expect(m.value).toBe(0xbeefn);
    expect(m.groups.map((g) => g.name)).toEqual(["LOW"]);
    expect([...m.compares.keys()]).toEqual([0]);
    m.setWidth(100);
    expect(m.value).toBe(0xbeefn);
    expect(m.rowLos()[0]).toBe(96);
    expect(m.rowWidthAt(96)).toBe(4);
    const json = JSON.parse(JSON.stringify(m));
    expect(ValueModel.fromJSON(json).toJSON()).toEqual(m.toJSON());
  });

  it("manages groups", () => {
    const m = new ValueModel({ width: 32, value: 0xabcd1234n });
    const g = m.addGroup(12, 19, "SPAN"); // spans two bytes
    expect(m.groupValue(g)).toBe(0xd1n);
    m.setGroupValue(g, 0xffn);
    expect(m.value).toBe(0xabcff234n);
    expect(() => m.addGroup(19, 20)).toThrow(ModelError);
    m.addGroup(20, 20);
    expect(m.groupAt(15)).toBe(g);
    expect(m.groupAt(0)).toBeUndefined();
  });

  it("round-trips through JSON", () => {
    const m = new ValueModel({
      width: 64,
      value: 0xdeadbeefcafef00dn,
      name: "R",
      view: "nibble",
      msbFirst: false,
      fullBase: 10,
    });
    m.setRowBase(4, 2);
    m.addCompare(8);
    m.setCompare(8, 3n);
    m.addGroup(0, 7, "LOW");
    m.setShowBases(true);
    const json = JSON.parse(JSON.stringify(m));
    expect(ValueModel.fromJSON(json).toJSON()).toEqual(m.toJSON());
  });

  it("reads files written by the Python version", () => {
    const m = ValueModel.fromJSON({
      name: "Legacy",
      width: 32,
      value: "0x3FC00000",
      view: "byte",
      msb_first: true,
      full_base: 16,
      default_row_base: 16,
      row_bases: { "8": 2 },
      compares: { "0": "0x12" },
      groups: [{ lo: 23, hi: 30, name: "EXP", color: "#e8590c", base: 16 }],
    });
    expect(m.value).toBe(0x3fc00000n);
    expect(m.rowBase(8)).toBe(2);
    expect(m.compareValue(0)).toBe(0x12n);
    expect(m.groups[0].name).toBe("EXP");
    expect(m.showBases).toBe(false); // older files have no show_bases key
  });

  it("rejects bad input", () => {
    expect(() => ValueModel.fromJSON({ width: 600 })).toThrow(ModelError);
    expect(() => ValueModel.fromJSON({ width: 16, compares: { "3": "0x1" } })).toThrow(ModelError);
    expect(() => ValueModel.fromJSON({ width: 32, groups: [{ lo: 0, hi: 40 }] })).toThrow(ModelError);
  });
});
