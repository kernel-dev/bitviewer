// The value model: one value of 1 to 512 bits with its display settings,
// compare rows, register fields, snapshots and peripheral placement. No DOM,
// so it can be unit tested headless.
//
// Bit numbering is global: bit 0 is the LSB of the whole value. A *row* is
// the whole value ("line" view), a byte or a nibble, identified by its lowest
// bit index `lo` (see rows.ts). Fields (groups) are inclusive bit ranges
// [lo, hi] and may span rows. Every change notifies the listeners with the
// kind of change, so the card can redraw only what is needed.

import { type Base, isBase, maxValue } from "../format/integers";
import type { Template } from "../templates";
import {
  assignDetails,
  detailsFromJSON,
  type FieldDetails,
  fieldRange,
  type Group,
  isColor,
  newField,
  overlappingFields,
  sortFields,
  suggestFieldName,
} from "./group";
import { applyOp, type Op } from "./ops";
import {
  remapRowBases,
  remapRows,
  rowWidthFor,
  VIEWS,
  type View,
} from "./rows";
import { checkBase, checkWidth, MIN_WIDTH, ModelError } from "./validate";

/** Change kinds passed to listeners:
 *  value       bits of the value or a compare row changed
 *  format      a display base changed
 *  meta        the name changed
 *  group_meta  a group's name / colour / base changed
 *  groups      groups were added or removed
 *  structure   rows changed (view, order, compare rows added/removed) */
export type ChangeKind =
  | "value"
  | "format"
  | "meta"
  | "group_meta"
  | "groups"
  | "structure";
type Listener = (kind: ChangeKind) => void;

/** A named copy of a value at some moment. */
export interface Snapshot {
  name: string;
  value: bigint;
  at: number; // ms since epoch
}

export class ValueModel {
  width: number;
  value: bigint;
  name: string;
  view: View;
  msbFirst: boolean;
  fullBase: Base;
  defaultRowBase: Base;
  showBases = false; // optional panel with the value in every base
  collapsed = false; // card shows only its header
  /** Name of the peripheral this value is a register of ("" = none). */
  block = "";
  /** Address offset of the register within its peripheral, in bytes. */
  offset: bigint | null = null;
  /** What the register is for (e.g. from an SVD file). */
  description = "";
  snapshots: Snapshot[] = []; // named copies of the value, oldest first
  rowBases = new Map<number, Base>();
  groups: Group[] = [];
  compares = new Map<number, bigint>();
  /** Values of closed compare rows, restored when the row is opened again. */
  hiddenCompares = new Map<number, bigint>();
  private listeners: Listener[] = [];

  constructor(
    options: {
      width?: number;
      value?: bigint;
      name?: string;
      view?: View;
      msbFirst?: boolean;
      fullBase?: Base;
      defaultRowBase?: Base;
    } = {},
  ) {
    const width = options.width ?? 32;
    checkWidth(width);
    const view = options.view ?? "byte";
    if (!VIEWS.includes(view)) throw new ModelError(`Unknown view ${view}`);
    this.width = width;
    this.value = (options.value ?? 0n) & maxValue(width);
    this.name = options.name ?? "Value";
    this.view = view;
    this.msbFirst = options.msbFirst ?? true;
    this.fullBase = checkBase(options.fullBase ?? 16);
    this.defaultRowBase = checkBase(options.defaultRowBase ?? 16);
  }

  // ------------------------------------------------------------ listeners
  subscribe(callback: Listener): void {
    this.listeners.push(callback);
  }
  unsubscribe(callback: Listener): void {
    this.listeners = this.listeners.filter((listener) => listener !== callback);
  }
  private emit(kind: ChangeKind): void {
    for (const callback of [...this.listeners]) callback(kind);
  }

  // ------------------------------------------------------------ geometry
  get mask(): bigint {
    return maxValue(this.width);
  }
  /** Nominal row width for the view (the top row can be shorter). */
  get rowWidth(): number {
    return rowWidthFor(this.view, this.width);
  }
  /** Bits in the row starting at `lo`; only the top row can be partial. */
  rowWidthAt(lo: number): number {
    return Math.min(this.rowWidth, this.width - lo);
  }
  /** Row start bits in display order. */
  rowLos(): number[] {
    const rowStarts: number[] = [];
    for (let lo = 0; lo < this.width; lo += this.rowWidth) rowStarts.push(lo);
    return this.msbFirst ? rowStarts.reverse() : rowStarts;
  }
  rowTitle(lo: number): string {
    if (this.view === "line") return `Bits ${this.width - 1}…0`;
    return `${this.view === "byte" ? "Byte" : "Nibble"} ${lo / this.rowWidth}`;
  }
  /** Throws unless `lo` starts a row in the current view. */
  checkRow(lo: number): void {
    if (
      !Number.isInteger(lo) ||
      lo % this.rowWidth ||
      lo < 0 ||
      lo >= this.width
    ) {
      throw new ModelError(`${lo} is not a row start for this view`);
    }
  }
  private checkBit(bitIndex: number): void {
    if (bitIndex < 0 || bitIndex >= this.width)
      throw new ModelError(`Bit ${bitIndex} out of range`);
  }

