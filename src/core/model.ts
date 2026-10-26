// Value model: no DOM, so it can be unit tested headless.
//
// Bit numbering is global: bit 0 is the LSB of the whole value (1 to 512 bits).
// A *row* is the whole value ("line" view), a byte or a nibble, identified by
// its lowest bit index `lo`. Groups are inclusive bit ranges [lo, hi] and may
// span rows.

import { type Base, isBase, maxValue } from "./numfmt";
import type { Template } from "./templates";

export const GROUP_COLORS = [
  "#f59f00",
  "#2fb344",
  "#ae3ec9",
  "#15aabf",
  "#4c6ef5",
  "#82c91e",
  "#f76707",
  "#868e96",
];
export type View = "line" | "byte" | "nibble";
export const MIN_WIDTH = 1;
export const MAX_WIDTH = 512;
export const VIEWS: readonly View[] = ["line", "byte", "nibble"];
const VIEW_WIDTHS: Partial<Record<View, number>> = { byte: 8, nibble: 4 };
/** Operations on a value / row. Shifts and rotates take an amount (default 1);
 *  and / or / xor take an operand. */
export type Op =
  | "invert"
  | "clear"
  | "set"
  | "shl"
  | "shr"
  | "asr"
  | "rol"
  | "ror"
  | "bswap"
  | "brev"
  | "neg"
  | "inc"
  | "dec"
  | "and"
  | "or"
  | "xor";

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

export class ModelError extends Error {}

/** A named copy of a value at some moment. */
export interface Snapshot {
  name: string;
  value: bigint;
  at: number; // ms since epoch
}

/** Applies `op` to a `width`-bit value. `arg` is the shift/rotate amount
 *  (default 1) or the and/or/xor operand. */
export function applyOp(
  operation: Op,
  value: bigint,
  width: number,
  argument = 1n,
): bigint {
  const mask = maxValue(width);
  const widthBig = BigInt(width);
  value &= mask;
  const amount = () => {
    if (argument < 0n) throw new ModelError("The amount can't be negative");
    return argument;
  };
  switch (operation) {
    case "invert":
      return ~value & mask;
    case "clear":
      return 0n;
    case "set":
      return mask;
    case "shl":
      return amount() >= widthBig ? 0n : (value << argument) & mask;
    case "shr":
      return amount() >= widthBig ? 0n : value >> argument;
    case "asr": {
      const shift = amount() >= widthBig ? widthBig - 1n : argument;
      const signed =
        (value >> (widthBig - 1n)) & 1n ? value - (1n << widthBig) : value;
      return (signed >> shift) & mask;
    }
    case "rol":
    case "ror": {
      const rotation = amount() % widthBig;
      if (rotation === 0n) return value;
      const left = operation === "rol" ? rotation : widthBig - rotation;
      return ((value << left) | (value >> (widthBig - left))) & mask;
    }
    case "bswap": {
      if (width % 8)
        throw new ModelError(
          "Swapping bytes needs a width that is a whole number of bytes",
        );
      let out = 0n;
      for (let i = 0n; i < widthBig / 8n; i++)
        out = (out << 8n) | ((value >> (i * 8n)) & 0xffn);
      return out;
    }
    case "brev": {
      let out = 0n;
      for (let i = 0n; i < widthBig; i++)
        out = (out << 1n) | ((value >> i) & 1n);
      return out;
    }
    case "neg":
      return -value & mask;
    case "inc":
      return (value + 1n) & mask;
    case "dec":
      return (value - 1n) & mask;
    case "and":
      return value & argument & mask;
    case "or":
      return (value | argument) & mask;
    case "xor":
      return (value ^ argument) & mask;
  }
  throw new ModelError(`Unknown operation ${operation}`);
}

/** read-write, read-only, or reserved (don't touch). */
export type Access = "rw" | "ro" | "reserved";

/** A named value of a field, e.g. MODE 1 = "Auto". */
export interface NamedValue {
  value: bigint;
  label: string;
}

/** Optional details of a field; everything defaults to "plain unsigned number". */
export interface FieldDetails {
  signed: boolean;
  formula: string; // real expression in x (the raw or signed value), e.g. "x * 0.5 - 40"
  unit: string;
  named: NamedValue[];
  description: string;
  access: Access;
}

export class Group implements FieldDetails {
  signed = false;
  formula = "";
  unit = "";
  named: NamedValue[] = [];
  description = "";
  access: Access = "rw";

