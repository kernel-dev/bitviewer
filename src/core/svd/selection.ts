// Which copies of a register array are picked: a set of positions kept as
// ranges, so "all 4 billion" costs as little as "copy 3".

import type { SvdRegister, SvdRegisterArray } from "./types";

/** Positions 0 … limit-1, stored as sorted, separate [start, end) ranges. */
export class IndexSet {
  private ranges: [number, number][] = [];

  constructor(readonly limit: number) {}

  /** Every position. */
  static all(limit: number): IndexSet {
    const set = new IndexSet(limit);
    set.setRange(0, limit, true);
    return set;
  }

  /** Reads "0-15, 32, 40-47" (positions counted from 0). Returns the
   *  problem as text when it can't. */
  static parse(text: string, limit: number): IndexSet | string {
    const set = new IndexSet(limit);
    const parts = text
      .replace(/\s*-\s*/g, "-")
      .split(/[,\s]+/)
      .filter(Boolean);

    for (const part of parts) {
      const match = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!match) return `"${part}" is not a position or a range like 0-7`;
      const first = Number(match[1]);
      const last = match[2] === undefined ? first : Number(match[2]);
      if (last < first) return `${part} runs backwards`;
      if (last >= limit) return `${last} is past the last copy (${limit - 1})`;
      set.setRange(first, last + 1, true);
    }

    return set;
  }

  get size(): number {
    return this.ranges.reduce((total, [start, end]) => total + end - start, 0);
  }

  has(position: number): boolean {
    return this.ranges.some(
      ([start, end]) => position >= start && position < end,
    );
  }

  /** Picks (or unpicks) positions start … end-1. */
  setRange(start: number, end: number, on: boolean) {
    start = Math.max(0, start);
    end = Math.min(this.limit, end);
    if (start >= end) return;
    const next: [number, number][] = [];

    for (const [from, to] of this.ranges) {
      if (to <= start || from >= end) {
        next.push([from, to]);
        continue;
      }

      if (from < start) next.push([from, start]);
      if (to > end) next.push([end, to]);
    }

    if (on) next.push([start, end]);
    next.sort((first, second) => first[0] - second[0]);
    this.ranges = [];

    for (const range of next) {
      const last = this.ranges[this.ranges.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else this.ranges.push([range[0], range[1]]);
    }
  }

  set(position: number, on: boolean) {
    this.setRange(position, position + 1, on);
  }

  /** Picks everything, or nothing. */
  fill(on: boolean) {
    this.ranges = on && this.limit > 0 ? [[0, this.limit]] : [];
  }

  *[Symbol.iterator](): Iterator<number> {
    for (const [start, end] of this.ranges)
      for (let position = start; position < end; position++) yield position;
  }

  /** As the user types it: "0-15, 32". */
  toString(): string {
    return this.ranges
      .map(([start, end]) =>
        end - start === 1 ? String(start) : `${start}-${end - 1}`,
      )
      .join(", ");
  }
}

/** Registers sorted the way the file lists them: CH0.CFG, CH0.STAT, CH1.CFG… */
export function inFileOrder(registers: SvdRegister[]): SvdRegister[] {
  return [...registers].sort((first, second) => {
    const length = Math.min(first.order.length, second.order.length);
    for (let index = 0; index < length; index++) {
      const difference = first.order[index] - second.order[index];
      if (difference) return difference;
    }
    return first.order.length - second.order.length;
  });
}

/** The picked copies of each array, made into registers, in file order. */
export function pickedRegisters(
  picks: { array: SvdRegisterArray; positions: IndexSet }[],
): SvdRegister[] {
  const registers: SvdRegister[] = [];

  for (const { array, positions } of picks)
    for (const position of positions) registers.push(array.at(position));

  return inFileOrder(registers);
}