  // ------------------------------------------------------------ meta / bases
  setName(name: string): void {
    if (name !== this.name) {
      this.name = name;
      this.emit("meta");
    }
  }
  setFullBase(base: Base): void {
    base = checkBase(base);
    if (base !== this.fullBase) {
      this.fullBase = base;
      this.emit("format");
    }
  }
  rowBase(lo: number): Base {
    return this.rowBases.get(lo) ?? this.defaultRowBase;
  }
  setRowBase(lo: number, base: Base): void {
    this.checkRow(lo);
    base = checkBase(base);
    if (this.rowBase(lo) !== base) {
      this.rowBases.set(lo, base);
      this.emit("format");
    }
  }
  setAllRowBases(base: Base): void {
    this.defaultRowBase = checkBase(base);
    this.rowBases.clear();
    this.emit("format");
  }

  // ------------------------------------------------------------ bits
  bit(bitIndex: number): number {
    return Number((this.value >> BigInt(bitIndex)) & 1n);
  }
  setValue(value: bigint): void {
    value &= this.mask;
    if (value !== this.value) {
      this.value = value;
      this.emit("value");
    }
  }
  flipBit(bitIndex: number): void {
    this.checkBit(bitIndex);
    this.setValue(this.value ^ (1n << BigInt(bitIndex)));
  }
  bitsValue(lo: number, width: number): bigint {
    return (this.value >> BigInt(lo)) & maxValue(width);
  }
  /** The whole value with bits lo … lo+width-1 replaced by `value` (nothing is changed). */
  withBits(lo: number, width: number, value: bigint): bigint {
    const mask = maxValue(width);
    const lowBig = BigInt(lo);
    return (
      ((this.value & ~(mask << lowBig)) | ((value & mask) << lowBig)) &
      this.mask
    );
  }
  setBitsValue(lo: number, width: number, value: bigint): void {
    this.setValue(this.withBits(lo, width, value));
  }
  rowValue(lo: number): bigint {
    return this.bitsValue(lo, this.rowWidthAt(lo));
  }
  setRowValue(lo: number, value: bigint): void {
    this.checkRow(lo);
    this.setBitsValue(lo, this.rowWidthAt(lo), value);
  }

  // ------------------------------------------------------------ operations
  opValue(operation: Op, argument?: bigint): void {
    this.setValue(applyOp(operation, this.value, this.width, argument));
  }
  opRow(lo: number, operation: Op, argument?: bigint): void {
    this.setRowValue(
      lo,
      applyOp(operation, this.rowValue(lo), this.rowWidthAt(lo), argument),
    );
  }
  opCompare(lo: number, operation: Op, argument?: bigint): void {
    this.setCompare(
      lo,
      applyOp(operation, this.compareValue(lo), this.rowWidthAt(lo), argument),
    );
  }
  /** Applies `op` to the bits lo..hi only (e.g. a selection). */
  opBits(lo: number, hi: number, operation: Op, argument?: bigint): void {
    const width = hi - lo + 1;
    this.setBitsValue(
      lo,
      width,
      applyOp(operation, this.bitsValue(lo, width), width, argument),
    );
  }

  // ------------------------------------------------------------ view / order
  setView(view: View): void {
    if (!VIEWS.includes(view)) throw new ModelError(`Unknown view ${view}`);
    if (view === this.view) return;
    const oldRowWidth = this.rowWidth;
    const newRowWidth = rowWidthFor(view, this.width);
    const remap = (rows: Map<number, bigint>) =>
      remapRows(this.value, this.width, rows, oldRowWidth, newRowWidth);
    const compares = remap(this.compares);
    const hidden = remap(this.hiddenCompares);
    for (const lo of compares.keys()) hidden.delete(lo); // an open row wins
    this.rowBases = remapRowBases(
      this.rowBases,
      this.width,
      oldRowWidth,
      newRowWidth,
    );
    this.view = view;
    this.compares = compares;
    this.hiddenCompares = hidden;
    this.emit("structure");
  }

