// Regression tests for bugs found in the October 2026 review.
import { describe, expect, it } from "vitest";
import { generate } from "../../src/core/export/codegen";
import { renderSource, TemplateError } from "../../src/core/export/language";
import { ExprError, evalInt, evalReal, parseExpr } from "../../src/core/expr";
import { decodeField } from "../../src/core/format/fields";
import { parseBytes } from "../../src/core/format/interpretations";
import { ModelError, ValueModel, valueFromJSON } from "../../src/core/model";
import { validTemplate } from "../../src/core/templates";

const none = () => undefined;

describe("expressions", () => {
  it("guards powers of negative numbers like positive ones", () => {
    expect(() => evalInt(parseExpr("(-3) ** 100000000"), none)).toThrow(
      /too large/,
    );
    expect(evalInt(parseExpr("(-2) ** 3"), none)).toBe(-8n);
    expect(evalInt(parseExpr("(-1) ** 1000001"), none)).toBe(-1n);
  });

  it("doesn't see built-in object properties as names or functions", () => {
    const x = (name: string) => (name === "x" ? 5 : undefined);
    expect(() => evalReal(parseExpr("x + constructor"), x)).toThrow(ExprError);
    expect(() => evalReal(parseExpr("constructor(1)"), x)).toThrow(ExprError);
    expect(evalReal(parseExpr("pi * 0 + x"), x)).toBe(5);
  });

  it("reports a prefix without digits as an expression error", () => {
    for (const source of ["0x_", "0b_", "0o_"])
      expect(() => evalInt(parseExpr(source), none)).toThrow(ExprError);
  });

  it("limits shifts in unit formulas", () => {
    expect(() => evalReal(parseExpr("1 << 100000000"), none)).toThrow(
      ExprError,
    );
    expect(evalReal(parseExpr("1 << 4"), none)).toBe(16);
  });

  it("shows a broken formula as an error instead of throwing", () => {
    const model = new ValueModel({ width: 8 });
    const group = model.addGroup(0, 3, "A");
    model.setGroupDetails(group, { formula: "x << 100000000" });
    expect(decodeField(group, 1n).error).toMatch(/Shift amount/);
  });
});

describe("workspace files", () => {
  it("rejects bit positions that aren't whole numbers", () => {
    for (const lo of ["abc", 1.5, null])
      expect(() =>
        valueFromJSON({
          width: 8,
          groups: [{ lo, hi: 3, name: "A" }],
        }),
      ).toThrow(ModelError);
    expect(() => valueFromJSON({ width: 8, row_bases: { abc: 2 } })).toThrow(
      ModelError,
    );
  });

  it("replaces colours that aren't #rgb / #rrggbb", () => {
    const model = valueFromJSON({
      width: 8,
      groups: [
        { lo: 0, hi: 3, name: "A", color: "red;background:url(x)" },
        { lo: 4, hi: 7, name: "B", color: "#AbC" },
      ],
    });
    expect(model.groups.find((group) => group.name === "A")!.color).toMatch(
      /^#[0-9a-f]{6}$/i,
    );
    expect(model.groups.find((group) => group.name === "B")!.color).toBe(
      "#AbC",
    );
    expect(() =>
      model.updateGroup(model.groups[0], { color: "url(x)" }),
    ).toThrow(ModelError);
  });

  it("keeps named values inside the field", () => {
    const model = valueFromJSON({
      width: 8,
      groups: [
        {
          lo: 0,
          hi: 3,
          name: "A",
          named: [
            { value: "-1", label: "ALL" },
            { value: "99", label: "TOO_BIG" },
            { value: "2", label: "TWO" },
          ],
        },
      ],
    });
    expect(model.groups[0].named).toEqual([
      { value: 15n, label: "ALL" },
      { value: 2n, label: "TWO" },
    ]);
  });

  it("checks stored field templates", () => {
    expect(
      validTemplate({
        name: "T",
        width: 8,
        fields: [
          { lo: 0, hi: 3, name: "OK", color: "x" },
          { lo: 4, hi: 9, name: "TOO_WIDE" },
          { lo: 3, hi: 1, name: "BACKWARDS" },
        ],
      })?.fields,
    ).toEqual([{ lo: 0, hi: 3, name: "OK", color: undefined }]);
    expect(validTemplate({ name: "T", width: 9999, fields: [] })).toBeNull();
  });
});

