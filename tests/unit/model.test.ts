import { describe, expect, it } from "vitest";
import {
  formatInt,
  ParseError,
  parseValue,
  toSigned,
} from "../../src/core/format/integers";
import {
  decodeFloat,
  formatFloatKind,
} from "../../src/core/format/interpretations";
import {
  applyOp,
  ModelError,
  ValueModel,
  valueFromJSON,
  valueToJSON,
} from "../../src/core/model";

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
    for (const prefix of ["", "0x"]) {
      try {
        parseValue(prefix, prefix ? 10 : 16, 8);
        expect.unreachable();
      } catch (error) {
        expect((error as ParseError).incomplete).toBe(true);
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
    expect(formatInt(0xdeadbeefn, 16, 32, { prefix: true, group: true })).toBe(
      "0xDEAD_BEEF",
    );
    expect(formatInt(8n, 8, 8, { prefix: true })).toBe("0o10");
  });
  it("interprets signed and float values", () => {
    expect(toSigned(0xffffffffn, 32)).toBe(-1n);
    expect(formatFloatKind(decodeFloat(0x3f800000n, "f32"), "f32")).toBe("1.0");
    expect(formatFloatKind(decodeFloat(0x3dcccccdn, "f32"), "f32")).toBe("0.1");
    expect(formatFloatKind(decodeFloat(0x7fc00000n, "f32"), "f32")).toBe("NaN");
    expect(formatFloatKind(decodeFloat(0xff800000n, "f32"), "f32")).toBe(
      "-Inf",
    );
    expect(
      formatFloatKind(decodeFloat(0x3ff0000000000000n, "f64"), "f64"),
    ).toBe("1.0");
    expect(formatFloatKind(decodeFloat(0x80000000n, "f32"), "f32")).toBe(
      "-0.0",
    );
  });
});

