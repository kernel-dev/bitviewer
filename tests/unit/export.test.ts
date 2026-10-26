import { describe, expect, it } from "vitest";
import {
  BUILTIN_EXPORTS,
  customExport,
  generate,
  renderExport,
  usesWords,
} from "../../src/core/export/codegen";
import { exportContext } from "../../src/core/export/register-data";
import { ValueModel } from "../../src/core/model";

const options = { prefix: "CTRL", includeValue: false };

/** A 64-bit register with a field in each half and one straddling bit 31/32. */
function wide() {
  const model = new ValueModel({
    width: 64,
    value: 0x1122_3344_5566_7788n,
    name: "Ctrl",
  });
  model.addGroup(0, 3, "LOW");
  model.addGroup(28, 35, "MID"); // crosses the 32-bit boundary
  model.addGroup(60, 63, "TOP");
  return model;
}

describe("register words", () => {
  it("keeps a register that fits in one word as one word", () => {
    const model = new ValueModel({ width: 16 });
    model.addGroup(0, 3, "A");
    const word = (
      exportContext(model, { ...options, platform: 32 }).words as any[]
    )[0];
    expect([word.name, word.suffix, word.storage, word.width]).toEqual([
      "",
      "",
      16,
      16,
    ]);
  });

  it("splits into lower and upper on a 32-bit platform, one word on a 64-bit one", () => {
    const model = wide();
    const two = exportContext(model, { ...options, platform: 32 })
      .words as any[];
    expect(
      two.map((word) => [
        word.name,
        word.suffix,
        word.member,
        word.lo,
        word.hi,
        word.value.hex,
      ]),
    ).toEqual([
      ["lower", "_lower", "lower", 0, 31, "0x55667788"],
      ["upper", "_upper", "upper", 32, 63, "0x11223344"],
    ]);
    const one = exportContext(model, { ...options, platform: 64 })
      .words as any[];
    expect(one.map((word) => [word.name, word.storage])).toEqual([["", 64]]);
  });

  it("numbers the words when there are more than two", () => {
    const model = new ValueModel({ width: 100 });
    const words = exportContext(model, { ...options, platform: 32 })
      .words as any[];
    expect(words.map((word) => [word.name, word.width, word.storage])).toEqual([
      ["1", 32, 32],
      ["2", 32, 32],
      ["3", 32, 32],
      ["4", 4, 8],
    ]);
  });

  it("splits a field that crosses a word boundary into parts", () => {
    const [lower, upper] = exportContext(wide(), { ...options, platform: 32 })
      .words as any[];
    const lowerPart = lower.fields.find(
      (field: any) => field.field_id === "MID",
    );
    const upperPart = upper.fields.find(
      (field: any) => field.field_id === "MID",
    );
    expect([
      lowerPart.id,
      lowerPart.partial,
      lowerPart.part,
      lowerPart.parts,
      lowerPart.lo,
      lowerPart.hi,
      lowerPart.bit,
      lowerPart.width,
    ]).toEqual(["MID_PART1", true, 1, 2, 28, 31, 28, 4]);
    expect([
      upperPart.id,
      upperPart.part,
      upperPart.lo,
      upperPart.hi,
      upperPart.bit,
      upperPart.width,
    ]).toEqual(["MID_PART2", 2, 32, 35, 0, 4]);
    expect(lowerPart.comment).toContain("part 1 of 2");
  });

  it("pads each word with gaps up to its storage size", () => {
    const [lower] = exportContext(wide(), { ...options, platform: 32 })
      .words as any[];
    expect(lower.items.map((item: any) => [item.gap, item.range])).toEqual([
      [false, "[3:0]"],
      [true, "[27:4]"],
      [false, "[31:28]"],
    ]);
  });
});