  /** Smallest width that keeps every named field. */
  get minWidthForGroups(): number {
    return Math.max(MIN_WIDTH, ...this.groups.map((group) => group.hi + 1));
  }

  /** Resize the value. High bits are cut off (or added as 0) and compare rows
   *  that no longer fit are dropped. Named fields are never dropped implicitly:
   *  shrinking below a field is refused. */
  setWidth(width: number): void {
    checkWidth(width);
    if (width === this.width) return;
    const groupsBeyondWidth = this.groups.filter((group) => group.hi >= width);
    if (groupsBeyondWidth.length) {
      throw new ModelError(
        `Fields ${groupsBeyondWidth.map((group) => `${group.name} ${group.label()}`).join(", ")} don't fit in ${width} bits`,
      );
    }
    this.width = width;
    this.value &= this.mask;
    const rowWidth = this.rowWidth;
    const compares = new Map<number, bigint>();
    for (const [lo, value] of this.compares) {
      if (lo < width && lo % rowWidth === 0)
        compares.set(lo, value & maxValue(this.rowWidthAt(lo)));
    }
    this.compares = compares;
    const hidden = new Map<number, bigint>();
    for (const [lo, value] of this.hiddenCompares) {
      if (lo < width && lo % rowWidth === 0)
        hidden.set(lo, value & maxValue(this.rowWidthAt(lo)));
    }
    this.hiddenCompares = hidden;
    for (const lo of [...this.rowBases.keys()])
      if (lo >= width || lo % rowWidth) this.rowBases.delete(lo);
    this.emit("structure");
  }

  /** Fields that block `setWidth(width)`, and how many compare rows it would drop. */
  lostOnResize(width: number): { groups: Group[]; compares: number } {
    const rowWidth = rowWidthFor(this.view, width);
    return {
      groups: this.groups.filter((group) => group.hi >= width),
      compares: [...this.compares.keys()].filter(
        (lo) => lo >= width || lo % rowWidth,
      ).length,
    };
  }

  /** Puts the value in a peripheral at `offset` ("" takes it out). */
  setPeripheral(block: string, offset: bigint | null): void {
    if (offset !== null && offset < 0n)
      throw new ModelError("The offset can't be negative");
    if (block === this.block && offset === this.offset) return;
    this.block = block;
    this.offset = offset;
    this.emit("structure");
  }

  setDescription(description: string): void {
    if (description !== this.description) {
      this.description = description;
      this.emit("structure");
    }
  }

  setCollapsed(collapsed: boolean): void {
    if (collapsed !== this.collapsed) {
      this.collapsed = collapsed;
      this.emit("structure");
    }
  }

  /** Saves the current value under a name. */
  takeSnapshot(name: string, timestamp = Date.now()): Snapshot {
    const snapshot = {
      name: name.trim() || `Snapshot ${this.snapshots.length + 1}`,
      value: this.value,
      at: timestamp,
    };
    this.snapshots.push(snapshot);
    this.emit("meta");
    return snapshot;
  }

  removeSnapshot(snapshot: Snapshot): void {
    const index = this.snapshots.indexOf(snapshot);
    if (index >= 0) {
      this.snapshots.splice(index, 1);
      this.emit("meta");
    }
  }

  setShowBases(show: boolean): void {
    if (show !== this.showBases) {
      this.showBases = show;
      this.emit("structure");
    }
  }

  setMsbFirst(msbFirst: boolean): void {
    if (msbFirst !== this.msbFirst) {
      this.msbFirst = msbFirst;
      this.emit("structure");
    }
  }

  // ------------------------------------------------------------ compare rows
  hasCompare(lo: number): boolean {
    return this.compares.has(lo);
  }
  addCompare(lo: number): void {
    this.checkRow(lo);
    if (!this.compares.has(lo)) {
      // reopening restores the value the row had when it was closed
      this.compares.set(lo, this.hiddenCompares.get(lo) ?? this.rowValue(lo));
      this.hiddenCompares.delete(lo);
      this.emit("structure");
    }
  }

  /** Opens a compare row on every row, filled with the bits of `other`
   *  (e.g. another value, or a snapshot). Bits above this width are dropped. */
  compareWith(other: bigint): void {
    for (const lo of this.rowLos()) {
      this.compares.set(
        lo,
        (other >> BigInt(lo)) & maxValue(this.rowWidthAt(lo)),
      );
      this.hiddenCompares.delete(lo);
    }
    this.emit("structure");
  }