describe("model", () => {
  it("maps rows and bits", () => {
    const model = new ValueModel({ width: 32, value: 0x12345678n });
    expect(model.rowLos()).toEqual([24, 16, 8, 0]);
    expect(model.rowValue(24)).toBe(0x12n);
    model.setRowValue(0, 0xffn);
    expect(model.value).toBe(0x123456ffn);
    model.flipBit(31);
    expect(model.value).toBe(0x923456ffn);
    model.setMsbFirst(false);
    expect(model.rowLos()).toEqual([0, 8, 16, 24]);
    model.setView("nibble");
    expect(model.rowLos().length).toBe(8);
    expect(model.rowValue(4)).toBe(0xfn);
  });

  it("applies operations", () => {
    expect(applyOp("invert", 0x0fn, 8)).toBe(0xf0n);
    expect(applyOp("shl", 0x81n, 8)).toBe(0x02n);
    expect(applyOp("shr", 0x81n, 8)).toBe(0x40n);
    const model = new ValueModel({ width: 32, value: 0xf0n });
    model.opRow(0, "shr");
    expect(model.value).toBe(0x78n);
    model.opValue("set");
    expect(model.value).toBe(0xffffffffn);
  });

  it("keeps compares across view switches", () => {
    const model = new ValueModel({ width: 32, value: 0xabn });
    model.addCompare(0);
    model.setCompare(0, 0xcdn);
    expect(model.compareDiff(0)).toBe(0xabn ^ 0xcdn);
    model.setView("nibble");
    expect([...model.compares]).toEqual([
      [0, 0xdn],
      [4, 0xcn],
    ]);
    model.removeCompare(4);
    model.setView("byte");
    expect([...model.compares]).toEqual([[0, 0xadn]]); // missing high nibble filled from parent
  });

  it("keeps snapshots and the collapsed state in files", () => {
    const model = new ValueModel({ width: 16, value: 0x1234n });
    const snapshot = model.takeSnapshot("after reset", 1000);
    model.setValue(0xbeefn);
    model.takeSnapshot("", 2000);
    model.setCollapsed(true);
    expect(model.snapshots.map((entry) => entry.name)).toEqual([
      "after reset",
      "Snapshot 2",
    ]);
    const back = valueFromJSON(JSON.parse(JSON.stringify(valueToJSON(model))));
    expect(back.collapsed).toBe(true);
    expect(back.snapshots).toEqual([
      { name: "after reset", value: 0x1234n, at: 1000 },
      { name: "Snapshot 2", value: 0xbeefn, at: 2000 },
    ]);
    model.removeSnapshot(snapshot);
    expect(model.snapshots.length).toBe(1);
    expect(
      valueFromJSON({
        width: 8,
        snapshots: [
          { name: "x", value: "zz" },
          { name: "y", value: "0x1ff" },
        ],
      }).snapshots,
    ).toEqual([{ name: "y", value: 0xffn, at: 0 }]);
  });

  it("remembers a closed compare row's value", () => {
    const model = new ValueModel({ width: 32, value: 0x1n, view: "line" });
    model.addCompare(0);
    model.setCompare(0, 0x80001n);
    model.removeCompare(0);
    expect(model.hasCompare(0)).toBe(false);
    model.setValue(0x2n); // the parent can change meanwhile
    model.addCompare(0);
    expect(model.compareValue(0)).toBe(0x80001n); // edits come back on reopen

    // survives save / load while closed
    model.removeCompare(0);
    const loaded = valueFromJSON(
      JSON.parse(JSON.stringify(valueToJSON(model))),
    );
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
    const model = new ValueModel({
      width: 64,
      value: 0x1122334455667788n,
      view: "line",
    });
    expect(model.rowWidth).toBe(64);
    expect(model.rowLos()).toEqual([0]);
    model.setView("byte");
    model.addCompare(8);
    model.setCompare(8, 0xffn);
    model.setRowBase(16, 2);
    model.setView("line");
    expect([...model.compares]).toEqual([[0, 0x112233445566ff88n]]);
    expect([...model.rowBases]).toEqual([[0, 2]]);
    model.setView("nibble");
    expect(model.compares.size).toBe(16);
    expect(model.compareValue(8)).toBe(0xfn);
  });

  it("supports any width from 1 to 512 bits", () => {
    expect(() => new ValueModel({ width: 0 })).toThrow(ModelError);
    expect(() => new ValueModel({ width: 513 })).toThrow(ModelError);
    expect(() => new ValueModel({ width: 12.5 })).toThrow(ModelError);
    const model = new ValueModel({ width: 12, value: 0xabcn });
    expect(model.rowLos()).toEqual([8, 0]);
    expect(model.rowWidthAt(8)).toBe(4); // partial top byte
    expect(model.rowValue(8)).toBe(0xan);
    model.setRowValue(8, 0xffn); // masked to the 4 bits that exist
    expect(model.value).toBe(0xfbcn);
    model.opRow(8, "invert");
    expect(model.value).toBe(0x0bcn);
    model.addCompare(8);
    model.setCompare(8, 0xffn);
    expect(model.compareValue(8)).toBe(0xfn);
    model.setView("nibble");
    expect([...model.compares]).toEqual([[8, 0xfn]]);
    model.setView("line");
    expect([...model.compares]).toEqual([[0, 0xfbcn]]);

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
    const model = new ValueModel({
      width: 32,
      value: 0xdeadbeefn,
      view: "byte",
    });
    model.addGroup(24, 31, "TOP");
    model.addGroup(0, 7, "LOW");
    model.addCompare(24);
    model.addCompare(0);
    expect(model.lostOnResize(16).groups.map((group) => group.name)).toEqual([
      "TOP",
    ]);
    expect(model.lostOnResize(16).compares).toBe(1);
    // named fields are never dropped implicitly: shrinking below one is refused
    expect(model.minWidthForGroups).toBe(32);
    expect(() => model.setWidth(16)).toThrow(ModelError);
    expect(model.width).toBe(32);
    expect(model.groups.map((group) => group.name)).toEqual(["TOP", "LOW"]);
    model.removeGroup(model.groups[0]);
    model.setWidth(16);
    expect(model.value).toBe(0xbeefn);
    expect(model.groups.map((group) => group.name)).toEqual(["LOW"]);
    expect([...model.compares.keys()]).toEqual([0]);
    model.setWidth(100);
    expect(model.value).toBe(0xbeefn);
    expect(model.rowLos()[0]).toBe(96);
    expect(model.rowWidthAt(96)).toBe(4);
    const json = JSON.parse(JSON.stringify(valueToJSON(model)));
    expect(valueToJSON(valueFromJSON(json))).toEqual(valueToJSON(model));
  });

  it("manages groups", () => {
    const model = new ValueModel({ width: 32, value: 0xabcd1234n });
    const group = model.addGroup(12, 19, "SPAN"); // spans two bytes
    expect(model.groupValue(group)).toBe(0xd1n);
    model.setGroupValue(group, 0xffn);
    expect(model.value).toBe(0xabcff234n);
    expect(() => model.addGroup(19, 20)).toThrow(ModelError);
    model.addGroup(20, 20);
    expect(model.groupAt(15)).toBe(group);
    expect(model.groupAt(0)).toBeUndefined();
  });

  it("resizes a group without overlapping its neighbours", () => {
    const model = new ValueModel({ width: 32, value: 0xabcd1234n });
    const group = model.addGroup(4, 7, "FCD");
    const next = model.addGroup(12, 15, "NEXT");
    model.resizeGroup(group, 4, 11);
    expect([group.lo, group.hi, group.width]).toEqual([4, 11, 8]);
    expect(model.groupValue(group)).toBe(0x23n);
    expect(() => model.resizeGroup(group, 4, 12)).toThrow(ModelError);
    expect(() => model.resizeGroup(group, 0, 32)).toThrow(ModelError);
    expect([group.lo, group.hi]).toEqual([4, 11]);
    model.resizeGroup(group, 0, 7); // narrowing and moving down is fine too
    expect(model.groups).toEqual([next, group]);
  });

  it("round-trips through JSON", () => {
    const model = new ValueModel({
      width: 64,
      value: 0xdeadbeefcafef00dn,
      name: "R",
      view: "nibble",
      msbFirst: false,
      fullBase: 10,
    });
    model.setRowBase(4, 2);
    model.addCompare(8);
    model.setCompare(8, 3n);
    model.addGroup(0, 7, "LOW");
    model.setShowBases(true);
    const json = JSON.parse(JSON.stringify(valueToJSON(model)));
    expect(valueToJSON(valueFromJSON(json))).toEqual(valueToJSON(model));
  });

  it("reads files written by the Python version", () => {
    const model = valueFromJSON({
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
    expect(model.value).toBe(0x3fc00000n);
    expect(model.rowBase(8)).toBe(2);
    expect(model.compareValue(0)).toBe(0x12n);
    expect(model.groups[0].name).toBe("EXP");
    expect(model.showBases).toBe(false); // older files have no show_bases key
  });

  it("rejects bad input", () => {
    expect(() => valueFromJSON({ width: 600 })).toThrow(ModelError);
    expect(() =>
      valueFromJSON({ width: 16, compares: { "3": "0x1" } }),
    ).toThrow(ModelError);
    expect(() =>
      valueFromJSON({ width: 32, groups: [{ lo: 0, hi: 40 }] }),
    ).toThrow(ModelError);
  });
});
