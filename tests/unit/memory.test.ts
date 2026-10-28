// Undo history, value texts and the session file: what keeps large
// workspaces small in memory.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { History } from "../../src/app/history";
import {
  type TextPool,
  ValueModel,
  valueFromJSON,
  valueText,
} from "../../src/core/model";
import {
  makeSnapshot,
  snapshotTexts,
  type WorkspaceSnapshot,
} from "../../src/core/workspace-snapshot";
import { sessionText } from "../../src/platform/session";
import stm32Text from "../../test-data/stm32f407-all.bitview?raw";

describe("value texts", () => {
  it("are made again only after the value changes", () => {
    const model = new ValueModel({ width: 16, value: 5n, name: "A" });
    const first = valueText(model);
    expect(valueText(model)).toBe(first);
    model.setValue(6n);
    const second = valueText(model);
    expect(second).not.toBe(first);
    expect(JSON.parse(second).value).toBe("0x6");
  });

  it("read back to the same text, so an undo step's string can stand for its value", () => {
    const file = JSON.parse(stm32Text);
    for (const json of file.values) {
      const text = valueText(valueFromJSON(json));
      expect(valueText(valueFromJSON(JSON.parse(text)))).toBe(text);
    }
  });

  it("share repeated texts when read with one pool", () => {
    const pool: TextPool = new Map();
    const json = {
      width: 8,
      description: "Control register",
      groups: [
        { lo: 0, hi: 0, name: "EN", color: "#f59f00", description: "Enable" },
      ],
    };
    valueFromJSON(json, pool);
    valueFromJSON(json, pool);
    expect([...pool.keys()].sort()).toEqual([
      "",
      "#f59f00",
      "Control register",
      "EN",
      "Enable",
    ]);
  });
});

describe("session file", () => {
  it("is valid JSON put together from the value texts", () => {
    const text = sessionText(
      {
        path: "C:\\work\\a.bitview",
        fileName: "a.bitview",
        dirty: true,
        valueTexts: ['{"width":8}', '{"width":16}'],
        peripheralsText: '[{"name":"P"}]',
      },
      42,
    );
    expect(JSON.parse(text)).toEqual({
      version: 1,
      path: "C:\\work\\a.bitview",
      fileName: "a.bitview",
      dirty: true,
      savedAt: 42,
      values: [{ width: 8 }, { width: 16 }],
      peripherals: [{ name: "P" }],
    });
  });

  it("holds only the path when the file has everything", () => {
    const text = sessionText({
      path: "a.bitview",
      fileName: "a.bitview",
      dirty: false,
      valueTexts: null,
      peripheralsText: "",
    });
    expect(JSON.parse(text)).toMatchObject({ values: null, peripherals: null });
  });
});

describe("undo history", () => {
  beforeAll(() => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("HTMLInputElement", class {});
  });

  /** A workspace of plain texts, edited directly. */
  function setup(count: number, budget?: number) {
    let texts = Array.from({ length: count }, (_, index) => `value ${index}`);
    const history = new History(
      (previous: WorkspaceSnapshot | null) =>
        makeSnapshot(texts, "[]", previous),
      (snapshot) => {
        texts = snapshotTexts(snapshot);
      },
      () => {},
      budget,
    );
    history.reset();
    const edit = (index: number, text: string) => {
      texts = [...texts];
      texts[index] = text;
      history.touch();
      history.flush();
    };
    return { history, edit, texts: () => texts };
  }

  it("undoes and redoes edits", () => {
    const { history, edit, texts } = setup(1000);
    edit(10, "a");
    edit(900, "b");
    expect(history.undo()).toBe(true);
    expect(texts()[900]).toBe("value 900");
    expect(texts()[10]).toBe("a");
    expect(history.undo()).toBe(true);
    expect(texts()[10]).toBe("value 10");
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(true);
    expect(texts()[10]).toBe("a");
  });

  it("records nothing when nothing changed", () => {
    const { history, edit } = setup(10);
    edit(0, "value 0");
    expect(history.canUndo).toBe(false);
  });

  it("shares unchanged parts between steps", () => {
    const { history, edit } = setup(90_000);
    const before = history.snapshot!;
    edit(5, "changed");
    const after = history.snapshot!;
    const shared = after.chunks.filter(
      (chunk, index) => chunk === before.chunks[index],
    );
    expect(shared.length).toBe(before.chunks.length - 1);
  });

  it("drops the oldest steps past its memory budget, but keeps the newest", () => {
    // each step here costs about a new chunk list: 4 chunks of 8-byte pointers
    // plus the changed chunk (256 × 8), so a budget of 5 kB keeps two steps
    const { history, edit } = setup(1000, 5_000);
    for (let step = 0; step < 6; step++) edit(step, `step ${step}`);
    let undos = 0;
    while (history.undo()) undos++;
    expect(undos).toBe(2);

    const tiny = setup(1000, 1);
    tiny.edit(0, "x");
    tiny.edit(1, "y");
    expect(tiny.history.undo()).toBe(true);
    expect(tiny.history.undo()).toBe(false);
  });
});