  /** Closes a compare row; its value is kept and comes back on reopen. */
  removeCompare(lo: number): void {
    const value = this.compares.get(lo);
    if (value === undefined) return;
    this.compares.delete(lo);
    this.hiddenCompares.set(lo, value);
    this.emit("structure");
  }
  compareValue(lo: number): bigint {
    const value = this.compares.get(lo);
    if (value === undefined) throw new ModelError("No compare row there");
    return value;
  }
  setCompare(lo: number, value: bigint): void {
    if (!this.compares.has(lo)) throw new ModelError("No compare row there");
    value &= maxValue(this.rowWidthAt(lo));
    if (value !== this.compares.get(lo)) {
      this.compares.set(lo, value);
      this.emit("value");
    }
  }
  compareBit(lo: number, bit: number): number {
    return Number((this.compareValue(lo) >> BigInt(bit - lo)) & 1n);
  }
  flipCompareBit(lo: number, bit: number): void {
    if (bit < lo || bit >= lo + this.rowWidthAt(lo))
      throw new ModelError("Bit outside the compare row");
    this.setCompare(lo, this.compareValue(lo) ^ (1n << BigInt(bit - lo)));
  }
  compareDiff(lo: number): bigint {
    return this.compareValue(lo) ^ this.rowValue(lo);
  }

  // ------------------------------------------------------------ groups
  groupAt(bit: number): Group | undefined {
    return this.groups.find((group) => group.lo <= bit && bit <= group.hi);
  }
  overlapping(lo: number, hi: number): Group[] {
    return overlappingFields(this.groups, lo, hi);
  }
  suggestGroupName(): string {
    return suggestFieldName(this.groups);
  }
  addGroup(
    lo: number,
    hi: number,
    name?: string,
    color?: string,
    base?: Base,
  ): Group {
    const group = this.addGroupQuiet(lo, hi, name, color, base);
    this.emit("groups");
    return group;
  }
  /** addGroup without the change notification (for batch updates). */
  private addGroupQuiet(
    lo: number,
    hi: number,
    name?: string,
    color?: string,
    base?: Base,
  ): Group {
    const group = newField(this.groups, this.width, lo, hi, name, color, base);
    this.groups.push(group);
    sortFields(this.groups);
    return group;
  }
  removeGroup(group: Group): void {
    const index = this.groups.indexOf(group);
    if (index >= 0) {
      this.groups.splice(index, 1);
      this.emit("groups");
    }
  }
  /** Moves a field's edges, e.g. to widen a 4-bit field to 8 bits. Other fields stay put. */
  resizeGroup(group: Group, lo: number, hi: number): void {
    [lo, hi] = fieldRange(this.groups, this.width, lo, hi, group);
    if (lo === group.lo && hi === group.hi) return;
    group.lo = lo;
    group.hi = hi;
    sortFields(this.groups);
    this.emit("groups");
  }
  updateGroup(
    group: Group,
    changes: { name?: string; color?: string; base?: Base },
  ): void {
    let changed = false;
    if (changes.name !== undefined && changes.name !== group.name) {
      group.name = changes.name;
      changed = true;
    }
    if (changes.color !== undefined && changes.color !== group.color) {
      if (!isColor(changes.color))
        throw new ModelError(`Not a colour: ${changes.color}`);
      group.color = changes.color;
      changed = true;
    }
    if (changes.base !== undefined && checkBase(changes.base) !== group.base) {
      group.base = changes.base;
      changed = true;
    }
    if (changed) this.emit("group_meta");
  }
  /** Replaces a field's details (signedness, formula, named values, …). */
  setGroupDetails(group: Group, details: Partial<FieldDetails>): void {
    assignDetails(group, details);
    this.emit("groups"); // the fields panel shows these, so rebuild it
  }

  /** Replaces all fields with a template's. Call only with the user's go-ahead:
   *  it removes the current fields. Refuses if a template field doesn't fit. */
  applyTemplate(template: Template): void {
    const tooWide = template.fields.filter((field) => field.hi >= this.width);
    if (tooWide.length)
      throw new ModelError(
        `The template needs ${template.width} bits; this value has ${this.width}`,
      );
    const previousGroups = this.groups;
    this.groups = [];
    try {
      for (const field of template.fields) {
        const group = this.addGroupQuiet(
          field.lo,
          field.hi,
          field.name,
          field.color,
          isBase(field.base) ? field.base : undefined,
        );
        assignDetails(group, detailsFromJSON(field));
      }
    } catch (error) {
      this.groups = previousGroups; // all or nothing
      throw error;
    }
    this.emit("groups");
  }
  groupValue(group: Group): bigint {
    return this.bitsValue(group.lo, group.width);
  }
  setGroupValue(group: Group, value: bigint): void {
    this.setBitsValue(group.lo, group.width, value);
  }
}
