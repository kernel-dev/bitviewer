import { describe, expect, it } from "vitest";
import { generate, ident } from "./codegen";
import { decodeField, isInvertible, rawFromNumber } from "./fieldfmt";
import { ValueModel } from "./model";
import { BUILTIN_TEMPLATES, validTemplate } from "./templates";

function regWithFields() {
  const m = new ValueModel({ width: 32, value: 0x0000_1234n, name: "Ctrl reg" });
  const en = m.addGroup(0, 0, "EN");
  const mode = m.addGroup(4, 5, "MODE");
  m.setGroupDetails(mode, {
    named: [
      { value: 0n, label: "Off" },
      { value: 1n, label: "Auto" },
      { value: 2n, label: "Manual" },
    ],
    description: "Operating mode",
  });
  const temp = m.addGroup(8, 15, "TEMP");
  m.setGroupDetails(temp, { formula: "x * 0.5 - 40", unit: "°C" });
  const off = m.addGroup(16, 19, "OFFSET");
  m.setGroupDetails(off, { signed: true, access: "ro" });
  return { m, en, mode, temp, off };
}

describe("field details", () => {
  it("round-trips through JSON and stays compact when unused", () => {
    const { m } = regWithFields();
    const json = JSON.parse(JSON.stringify(m));
    expect(json.groups.find((g: any) => g.name === "EN")).toEqual({
      lo: 0,
      hi: 0,
      name: "EN",
      color: expect.any(String),
      base: 2,
    });
    const back = ValueModel.fromJSON(json);
    expect(back.toJSON()).toEqual(m.toJSON());
    const mode = back.groups.find((g) => g.name === "MODE")!;
    expect(mode.nameOf(1n)).toBe("Auto");
    expect(mode.description).toBe("Operating mode");
    expect(back.groups.find((g) => g.name === "OFFSET")!.access).toBe("ro");
  });

  it("ignores malformed details in files", () => {
    const m = ValueModel.fromJSON({
      width: 8,
      groups: [{ lo: 0, hi: 3, name: "X", signed: "yes", access: "weird", named: [{ value: "zz", label: "bad" }, 5] }],
    });
    const g = m.groups[0];
    expect(g.signed).toBe(false);
    expect(g.access).toBe("rw");
    expect(g.named).toEqual([]);
  });

  it("decodes signed values and formulas", () => {
    const { temp, off } = regWithFields();
    expect(decodeField(temp, 0x7an).text).toBe("21 °C"); // 122 * 0.5 - 40
    expect(decodeField(temp, 0x7bn).text).toBe("21.5 °C");
    expect(decodeField(off, 0xen).text).toBe("-2");
    expect(decodeField(off, 0x7n).text).toBe("7");
  });

  it("turns typed values back into raw bits", () => {
    const { temp, off } = regWithFields();
    expect(isInvertible(temp)).toBe(true);
    expect(rawFromNumber(temp, 21.5)).toBe(0x7bn);
    expect(() => rawFromNumber(temp, 1000)).toThrow(/Out of range/);
    expect(rawFromNumber(off, -2)).toBe(0xen);
    expect(() => rawFromNumber(off, 8)).toThrow(/Out of range/);
    const { m } = regWithFields();
    const sq = m.addGroup(24, 31, "SQ");
    m.setGroupDetails(sq, { formula: "x * x" });
    expect(isInvertible(sq)).toBe(false);
    expect(() => rawFromNumber(sq, 4)).toThrow(/can't be reversed/);
  });
});

describe("templates", () => {
  it("builds valid fields for every built-in template", () => {
    for (const t of BUILTIN_TEMPLATES) {
      const m = new ValueModel({ width: t.width });
      m.applyTemplate(t);
      expect(m.groups.length).toBe(t.fields.length);
      for (const f of t.fields) expect(f.hi).toBeLessThan(t.width);
    }
  });

  it("gives float32 fields the right meaning", () => {
    const t = BUILTIN_TEMPLATES.find((x) => x.name === "IEEE-754 float32")!;
    const m = new ValueModel({ width: 32, value: 0x3fc00000n }); // 1.5
    m.applyTemplate(t);
    const exp = m.groups.find((g) => g.name === "EXPONENT")!;
    expect(decodeField(exp, m.groupValue(exp)).text).toBe("0");
  });

  it("rejects malformed stored templates", () => {
    expect(validTemplate({ name: "x" })).toBeNull();
    expect(
      validTemplate({ name: "x", width: 8, fields: [{ lo: 0, hi: 3, name: "A" }, { bad: 1 }] })?.fields.length,
    ).toBe(1);
  });
});

describe("code generation", () => {
  it("makes identifiers", () => {
    expect(ident("Ctrl reg")).toBe("CTRL_REG");
    expect(ident("1st")).toBe("_1ST");
    expect(ident("  ")).toBe("REG");
  });

  it("generates C macros with masks and named values", () => {
    const { m } = regWithFields();
    const c = generate("c", m, { prefix: "CTRL", includeValue: true });
    expect(c).toContain("#define CTRL_VALUE 0x1234U");
    expect(c).toContain("#define CTRL_MODE_POS   4U");
    expect(c).toContain("#define CTRL_MODE_MASK  (0x3U << CTRL_MODE_POS)");
    expect(c).toContain("#define CTRL_MODE_AUTO 0x1U");
    expect(c).toContain("value = x * 0.5 - 40 °C");
  });

  it("generates a C struct with padding for gaps", () => {
    const { m } = regWithFields();
    const s = generate("cstruct", m, { prefix: "CTRL", includeValue: false });
    expect(s).toContain("uint32_t raw;");
    expect(s).toMatch(/uint32_t\s+:\s+3;\s+\/\* \[3:1\] unused/);
    expect(s).toMatch(/uint32_t\s+:\s+12;\s+\/\* \[31:20\] unused/);
    expect(s).toContain("} ctrl_t;");
  });

  it("generates Rust and Python", () => {
    const { m } = regWithFields();
    const rs = generate("rust", m, { prefix: "CTRL", includeValue: true });
    expect(rs).toContain("pub mod ctrl {");
    expect(rs).toContain("pub const MODE_MASK: u32 = 0x30;");
    expect(rs).toContain("pub const fn set_mode(reg: u32, v: u32) -> u32 {");
    const py = generate("python", m, { prefix: "CTRL", includeValue: true });
    expect(py).toContain("CTRL_TEMP_MASK = 0xFF00");
    expect(py).toContain("def set_ctrl_temp(reg, value):");
  });
});
