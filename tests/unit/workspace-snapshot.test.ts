import { describe, expect, it } from "vitest";
import {
  makeSnapshot,
  sameSnapshot,
  snapshotCost,
  snapshotTexts,
} from "../../src/core/workspace-snapshot";

const texts = (count: number, prefix = "v") =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);

describe("workspace snapshots", () => {
  it("keeps every text in order", () => {
    const all = texts(1000);
    const snapshot = makeSnapshot(all, "[]");
    expect(snapshot.length).toBe(1000);
    expect(snapshotTexts(snapshot)).toEqual(all);
    expect(snapshotTexts(makeSnapshot([], "[]"))).toEqual([]);
  });

  it("shares the chunks that didn't change", () => {
    const all = texts(1000);
    const first = makeSnapshot(all, "[]");
    const edited = [...all];
    edited[700] = "changed";
    const second = makeSnapshot(edited, "[]", first);

    const shared = second.chunks.filter(
      (chunk, index) => chunk === first.chunks[index],
    );
    expect(shared.length).toBe(first.chunks.length - 1);
    expect(second.chunks[2]).not.toBe(first.chunks[2]);
    expect(snapshotTexts(second)[700]).toBe("changed");
  });

  it("tells equal workspaces apart from different ones", () => {
    const all = texts(600);
    const first = makeSnapshot(all, "[]");
    expect(sameSnapshot(first, makeSnapshot([...all], "[]"))).toBe(true);
    expect(sameSnapshot(first, makeSnapshot(all, '[{"name":"P"}]'))).toBe(
      false,
    );
    expect(sameSnapshot(first, makeSnapshot(all.slice(1), "[]"))).toBe(false);
    const edited = [...all];
    edited[0] = "x";
    expect(sameSnapshot(first, makeSnapshot(edited, "[]"))).toBe(false);
    expect(sameSnapshot(first, null)).toBe(false);
    expect(sameSnapshot(null, null)).toBe(true);
  });

  it("costs a few kilobytes for one edit, a full copy for a whole change", () => {
    const all = texts(90_000);
    const first = makeSnapshot(all, "[]");
    const edited = [...all];
    edited[5] = "changed";
    const oneEdit = makeSnapshot(edited, "[]", first);
    expect(snapshotCost(oneEdit, first, 1000)).toBeLessThan(10_000);

    const everything = makeSnapshot(texts(90_000, "w"), "[]", first);
    expect(snapshotCost(everything, first, 90_000_000)).toBeGreaterThan(
      90_000_000,
    );
  });
});