describe("C struct export on different platforms", () => {
  it("writes lower and upper structs for a 64-bit register on a 32-bit platform", () => {
    const structCode = generate("cstruct", wide(), {
      ...options,
      platform: 32,
    });
    expect(structCode).toContain("} ctrl_lower_t;");
    expect(structCode).toContain("} ctrl_upper_t;");
    expect(structCode).toContain("/* lower word: bits [31:0] */");
    expect(structCode).toMatch(/uint32_t\s+MID_PART1\s+:\s+4;/);
    expect(structCode).toMatch(/uint32_t\s+MID_PART2\s+:\s+4;/);
    expect(structCode).toContain("ctrl_lower_t lower;");
    expect(structCode).toContain("} ctrl_t;");
  });

  it("writes one struct on a 64-bit platform, with the field in one piece", () => {
    const structCode = generate("cstruct", wide(), {
      ...options,
      platform: 64,
    });
    expect(structCode).toContain("uint64_t raw;");
    expect(structCode).toContain("} ctrl_t;");
    expect(structCode).not.toContain("_lower");
    expect(structCode).toMatch(/uint64_t\s+MID\s+:\s+8;/);
  });

  it("gives each word its own value constant", () => {
    const structCode = generate("cstruct", wide(), {
      ...options,
      includeValue: true,
      platform: 32,
    });
    expect(structCode).toContain("#define CTRL_VALUE_LOWER 0x55667788U");
    expect(structCode).toContain("#define CTRL_VALUE_UPPER 0x11223344U");
  });

  it("numbers the words of a very wide register", () => {
    const model = new ValueModel({ width: 100, name: "Big" });
    model.addGroup(0, 7, "A");
    const structCode = generate("cstruct", model, {
      prefix: "BIG",
      includeValue: false,
      platform: 32,
    });
    expect(structCode).toContain("} big_1_t;");
    expect(structCode).toContain("} big_4_t;");
    expect(structCode).toContain("uint8_t raw;"); // the last word has only 4 bits
    expect(structCode).toContain("big_3_t word3;");
  });
});

describe("numbers in several bases", () => {
  const model = new ValueModel({ width: 16, value: 0x7fffn, name: "Ctrl" });
  model.addGroup(0, 3, "LOW");
  const group = model.addGroup(8, 11, "MODE");
  model.setGroupDetails(group, { named: [{ value: 5n, label: "Five" }] });
  const render = (source: string) =>
    renderExport(source, model, { prefix: "CTRL", includeValue: true });

  it("gives the value as .hex, .bin, .dec and .oct, padded to its width in binary", () => {
    expect(render("${value.hex} ${value.bin} ${value.dec} ${value.oct}")).toBe(
      "0x7FFF 0b0111111111111111 32767 0o77777\n",
    );
  });

  it("still prints a number on its own as hex, so ${value} keeps working", () => {
    expect(render('${value} ${value | lower} ${value + "!"}')).toBe(
      "0x7FFF 0x7fff 0x7FFF!\n",
    );
  });

  it("does the same for a field's own value, its mask and its named values", () => {
    const source =
      "@for field in fields\n${field.id} ${field.value.bin} ${field.shifted_mask.bin}\n@for named_value in field.named\n  ${named_value.id} ${named_value.value.bin} ${named_value.value.dec}\n@end\n@end";
    expect(render(source)).toBe(
      "LOW 0b1111 0b0000000000001111\nMODE 0b1111 0b0000111100000000\n  FIVE 0b0101 5\n",
    );
  });

  it("tells you what is available when you ask for something else", () => {
    expect(() => render("${value.binary}")).toThrow(
      /has no "binary" \(it has: hex, bin, dec, oct\)/,
    );
  });
});

describe("custom templates", () => {
  const source = `@name Plain
@ext txt
\${name} (\${width} bits, \${platform}-bit words)
@for field in fields | reverse
  \${field.id} \${field.range} \${field.crosses}
@end
`;

  it("renders against the same data as the built-ins", () => {
    expect(renderExport(source, wide(), { ...options, platform: 32 })).toBe(
      "Ctrl (64 bits, 32-bit words)\n  TOP [63:60] false\n  MID [35:28] true\n  LOW [3:0] false\n",
    );
  });

  it("reads its label and extension from the file", () => {
    const template = customExport({
      name: "Plain",
      extension: ".md",
      source: source,
    });
    expect([
      template.id,
      template.name,
      template.extension,
      template.builtin,
    ]).toEqual(["custom:plain", "Plain", "md", false]);
  });

  it("knows which templates care about the register width", () => {
    expect(usesWords(source)).toBe(true);
    expect(usesWords("@for field in fields\n${field.id}\n@end")).toBe(false);
    expect(
      BUILTIN_EXPORTS.filter((template) => usesWords(template.source)).map(
        (template) => template.id,
      ),
    ).toEqual(["cstruct"]);
  });
});
