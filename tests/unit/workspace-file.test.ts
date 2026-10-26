import { describe, expect, it } from "vitest";
import { ModelError, ValueModel, valueToJSON } from "../../src/core/model";
import {
  FILE_VERSION,
  parseWorkspaceFile,
  workspaceFileText,
} from "../../src/core/workspace-file";

describe("workspace file", () => {
  it("round-trips values and peripherals", () => {
    const model = new ValueModel({ width: 16, value: 0xbeefn, name: "CTRL" });
    const text = workspaceFileText({
      values: [valueToJSON(model)],
      peripherals: [{ name: "UART0", base: "0x40011000" }],
    });
    const file = parseWorkspaceFile(text);
    expect(file.version).toBe(FILE_VERSION);
    expect(file.values).toEqual([valueToJSON(model)]);
    expect(file.peripherals).toEqual([{ name: "UART0", base: "0x40011000" }]);
  });

  it("reads files without a version or values as version 1, empty", () => {
    expect(parseWorkspaceFile('{"app":"bitviewer"}')).toEqual({
      version: 1,
      values: [],
      peripherals: undefined,
    });
  });

  it("keeps a newer version number so the app can warn", () => {
    expect(
      parseWorkspaceFile('{"app":"bitviewer","version":7,"values":[]}').version,
    ).toBe(7);
  });

  it("rejects other files and broken entries before anything is loaded", () => {
    expect(() => parseWorkspaceFile('{"app":"other"}')).toThrow(ModelError);
    expect(() => parseWorkspaceFile("not json")).toThrow(SyntaxError);
    expect(() => parseWorkspaceFile('{"app":"bitviewer","version":0}')).toThrow(
      ModelError,
    );
    expect(() => parseWorkspaceFile('{"app":"bitviewer","values":{}}')).toThrow(
      ModelError,
    );
    expect(() =>
      parseWorkspaceFile('{"app":"bitviewer","values":[{"name":"x"}]}'),
    ).toThrow(ModelError);
  });
});
