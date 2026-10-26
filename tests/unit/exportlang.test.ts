import { describe, expect, it } from "vitest";
import {
  compileTemplate,
  Num,
  renderSource,
  TemplateError,
} from "../../src/core/export/language";

const context = {
  name: "Ctrl",
  width: 32,
  flag: true,
  fields: [
    { id: "EN", lo: 0, signed: false, named: [] },
    { id: "MODE", lo: 4, signed: true, named: [{ id: "OFF" }, { id: "AUTO" }] },
  ],
  none: [],
  zero: Num.of(0n, 8),
  five: Num.of(5n, 8),
};
const render = (source: string) => renderSource(source, context);

describe("export template language", () => {
  it("prints values, strings and arithmetic", () => {
    expect(render("${name} is ${width} bits")).toBe("Ctrl is 32 bits\n");
    expect(render('${"a" + name} ${width + 1} ${width - 2}')).toBe(
      "aCtrl 33 30\n",
    );
    expect(render("${fields.length} fields, first ${fields.length - 1}")).toBe(
      "2 fields, first 1\n",
    );
  });

  it("applies filters", () => {
    expect(render("${name | upper}|${name | lower}")).toBe("CTRL|ctrl\n");
    expect(
      render('[${name | pad(6)}][${width | padl(4)}][${name | pad(6, ".")}]'),
    ).toBe("[Ctrl  ][  32][Ctrl..]\n");
    expect(render("${none | default(name)}")).toBe("Ctrl\n");
    expect(render('${fields.length | default("x")}')).toBe("2\n");
  });

  it("loops, with loop info and an empty case", () => {
    expect(
      render(
        "@for field in fields\n${loop.index}/${loop.count} ${field.id}${loop.last}\n@end",
      ),
    ).toBe("1/2 ENfalse\n2/2 MODEtrue\n");
    expect(render("@for field in none\nx\n@else\nnothing\n@end")).toBe(
      "nothing\n",
    );
    expect(render("@for field in fields | reverse\n${field.id}\n@end")).toBe(
      "MODE\nEN\n",
    );
  });

  it("branches", () => {
    const branchTemplate =
      "@for field in fields\n@if field.signed and field.lo > 2\n${field.id} signed\n@elif field.lo == 0\n${field.id} zero\n@else\n?\n@end\n@end";
    expect(render(branchTemplate)).toBe("EN zero\nMODE signed\n");
    expect(render("@if not flag\nno\n@else\nyes\n@end")).toBe("yes\n");
    expect(render("@if none\nfull\n@else\nempty\n@end")).toBe("empty\n");
  });

  it("sets variables, also from inside a branch", () => {
    expect(
      render(
        '@set integer_suffix = "U"\n@if width > 16\n@set integer_suffix = "ULL"\n@end\nx${integer_suffix}',
      ),
    ).toBe("xULL\n");
  });

  it("keeps instructions out of the output and strips trailing spaces", () => {
    expect(
      render("@# note\n@name Thing\nkeep   \n  @if flag\n  indented\n  @end"),
    ).toBe("keep\n  indented\n");
    expect(
      compileTemplate("@name C macros\n@ext h\n@about Some text").meta,
    ).toEqual({
      name: "C macros",
      extension: "h",
      about: "Some text",
    });
  });

  it("passes @ and ${ through when asked, or when it isn't an instruction", () => {
    expect(render("@property\n@@for literal\n$${not filled}")).toBe(
      "@property\n@for literal\n${not filled}\n",
    );
  });

  it("reports mistakes with a line number", () => {
    const errorMessage = (source: string) => {
      try {
        render(source);
      } catch (error) {
        if (error instanceof TemplateError) return error.message;
        throw error;
      }
      return "";
    };
    expect(errorMessage("ok\n${nope}")).toBe('Line 2: Unknown name "nope"');
    expect(errorMessage("${fields.size}")).toContain('has no "size"');
    expect(errorMessage("@for field in fields\nx")).toBe(
      "Line 1: @for is never closed with @end",
    );
    expect(errorMessage("a\n@end")).toContain("Line 2: @end without");
    expect(errorMessage("${name | shout}")).toContain('Unknown filter "shout"');
    expect(errorMessage("${width +}")).toContain("ends too early");
    expect(errorMessage("${name")).toContain("Missing }");
    expect(errorMessage("@for field in name\nx\n@end")).toContain(
      "needs a list",
    );
    expect(errorMessage("${fields}")).toContain("Can't print a list");
    expect(errorMessage("@if flag\na\n@else\nb\n@else\nc\n@end")).toContain(
      "already has an @else",
    );
  });

  it("compares and tests numbers from the export data", () => {
    expect(render("@if zero == 0\nzero\n@end\n@if five != 0\nfive\n@end")).toBe(
      "zero\nfive\n",
    );
    expect(render("@if zero\nyes\n@else\nno\n@end")).toBe("no\n");
    expect(render("@if five > 4 and five <= 5\nin range\n@end")).toBe(
      "in range\n",
    );
    expect(render("${five + 1} ${five - 1}")).toBe("6 4\n");
  });

  it("reads hex literals", () => {
    expect(render("${0x10 + 1}")).toBe("17\n");
  });

  it("keeps @set values after the loop and between iterations", () => {
    expect(
      render(
        "@set count = 0\n@for field in fields\n@set count = count + 1\n@set last = field.id\n@end\n${count} ${last}",
      ),
    ).toBe("2 MODE\n");
  });

  it("treats @name-style text as output, not a directive", () => {
    expect(render("@name-of-thing\n@set-foo")).toBe(
      "@name-of-thing\n@set-foo\n",
    );
  });

  it("refuses absurd padding", () => {
    expect(() => render("${name | pad(1000000000000)}")).toThrow(TemplateError);
  });
});