describe("code export", () => {
  const register = () => {
    const model = new ValueModel({ width: 64, name: "CTRL" });
    const type = model.addGroup(40, 43, "TYPE");
    model.addGroup(0, 3, "Mode");
    model.setGroupDetails(type, {
      named: [
        { value: 1n, label: "On" },
        { value: 2n, label: "ON" },
        { value: 3n, label: "Mask" },
      ],
    });
    return model;
  };
  const options = { prefix: "CTRL", includeValue: true };

  it("escapes Rust keywords", () => {
    const rust = generate("rust", register(), options);
    expect(rust).toContain("pub const fn r#type(reg: u64)");
    expect(rust).toContain("pub const fn set_type(");
    const reserved = new ValueModel({ width: 8, name: "self" });
    expect(
      generate("rust", reserved, { prefix: "self", includeValue: false }),
    ).toContain("pub mod self_ {");
  });

  it("gives C headers include guards and stdint.h", () => {
    const struct = generate("cstruct", register(), options);
    expect(struct).toContain("#include <stdint.h>");
    expect(struct).toContain("#ifndef CTRL_STRUCT_H");
    expect(struct.trimEnd().endsWith("#endif /* CTRL_STRUCT_H */")).toBe(true);
    const macros = generate("c", register(), options);
    expect(macros).toContain("#ifndef CTRL_REGS_H");
    expect(macros.trimEnd().endsWith("#endif /* CTRL_REGS_H */")).toBe(true);
  });

  it("widens the value before shifting in C _SET macros", () => {
    const macros = generate("c", register(), options);
    expect(macros).toContain(
      "((unsigned long long)(v) << CTRL_TYPE_POS) & CTRL_TYPE_MASK",
    );
    const small = new ValueModel({ width: 32 });
    small.addGroup(28, 31, "TOP");
    expect(generate("c", small, options)).toContain("((unsigned)(v) <<");
  });

  it("makes named-value names unique and keeps them off the field macros", () => {
    const lines = generate("c", register(), options)
      .split("\n")
      .filter((line) => line.startsWith("#define CTRL_TYPE_"));
    const names = lines.map((line) => line.split(/[ (]/)[1]);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("CTRL_TYPE_ON");
    expect(names).toContain("CTRL_TYPE_ON_2");
    expect(names).toContain("CTRL_TYPE_MASK_VAL");
  });
});

describe("export templates", () => {
  it("gives errors raised while printing the line they happened on", () => {
    expect(() => renderSource("first\n${fields}", { fields: [1] })).toThrow(
      "Line 2: Can't print a list",
    );
  });

  it("stops text that doubles in a loop", () => {
    const source =
      '@set s = "ab"\n@for item in items\n@set s = s + s\n@end\n${s.length}';
    try {
      renderSource(source, { items: Array.from({ length: 40 }, () => 0) });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError);
      expect((error as TemplateError).line).toBe(3);
    }
  });
});

describe("bytes", () => {
  it("reads Python escapes", () => {
    expect(parseBytes(String.raw`b'\n\t\\\'\x41\0\101'`)).toEqual([
      0x0a, 0x09, 0x5c, 0x27, 0x41, 0x00, 0x41,
    ]);
    expect(parseBytes(String.raw`b'\q'`)).toEqual([0x5c, 0x71]);
    expect(() => parseBytes("b'é'")).toThrow(/ASCII/);
  });
});