  constructor(
    public lo: number,
    public hi: number,
    public name: string,
    public color: string,
    public base: Base = 16,
  ) {}
  get width(): number {
    return this.hi - this.lo + 1;
  }
  contains(bit: number): boolean {
    return this.lo <= bit && bit <= this.hi;
  }
  label(): string {
    return this.width > 1 ? `[${this.hi}:${this.lo}]` : `[${this.lo}]`;
  }
  get protected(): boolean {
    return this.access !== "rw";
  }
  /** The label of a named value, if `raw` has one. */
  nameOf(raw: bigint): string | undefined {
    return this.named.find((namedValue) => namedValue.value === raw)?.label;
  }
  details(): FieldDetails {
    return {
      signed: this.signed,
      formula: this.formula,
      unit: this.unit,
      named: this.named.map((namedValue) => ({ ...namedValue })),
      description: this.description,
      access: this.access,
    };
  }
  /** Only non-default details are written, so plain fields stay compact. */
  toJSON() {
    const out: Record<string, unknown> = {
      lo: this.lo,
      hi: this.hi,
      name: this.name,
      color: this.color,
      base: this.base,
    };
    if (this.signed) out.signed = true;
    if (this.formula) out.formula = this.formula;
    if (this.unit) out.unit = this.unit;
    if (this.named.length)
      out.named = this.named.map((namedValue) => ({
        value: namedValue.value.toString(),
        label: namedValue.label,
      }));
    if (this.description) out.description = this.description;
    if (this.access !== "rw") out.access = this.access;
    return out;
  }
}

/** "#rrggbb" or "#rgb". Colours end up in style attributes, so nothing else is accepted. */
export function isColor(value: unknown): value is string {
  return (
    typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
  );
}

/** Named values that fit in `width` bits. Negative ones become two's
 *  complement (-1 = all ones); values that can't fit are dropped. */
export function fitNamed(named: NamedValue[], width: number): NamedValue[] {
  const mask = maxValue(width);
  const out: NamedValue[] = [];
  for (const namedValue of named) {
    let value = namedValue.value;
    if (value < 0n && -value <= 1n << BigInt(width)) value &= mask;
    if (value >= 0n && value <= mask)
      out.push({ value, label: namedValue.label });
  }
  return out;
}

/** Reads the optional field details from JSON, ignoring anything malformed. */
export function detailsFromJSON(json: any): Partial<FieldDetails> {
  const out: Partial<FieldDetails> = {};
  if (json?.signed === true) out.signed = true;
  if (typeof json?.formula === "string") out.formula = json.formula;
  if (typeof json?.unit === "string") out.unit = json.unit;
  if (typeof json?.description === "string") out.description = json.description;
  if (json?.access === "ro" || json?.access === "reserved")
    out.access = json.access;
  if (Array.isArray(json?.named)) {
    out.named = [];
    for (const named of json.named) {
      try {
        if (typeof named?.label === "string")
          out.named.push({ value: toBig(named.value), label: named.label });
      } catch {
        /* skip a malformed entry */
      }
    }
  }
  return out;
}

/** Copies details onto a field, keeping only named values that fit it. */
function assignDetails(group: Group, details: Partial<FieldDetails>): void {
  Object.assign(group, details);
  group.named = fitNamed(group.named, group.width);
}

/** A bit position from JSON: a number or a string of digits (anything else is NaN, which is rejected later). */
function bitPosition(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^d+$/.test(value.trim()))
    return Number(value);
  return Number.NaN;
}

function checkPositions(lo: number, hi: number): void {
  if (!Number.isInteger(lo) || !Number.isInteger(hi))
    throw new ModelError("Field bit positions must be whole numbers");
}

function toSignedBits(value: bigint, width: number): bigint {
  return (value >> BigInt(width - 1)) & 1n
    ? value - (1n << BigInt(width))
    : value;
}

function checkWidth(width: number): void {
  if (!Number.isInteger(width) || width < MIN_WIDTH || width > MAX_WIDTH) {
    throw new ModelError(
      `Width must be a whole number of bits from ${MIN_WIDTH} to ${MAX_WIDTH}`,
    );
  }
}

function checkBase(value: unknown): Base {
  if (!isBase(value)) throw new ModelError(`Unsupported base ${value}`);
  return value;
}

