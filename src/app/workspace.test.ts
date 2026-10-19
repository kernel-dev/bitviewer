import { describe, expect, it } from "vitest";
import { ValueModel } from "../core/model";
import { matchKey } from "./commands";
import { score } from "./palette";
import { matchValue } from "./search";

describe("command palette ranking", () => {
  it("needs every word and prefers label prefixes", () => {
    expect(score("Export code…", "c rust python Value", "export")).toBeGreaterThan(score("Save as…", "", "export"));
    expect(score("Save as…", "", "export")).toBe(-1);
    expect(score("Swap bytes", "endian bswap Value", "endian")).toBeGreaterThan(0);
    expect(score("Swap bytes", "endian", "swap endian")).toBeGreaterThan(score("Swap bytes", "endian", "endian"));
    expect(score("Zoom in", "", "")).toBe(0);
    expect(score("Add 64-bit value", "", "64")).toBeGreaterThan(0);
  });
});

describe("search", () => {
  const m = new ValueModel({ width: 32, value: 0xdeadbeefn, name: "STATUS" });
  const g = m.addGroup(0, 3, "IRQ_PENDING");
  m.setGroupDetails(g, { description: "Interrupt waiting", named: [{ value: 1n, label: "Timer" }] });
  m.takeSnapshot("after boot");

  it("matches names, fields, descriptions, named values, snapshots and hex", () => {
    expect(matchValue(m, "").hit).toBe(true);
    expect(matchValue(m, "status").hit).toBe(true);
    expect([...matchValue(m, "irq").fields]).toEqual(["IRQ_PENDING"]);
    expect([...matchValue(m, "interrupt").fields]).toEqual(["IRQ_PENDING"]);
    expect([...matchValue(m, "timer").fields]).toEqual(["IRQ_PENDING"]);
    expect(matchValue(m, "boot").hit).toBe(true);
    expect(matchValue(m, "beef").hit).toBe(true);
    expect(matchValue(m, "0xdead_beef").hit).toBe(true);
    expect(matchValue(m, "nothing").hit).toBe(false);
  });
});

describe("shortcuts", () => {
  // tests run without a DOM; matchKey only reads these fields
  const key = (init: Partial<KeyboardEvent>) =>
    ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...init }) as KeyboardEvent;
  it("matches modifiers exactly", () => {
    expect(matchKey("Ctrl+K", key({ key: "k", code: "KeyK", ctrlKey: true }))).toBe(true);
    expect(matchKey("Ctrl+K", key({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(matchKey("Ctrl+Shift+P", key({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchKey("Ctrl+1", key({ key: "!", code: "Digit1", ctrlKey: true }))).toBe(true);
    expect(matchKey("Ctrl++", key({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchKey("F1", key({ key: "F1", code: "F1" }))).toBe(true);
    expect(matchKey("Esc", key({ key: "Escape", code: "Escape" }))).toBe(true);
  });
});
