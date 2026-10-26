import { describe, expect, it } from "vitest";
import { defaultPrefix, generate, ident } from "../../src/core/codegen";
import {
  decodeField,
  isInvertible,
  rawFromNumber,
} from "../../src/core/fieldfmt";
import { ValueModel } from "../../src/core/model";
import { BUILTIN_TEMPLATES, validTemplate } from "../../src/core/templates";

function regWithFields() {
  const model = new ValueModel({
    width: 32,
    value: 0x0000_1234n,
    name: "Ctrl reg",
  });
  const enable = model.addGroup(0, 0, "EN");
  const mode = model.addGroup(4, 5, "MODE");
  model.setGroupDetails(mode, {
    named: [
      { value: 0n, label: "Off" },
      { value: 1n, label: "Auto" },
      { value: 2n, label: "Manual" },
    ],
    description: "Operating mode",
  });
  const temperatureField = model.addGroup(8, 15, "TEMP");
  model.setGroupDetails(temperatureField, {
    formula: "x * 0.5 - 40",
    unit: "°C",
  });
  const offsetField = model.addGroup(16, 19, "OFFSET");
  model.setGroupDetails(offsetField, { signed: true, access: "ro" });
  return { model, enable, mode, temperatureField, offsetField };
}

describe("field details", () => {
  it("round-trips through JSON and stays compact when unused", () => {
    const { model } = regWithFields();
    const json = JSON.parse(JSON.stringify(model));
    expect(json.groups.find((group: any) => group.name === "EN")).toEqual({
      lo: 0,
      hi: 0,
      name: "EN",
      color: expect.any(String),
      base: 2,
    });
    const back = ValueModel.fromJSON(json);
    expect(back.toJSON()).toEqual(model.toJSON());
    const mode = back.groups.find((group) => group.name === "MODE")!;
    expect(mode.nameOf(1n)).toBe("Auto");
    expect(mode.description).toBe("Operating mode");
    expect(back.groups.find((group) => group.name === "OFFSET")!.access).toBe(
      "ro",
    );
  });

  it("ignores malformed details in files", () => {
    const model = ValueModel.fromJSON({
      width: 8,
      groups: [
        {
          lo: 0,
          hi: 3,
          name: "X",
          signed: "yes",
          access: "weird",
          named: [{ value: "zz", label: "bad" }, 5],
        },
      ],
    });
    const group = model.groups[0];
    expect(group.signed).toBe(false);
    expect(group.access).toBe("rw");
    expect(group.named).toEqual([]);
  });

  it("decodes signed values and formulas", () => {
    const { temperatureField, offsetField } = regWithFields();
    expect(decodeField(temperatureField, 0x7an).text).toBe("21 °C"); // 122 * 0.5 - 40
    expect(decodeField(temperatureField, 0x7bn).text).toBe("21.5 °C");
    expect(decodeField(offsetField, 0xen).text).toBe("-2");
    expect(decodeField(offsetField, 0x7n).text).toBe("7");
  });

  it("turns typed values back into raw bits", () => {
    const { temperatureField, offsetField } = regWithFields();
    expect(isInvertible(temperatureField)).toBe(true);
    expect(rawFromNumber(temperatureField, 21.5)).toBe(0x7bn);
    expect(() => rawFromNumber(temperatureField, 1000)).toThrow(/Out of range/);
    expect(rawFromNumber(offsetField, -2)).toBe(0xen);
    expect(() => rawFromNumber(offsetField, 8)).toThrow(/Out of range/);
    const { model } = regWithFields();
    const sequence = model.addGroup(24, 31, "SQ");
    model.setGroupDetails(sequence, { formula: "x * x" });
    expect(isInvertible(sequence)).toBe(false);
    expect(() => rawFromNumber(sequence, 4)).toThrow(/can't be reversed/);
  });
});

describe("templates", () => {
  it("builds valid fields for every built-in template", () => {
    for (const template of BUILTIN_TEMPLATES) {
      const model = new ValueModel({ width: template.width });
      model.applyTemplate(template);
      expect(model.groups.length).toBe(template.fields.length);
      for (const field of template.fields)
        expect(field.hi).toBeLessThan(template.width);
    }
  });

  it("gives float32 fields the right meaning", () => {
    const template = BUILTIN_TEMPLATES.find(
      (candidate) => candidate.name === "IEEE-754 float32",
    )!;
    const model = new ValueModel({ width: 32, value: 0x3fc00000n }); // 1.5
    model.applyTemplate(template);
    const exp = model.groups.find((group) => group.name === "EXPONENT")!;
    expect(decodeField(exp, model.groupValue(exp)).text).toBe("0");
  });

  it("rejects malformed stored templates", () => {
    expect(validTemplate({ name: "x" })).toBeNull();
    expect(
      validTemplate({
        name: "x",
        width: 8,
        fields: [{ lo: 0, hi: 3, name: "A" }, { bad: 1 }],
      })?.fields.length,
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
    const { model } = regWithFields();
    const macroCode = generate("c", model, {
      prefix: "CTRL",
      includeValue: true,
    });
    expect(macroCode).toContain("#define CTRL_VALUE 0x1234U");
    expect(macroCode).toContain("#define CTRL_MODE_POS   4U");
    expect(macroCode).toContain(
      "#define CTRL_MODE_MASK  (0x3U << CTRL_MODE_POS)",
    );
    expect(macroCode).toContain("#define CTRL_MODE_AUTO 0x1U");
    expect(macroCode).toContain("value = x * 0.5 - 40 °C");
  });

  it("generates a C struct with padding for gaps", () => {
    const { model } = regWithFields();
    const structCode = generate("cstruct", model, {
      prefix: "CTRL",
      includeValue: false,
    });
    expect(structCode).toContain("uint32_t raw;");
    expect(structCode).toMatch(/uint32_t\s+:\s+3;\s+\/\* \[3:1\] unused/);
    expect(structCode).toMatch(/uint32_t\s+:\s+12;\s+\/\* \[31:20\] unused/);
    expect(structCode).toContain("} ctrl_t;");
  });

  it("generates Rust and Python", () => {
    const { model } = regWithFields();
    const rustCode = generate("rust", model, {
      prefix: "CTRL",
      includeValue: true,
    });
    expect(rustCode).toContain("pub mod ctrl {");
    expect(rustCode).toContain("pub const MODE_MASK: u32 = 0x30;");
    expect(rustCode).toContain(
      "pub const fn set_mode(reg: u32, v: u32) -> u32 {",
    );
    const pythonCode = generate("python", model, {
      prefix: "CTRL",
      includeValue: true,
    });
    expect(pythonCode).toContain("CTRL_TEMP_MASK = 0xFF00");
    expect(pythonCode).toContain("def set_ctrl_temp(reg, value):");
  });

  it("summarises the layout at the top of the file", () => {
    const { model } = regWithFields();
    const macroCode = generate("c", model, {
      prefix: "CTRL",
      includeValue: false,
    });
    expect(macroCode).toContain(" * Layout:");
    expect(macroCode).toMatch(/\[19:16\]\s+OFFSET\s+read-only · signed/);
    expect(
      generate("python", model, { prefix: "CTRL", includeValue: false }),
    ).toContain("Layout:\n");
  });

  it("can leave out the get/set helpers", () => {
    const { model } = regWithFields();
    const options = { prefix: "CTRL", includeValue: false, accessors: false };
    expect(generate("c", model, options)).not.toContain("_GET");
    expect(generate("c", model, options)).toContain("CTRL_MODE_MASK");
    expect(generate("rust", model, options)).not.toContain("pub const fn");
    expect(generate("python", model, options)).not.toContain("def ");
    expect(generate("python", model, options)).toContain(
      "CTRL_MODE_MASK = 0x30",
    );
  });

  it("keeps field names unique", () => {
    const model = new ValueModel({ width: 8 });
    model.addGroup(0, 1, "Mode");
    model.addGroup(4, 5, "MODE");
    const macroCode = generate("c", model, {
      prefix: "R",
      includeValue: false,
    });
    expect(macroCode).toContain("R_MODE_POS   0U");
    expect(macroCode).toContain("R_MODE_2_POS   4U");
  });

  it("picks a sensible default prefix", () => {
    expect(defaultPrefix(new ValueModel({ width: 8, name: "Ctrl reg" }))).toBe(
      "CTRL_REG",
    );
    expect(defaultPrefix(new ValueModel({ width: 8, name: "Value 3" }))).toBe(
      "REG",
    );
    expect(defaultPrefix(new ValueModel({ width: 8, name: "" }))).toBe("REG");
  });
});
