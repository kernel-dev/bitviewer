import { describe, expect, it } from "vitest";
import { BitSelection } from "../../src/card/selection";

describe("bit selection", () => {
  it("drags from the anchor in either direction", () => {
    const selection = new BitSelection();
    expect(selection.drag(3)).toBe(false); // no drag started
    selection.begin(5);
    expect(selection.drag(2)).toBe(true);
    expect(selection.range).toEqual([2, 5]);
    selection.drag(9);
    expect(selection.range).toEqual([5, 9]);
  });

  it("extends with Shift+click from the selection's start", () => {
    const selection = new BitSelection();
    selection.set(4, 7);
    selection.extend(12);
    expect(selection.range).toEqual([4, 12]);
  });

  it("extends with Shift+arrows from the end away from the cursor", () => {
    const selection = new BitSelection();
    selection.set(4, 7);
    // the cursor is on bit 4, the low end: the high end stays put
    selection.extendFromCursor(4, 3);
    expect(selection.range).toEqual([3, 7]);
  });

  it("selects whole rows, and with Shift every row in between", () => {
    const selection = new BitSelection();
    const top = (lo: number) => lo + 7;
    selection.selectRows(8, false, top);
    expect(selection.range).toEqual([8, 15]);
    selection.selectRows(24, true, top);
    expect(selection.range).toEqual([8, 31]);
    selection.selectRows(0, true, top);
    expect(selection.range).toEqual([0, 15]);
  });

  it("reports whether clearing removed anything", () => {
    const selection = new BitSelection();
    expect(selection.clear()).toBe(false);
    selection.set(1, 2);
    expect(selection.clear()).toBe(true);
    expect(selection.range).toBeNull();
  });
});