function toBig(value: unknown): bigint {
  if (typeof value === "boolean")
    throw new ModelError("boolean is not a number");
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  const trimmed = String(value).trim();
  try {
    return BigInt(trimmed); // accepts 0x / 0o / 0b prefixes and decimals
  } catch {
    throw new ModelError(`Invalid number ${JSON.stringify(value)}`);
  }
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
    return Math.min(VIEW_WIDTHS[this.view] ?? this.width, this.width);
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
  private checkRow(lo: number): void {
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
    const newRowWidth = Math.min(VIEW_WIDTHS[view] ?? this.width, this.width);
    const compares = this.convertRows(this.compares, oldRowWidth, newRowWidth);
    const hidden = this.convertRows(
      this.hiddenCompares,
      oldRowWidth,
      newRowWidth,
    );
    for (const lo of compares.keys()) hidden.delete(lo); // an open row wins
    const bases = new Map<number, Base>();
    const oldRowStarts = [...this.rowBases.keys()].sort(
      (first, second) => first - second,
    );
    for (let lo = 0; lo < this.width; lo += newRowWidth) {
      // explicit base of the lowest old row overlapping the new row
      for (const oldRowStart of oldRowStarts) {
        if (oldRowStart + oldRowWidth > lo && oldRowStart < lo + newRowWidth) {
          bases.set(lo, this.rowBases.get(oldRowStart)!);
          break;
        }
      }
    }
    this.view = view;
    this.compares = compares;
    this.hiddenCompares = hidden;
    this.rowBases = bases;
    this.emit("structure");
  }
  /** Re-maps compare rows from `ow`-bit rows to `nw`-bit rows. Each old compare
   *  is laid over the parent value; a new row gets a compare if any old compare
   *  covered part of it (the rest of its bits come from the parent). */
  private convertRows(
    rows: Map<number, bigint>,
    oldRowWidth: number,
    newRowWidth: number,
  ): Map<number, bigint> {
    let overlay = this.value;
    let covered = 0n;
    for (const [lo, value] of rows) {
      const mask = (maxValue(oldRowWidth) << BigInt(lo)) & this.mask;
      overlay = (overlay & ~mask) | ((value << BigInt(lo)) & mask);
      covered |= mask;
    }
    const out = new Map<number, bigint>();
    for (let lo = 0; lo < this.width; lo += newRowWidth) {
      const width = Math.min(newRowWidth, this.width - lo);
      if (covered & (maxValue(width) << BigInt(lo)))
        out.set(lo, (overlay >> BigInt(lo)) & maxValue(width));
    }
    return out;
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
    const rowWidth = Math.min(VIEW_WIDTHS[this.view] ?? width, width);
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
    return this.groups.filter((group) => !(group.hi < lo || group.lo > hi));
  }
  suggestGroupName(): string {
    const names = new Set(this.groups.map((group) => group.name));
    let suffix = 1;
    while (names.has(`FIELD${suffix}`)) suffix++;
    return `FIELD${suffix}`;
  }
  private nextColor(): string {
    const used = new Set(this.groups.map((group) => group.color.toLowerCase()));
    return (
      GROUP_COLORS.find((color) => !used.has(color)) ??
      GROUP_COLORS[this.groups.length % GROUP_COLORS.length]
    );
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
    checkPositions(lo, hi);
    [lo, hi] = [Math.min(lo, hi), Math.max(lo, hi)];
    if (lo < 0 || hi >= this.width)
      throw new ModelError("Group outside the value");
    const clash = this.overlapping(lo, hi);
    if (clash.length) {
      throw new ModelError(
        "Groups cannot overlap: " +
          clash.map((group) => `${group.name} ${group.label()}`).join(", "),
      );
    }
    const width = hi - lo + 1;
    const field = new Group(
      lo,
      hi,
      (name ?? "").trim() || this.suggestGroupName(),
      isColor(color) ? color : this.nextColor(),
      base ? checkBase(base) : width <= 3 ? 2 : 16,
    );
    this.groups.push(field);
    this.groups.sort((first, second) => second.hi - first.hi);
    return field;
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
    checkPositions(lo, hi);
    [lo, hi] = [Math.min(lo, hi), Math.max(lo, hi)];
    if (lo < 0 || hi >= this.width)
      throw new ModelError("Group outside the value");
    const clash = this.overlapping(lo, hi).filter((other) => other !== group);
    if (clash.length) {
      throw new ModelError(
        "Groups cannot overlap: " +
          clash.map((other) => `${other.name} ${other.label()}`).join(", "),
      );
    }
    if (lo === group.lo && hi === group.hi) return;
    group.lo = lo;
    group.hi = hi;
    this.groups.sort((first, second) => second.hi - first.hi);
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
  /** Value of a field as a number: two's complement when the field is signed. */
  groupNumber(group: Group): bigint {
    const raw = this.groupValue(group);
    return group.signed && group.width > 1
      ? toSignedBits(raw, group.width)
      : raw;
  }
  groupValue(group: Group): bigint {
    return this.bitsValue(group.lo, group.width);
  }
  setGroupValue(group: Group, value: bigint): void {
    this.setBitsValue(group.lo, group.width, value);
  }

  // ------------------------------------------------------------ serialization
  toJSON() {
    const hex = (value: bigint) => "0x" + value.toString(16).toUpperCase();
    const sorted = <T>(map: Map<number, T>) =>
      [...map.entries()].sort((first, second) => first[0] - second[0]);
    return {
      name: this.name,
      width: this.width,
      value: hex(this.value),
      view: this.view,
      msb_first: this.msbFirst,
      full_base: this.fullBase,
      default_row_base: this.defaultRowBase,
      show_bases: this.showBases,
      collapsed: this.collapsed,
      snapshots: this.snapshots.map((snapshot) => ({
        name: snapshot.name,
        value: hex(snapshot.value),
        at: snapshot.at,
      })),
      row_bases: Object.fromEntries(
        sorted(this.rowBases).map(([rowStart, base]) => [
          String(rowStart),
          base,
        ]),
      ),
      compares: Object.fromEntries(
        sorted(this.compares).map(([rowStart, value]) => [
          String(rowStart),
          hex(value),
        ]),
      ),
      hidden_compares: Object.fromEntries(
        sorted(this.hiddenCompares).map(([rowStart, value]) => [
          String(rowStart),
          hex(value),
        ]),
      ),
      groups: this.groups.map((group) => group.toJSON()),
      // only written when set, so plain values stay as they were
      ...(this.block ? { block: this.block } : {}),
      ...(this.offset !== null ? { offset: hex(this.offset) } : {}),
      ...(this.description ? { description: this.description } : {}),
    };
  }

  static fromJSON(json: any): ValueModel {
    if (!json || typeof json !== "object")
      throw new ModelError("Invalid value entry");
    if (!("width" in json))
      throw new ModelError("Invalid value entry: missing width");
    const model = new ValueModel({
      width: Number(json.width),
      value: toBig(json.value ?? 0),
      name: String(json.name ?? "Value"),
      view: json.view ?? "byte",
      msbFirst: Boolean(json.msb_first ?? true),
      fullBase: checkBase(Number(json.full_base ?? 16)),
      defaultRowBase: checkBase(Number(json.default_row_base ?? 16)),
    });
    model.showBases = json.show_bases === true;
    model.collapsed = json.collapsed === true;
    if (typeof json.block === "string") model.block = json.block.trim();
    if (json.offset !== undefined && json.offset !== null) {
      const offset = toBig(json.offset);
      if (offset < 0n) throw new ModelError("Invalid register offset");
      model.offset = offset;
    }
    if (typeof json.description === "string")
      model.description = json.description;
    for (const snapshotJson of Array.isArray(json.snapshots)
      ? json.snapshots
      : []) {
      try {
        model.snapshots.push({
          name: String(snapshotJson.name ?? "Snapshot"),
          value: toBig(snapshotJson.value) & model.mask,
          at: Number(snapshotJson.at) || 0,
        });
      } catch {
        /* skip a malformed snapshot */
      }
    }
    for (const [rowStart, base] of Object.entries(json.row_bases ?? {})) {
      const lo = Number(rowStart);
      model.checkRow(lo);
      model.rowBases.set(lo, checkBase(Number(base)));
    }
    for (const [rowStart, value] of Object.entries(json.compares ?? {})) {
      const lo = Number(rowStart);
      model.checkRow(lo);
      model.compares.set(lo, toBig(value) & maxValue(model.rowWidthAt(lo)));
    }
    for (const [rowStart, value] of Object.entries(
      json.hidden_compares ?? {},
    )) {
      const lo = Number(rowStart);
      model.checkRow(lo);
      if (!model.compares.has(lo))
        model.hiddenCompares.set(
          lo,
          toBig(value) & maxValue(model.rowWidthAt(lo)),
        );
    }
    for (const groupJson of json.groups ?? []) {
      if (groupJson?.lo === undefined || groupJson?.hi === undefined)
        throw new ModelError("Invalid group entry");
      const group = model.addGroup(
        bitPosition(groupJson.lo),
        bitPosition(groupJson.hi),
        String(groupJson.name ?? ""),
        groupJson.color,
        checkBase(Number(groupJson.base ?? 16)),
      );
      assignDetails(group, detailsFromJSON(groupJson));
    }
    return model;
  }
}
