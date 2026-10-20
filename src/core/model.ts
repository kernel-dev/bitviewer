// Value model: no DOM, so it can be unit tested headless.
//
// Bit numbering is global: bit 0 is the LSB of the whole 32/64-bit value.
// A *row* is the whole value ("line" view), a byte or a nibble, identified by
// its lowest bit index `lo`. Groups are inclusive bit ranges [lo, hi] and may
// span rows.

import { BASE_ORDER, type Base, isBase, maxValue } from "./numfmt";
import type { Template } from "./templates";

export const GROUP_COLORS = ["#f59f00", "#2fb344", "#ae3ec9", "#15aabf", "#4c6ef5", "#82c91e", "#f76707", "#868e96"];
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

/** Operations that need an argument (amount or operand) from the user. */
export const ARG_OPS = new Set<Op>(["and", "or", "xor"]);

/** Change kinds passed to listeners:
 *  value       bits of the value or a compare row changed
 *  format      a display base changed
 *  meta        the name changed
 *  group_meta  a group's name / colour / base changed
 *  groups      groups were added or removed
 *  structure   rows changed (view, order, compare rows added/removed) */
export type ChangeKind = "value" | "format" | "meta" | "group_meta" | "groups" | "structure";
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
export function applyOp(op: Op, v: bigint, width: number, arg = 1n): bigint {
  const m = maxValue(width);
  const w = BigInt(width);
  v &= m;
  const amount = () => {
    if (arg < 0n) throw new ModelError("The amount can't be negative");
    return arg;
  };
  switch (op) {
    case "invert":
      return ~v & m;
    case "clear":
      return 0n;
    case "set":
      return m;
    case "shl":
      return amount() >= w ? 0n : (v << arg) & m;
    case "shr":
      return amount() >= w ? 0n : v >> arg;
    case "asr": {
      const n = amount() >= w ? w - 1n : arg;
      const signed = (v >> (w - 1n)) & 1n ? v - (1n << w) : v;
      return (signed >> n) & m;
    }
    case "rol":
    case "ror": {
      const n = amount() % w;
      if (n === 0n) return v;
      const left = op === "rol" ? n : w - n;
      return ((v << left) | (v >> (w - left))) & m;
    }
    case "bswap": {
      if (width % 8) throw new ModelError("Swapping bytes needs a width that is a whole number of bytes");
      let out = 0n;
      for (let i = 0n; i < w / 8n; i++) out = (out << 8n) | ((v >> (i * 8n)) & 0xffn);
      return out;
    }
    case "brev": {
      let out = 0n;
      for (let i = 0n; i < w; i++) out = (out << 1n) | ((v >> i) & 1n);
      return out;
    }
    case "neg":
      return -v & m;
    case "inc":
      return (v + 1n) & m;
    case "dec":
      return (v - 1n) & m;
    case "and":
      return v & arg & m;
    case "or":
      return (v | arg) & m;
    case "xor":
      return (v ^ arg) & m;
  }
  throw new ModelError(`Unknown operation ${op}`);
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

export const DEFAULT_DETAILS: FieldDetails = {
  signed: false,
  formula: "",
  unit: "",
  named: [],
  description: "",
  access: "rw",
};

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
    return this.named.find((n) => n.value === raw)?.label;
  }
  details(): FieldDetails {
    return {
      signed: this.signed,
      formula: this.formula,
      unit: this.unit,
      named: this.named.map((n) => ({ ...n })),
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
    if (this.named.length) out.named = this.named.map((n) => ({ value: n.value.toString(), label: n.label }));
    if (this.description) out.description = this.description;
    if (this.access !== "rw") out.access = this.access;
    return out;
  }
}

/** Reads the optional field details from JSON, ignoring anything malformed. */
export function detailsFromJSON(d: any): Partial<FieldDetails> {
  const out: Partial<FieldDetails> = {};
  if (d?.signed === true) out.signed = true;
  if (typeof d?.formula === "string") out.formula = d.formula;
  if (typeof d?.unit === "string") out.unit = d.unit;
  if (typeof d?.description === "string") out.description = d.description;
  if (d?.access === "ro" || d?.access === "reserved") out.access = d.access;
  if (Array.isArray(d?.named)) {
    out.named = [];
    for (const n of d.named) {
      try {
        if (typeof n?.label === "string") out.named.push({ value: toBig(n.value), label: n.label });
      } catch {
        /* skip a malformed entry */
      }
    }
  }
  return out;
}

function toSignedBits(v: bigint, width: number): bigint {
  return (v >> BigInt(width - 1)) & 1n ? v - (1n << BigInt(width)) : v;
}

function checkWidth(w: number): void {
  if (!Number.isInteger(w) || w < MIN_WIDTH || w > MAX_WIDTH) {
    throw new ModelError(`Width must be a whole number of bits from ${MIN_WIDTH} to ${MAX_WIDTH}`);
  }
}

function checkBase(b: unknown): Base {
  if (!isBase(b)) throw new ModelError(`Unsupported base ${b}`);
  return b;
}

function toBig(v: unknown): bigint {
  if (typeof v === "boolean") throw new ModelError("boolean is not a number");
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  const s = String(v).trim();
  try {
    return BigInt(s); // accepts 0x / 0o / 0b prefixes and decimals
  } catch {
    throw new ModelError(`Invalid number ${JSON.stringify(v)}`);
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
  snapshots: Snapshot[] = []; // named copies of the value, oldest first
  rowBases = new Map<number, Base>();
  groups: Group[] = [];
  compares = new Map<number, bigint>();
  /** Values of closed compare rows, restored when the row is opened again. */
  hiddenCompares = new Map<number, bigint>();
  private listeners: Listener[] = [];

  constructor(
    opts: {
      width?: number;
      value?: bigint;
      name?: string;
      view?: View;
      msbFirst?: boolean;
      fullBase?: Base;
      defaultRowBase?: Base;
    } = {},
  ) {
    const width = opts.width ?? 32;
    checkWidth(width);
    const view = opts.view ?? "byte";
    if (!VIEWS.includes(view)) throw new ModelError(`Unknown view ${view}`);
    this.width = width;
    this.value = (opts.value ?? 0n) & maxValue(width);
    this.name = opts.name ?? "Value";
    this.view = view;
    this.msbFirst = opts.msbFirst ?? true;
    this.fullBase = checkBase(opts.fullBase ?? 16);
    this.defaultRowBase = checkBase(opts.defaultRowBase ?? 16);
  }

  // ------------------------------------------------------------ listeners
  subscribe(cb: Listener): void {
    this.listeners.push(cb);
  }
  unsubscribe(cb: Listener): void {
    this.listeners = this.listeners.filter((l) => l !== cb);
  }
  private emit(kind: ChangeKind): void {
    for (const cb of [...this.listeners]) cb(kind);
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
    const los: number[] = [];
    for (let lo = 0; lo < this.width; lo += this.rowWidth) los.push(lo);
    return this.msbFirst ? los.reverse() : los;
  }
  rowTitle(lo: number): string {
    if (this.view === "line") return `Bits ${this.width - 1}…0`;
    return `${this.view === "byte" ? "Byte" : "Nibble"} ${lo / this.rowWidth}`;
  }
  private checkRow(lo: number): void {
    if (lo % this.rowWidth || lo < 0 || lo >= this.width) {
      throw new ModelError(`${lo} is not a row start for this view`);
    }
  }
  private checkBit(i: number): void {
    if (i < 0 || i >= this.width) throw new ModelError(`Bit ${i} out of range`);
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
  bit(i: number): number {
    return Number((this.value >> BigInt(i)) & 1n);
  }
  setValue(v: bigint): void {
    v &= this.mask;
    if (v !== this.value) {
      this.value = v;
      this.emit("value");
    }
  }
  flipBit(i: number): void {
    this.checkBit(i);
    this.setValue(this.value ^ (1n << BigInt(i)));
  }
  bitsValue(lo: number, width: number): bigint {
    return (this.value >> BigInt(lo)) & maxValue(width);
  }
  setBitsValue(lo: number, width: number, v: bigint): void {
    const m = maxValue(width);
    const l = BigInt(lo);
    this.setValue((this.value & ~(m << l)) | ((v & m) << l));
  }
  rowValue(lo: number): bigint {
    return this.bitsValue(lo, this.rowWidthAt(lo));
  }
  setRowValue(lo: number, v: bigint): void {
    this.checkRow(lo);
    this.setBitsValue(lo, this.rowWidthAt(lo), v);
  }

  // ------------------------------------------------------------ operations
  opValue(op: Op, arg?: bigint): void {
    this.setValue(applyOp(op, this.value, this.width, arg));
  }
  opRow(lo: number, op: Op, arg?: bigint): void {
    this.setRowValue(lo, applyOp(op, this.rowValue(lo), this.rowWidthAt(lo), arg));
  }
  opCompare(lo: number, op: Op, arg?: bigint): void {
    this.setCompare(lo, applyOp(op, this.compareValue(lo), this.rowWidthAt(lo), arg));
  }
  /** Applies `op` to the bits lo..hi only (e.g. a selection). */
  opBits(lo: number, hi: number, op: Op, arg?: bigint): void {
    const w = hi - lo + 1;
    this.setBitsValue(lo, w, applyOp(op, this.bitsValue(lo, w), w, arg));
  }

  // ------------------------------------------------------------ view / order
  setView(view: View): void {
    if (!VIEWS.includes(view)) throw new ModelError(`Unknown view ${view}`);
    if (view === this.view) return;
    const ow = this.rowWidth;
    const nw = Math.min(VIEW_WIDTHS[view] ?? this.width, this.width);
    const compares = this.convertRows(this.compares, ow, nw);
    const hidden = this.convertRows(this.hiddenCompares, ow, nw);
    for (const lo of compares.keys()) hidden.delete(lo); // an open row wins
    const bases = new Map<number, Base>();
    const oldLos = [...this.rowBases.keys()].sort((a, b) => a - b);
    for (let lo = 0; lo < this.width; lo += nw) {
      // explicit base of the lowest old row overlapping the new row
      for (const olo of oldLos) {
        if (olo + ow > lo && olo < lo + nw) {
          bases.set(lo, this.rowBases.get(olo)!);
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
  private convertRows(rows: Map<number, bigint>, ow: number, nw: number): Map<number, bigint> {
    let overlay = this.value;
    let covered = 0n;
    for (const [lo, v] of rows) {
      const m = (maxValue(ow) << BigInt(lo)) & this.mask;
      overlay = (overlay & ~m) | ((v << BigInt(lo)) & m);
      covered |= m;
    }
    const out = new Map<number, bigint>();
    for (let lo = 0; lo < this.width; lo += nw) {
      const w = Math.min(nw, this.width - lo);
      if (covered & (maxValue(w) << BigInt(lo))) out.set(lo, (overlay >> BigInt(lo)) & maxValue(w));
    }
    return out;
  }

  /** Smallest width that keeps every named field. */
  get minWidthForGroups(): number {
    return Math.max(MIN_WIDTH, ...this.groups.map((g) => g.hi + 1));
  }

  /** Resize the value. High bits are cut off (or added as 0) and compare rows
   *  that no longer fit are dropped. Named fields are never dropped implicitly:
   *  shrinking below a field is refused. */
  setWidth(width: number): void {
    checkWidth(width);
    if (width === this.width) return;
    const cut = this.groups.filter((g) => g.hi >= width);
    if (cut.length) {
      throw new ModelError(`Fields ${cut.map((g) => `${g.name} ${g.label()}`).join(", ")} don't fit in ${width} bits`);
    }
    this.width = width;
    this.value &= this.mask;
    const rw = this.rowWidth;
    const compares = new Map<number, bigint>();
    for (const [lo, v] of this.compares) {
      if (lo < width && lo % rw === 0) compares.set(lo, v & maxValue(this.rowWidthAt(lo)));
    }
    this.compares = compares;
    const hidden = new Map<number, bigint>();
    for (const [lo, v] of this.hiddenCompares) {
      if (lo < width && lo % rw === 0) hidden.set(lo, v & maxValue(this.rowWidthAt(lo)));
    }
    this.hiddenCompares = hidden;
    for (const lo of [...this.rowBases.keys()]) if (lo >= width || lo % rw) this.rowBases.delete(lo);
    this.emit("structure");
  }

  /** Fields that block `setWidth(width)`, and how many compare rows it would drop. */
  lostOnResize(width: number): { groups: Group[]; compares: number } {
    const rw = Math.min(VIEW_WIDTHS[this.view] ?? width, width);
    return {
      groups: this.groups.filter((g) => g.hi >= width),
      compares: [...this.compares.keys()].filter((lo) => lo >= width || lo % rw).length,
    };
  }

  setCollapsed(collapsed: boolean): void {
    if (collapsed !== this.collapsed) {
      this.collapsed = collapsed;
      this.emit("structure");
    }
  }

  /** Saves the current value under a name. */
  takeSnapshot(name: string, at = Date.now()): Snapshot {
    const snap = { name: name.trim() || `Snapshot ${this.snapshots.length + 1}`, value: this.value, at };
    this.snapshots.push(snap);
    this.emit("meta");
    return snap;
  }

  removeSnapshot(snap: Snapshot): void {
    const i = this.snapshots.indexOf(snap);
    if (i >= 0) {
      this.snapshots.splice(i, 1);
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
  /** Replaces all fields with a template's. Call only with the user's go-ahead:
   *  it removes the current fields. Refuses if a template field doesn't fit. */
  applyTemplate(t: Template): void {
    const tooWide = t.fields.filter((f) => f.hi >= this.width);
    if (tooWide.length) throw new ModelError(`The template needs ${t.width} bits; this value has ${this.width}`);
    const old = this.groups;
    this.groups = [];
    try {
      for (const f of t.fields) {
        const g = this.addGroupQuiet(f.lo, f.hi, f.name, f.color, isBase(f.base) ? f.base : undefined);
        Object.assign(g, detailsFromJSON(f));
      }
    } catch (e) {
      this.groups = old; // all or nothing
      throw e;
    }
    this.emit("groups");
  }

  compareWith(other: bigint): void {
    for (const lo of this.rowLos()) {
      this.compares.set(lo, (other >> BigInt(lo)) & maxValue(this.rowWidthAt(lo)));
      this.hiddenCompares.delete(lo);
    }
    this.emit("structure");
  }

  /** Closes a compare row; its value is kept and comes back on reopen. */
  removeCompare(lo: number): void {
    const v = this.compares.get(lo);
    if (v === undefined) return;
    this.compares.delete(lo);
    this.hiddenCompares.set(lo, v);
    this.emit("structure");
  }
  compareValue(lo: number): bigint {
    const v = this.compares.get(lo);
    if (v === undefined) throw new ModelError("No compare row there");
    return v;
  }
  setCompare(lo: number, v: bigint): void {
    if (!this.compares.has(lo)) throw new ModelError("No compare row there");
    v &= maxValue(this.rowWidthAt(lo));
    if (v !== this.compares.get(lo)) {
      this.compares.set(lo, v);
      this.emit("value");
    }
  }
  compareBit(lo: number, bit: number): number {
    return Number((this.compareValue(lo) >> BigInt(bit - lo)) & 1n);
  }
  flipCompareBit(lo: number, bit: number): void {
    if (bit < lo || bit >= lo + this.rowWidthAt(lo)) throw new ModelError("Bit outside the compare row");
    this.setCompare(lo, this.compareValue(lo) ^ (1n << BigInt(bit - lo)));
  }
  compareDiff(lo: number): bigint {
    return this.compareValue(lo) ^ this.rowValue(lo);
  }

  // ------------------------------------------------------------ groups
  groupAt(bit: number): Group | undefined {
    return this.groups.find((g) => g.lo <= bit && bit <= g.hi);
  }
  overlapping(lo: number, hi: number): Group[] {
    return this.groups.filter((g) => !(g.hi < lo || g.lo > hi));
  }
  suggestGroupName(): string {
    const names = new Set(this.groups.map((g) => g.name));
    let n = 1;
    while (names.has(`FIELD${n}`)) n++;
    return `FIELD${n}`;
  }
  private nextColor(): string {
    const used = new Set(this.groups.map((g) => g.color.toLowerCase()));
    return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[this.groups.length % GROUP_COLORS.length];
  }
  addGroup(lo: number, hi: number, name?: string, color?: string, base?: Base): Group {
    const g = this.addGroupQuiet(lo, hi, name, color, base);
    this.emit("groups");
    return g;
  }
  /** addGroup without the change notification (for batch updates). */
  private addGroupQuiet(lo: number, hi: number, name?: string, color?: string, base?: Base): Group {
    [lo, hi] = [Math.min(lo, hi), Math.max(lo, hi)];
    if (lo < 0 || hi >= this.width) throw new ModelError("Group outside the value");
    const clash = this.overlapping(lo, hi);
    if (clash.length) {
      throw new ModelError("Groups cannot overlap: " + clash.map((g) => `${g.name} ${g.label()}`).join(", "));
    }
    const width = hi - lo + 1;
    const g = new Group(
      lo,
      hi,
      (name ?? "").trim() || this.suggestGroupName(),
      color || this.nextColor(),
      base ? checkBase(base) : width <= 3 ? 2 : 16,
    );
    this.groups.push(g);
    this.groups.sort((a, b) => b.hi - a.hi);
    return g;
  }
  removeGroup(g: Group): void {
    const i = this.groups.indexOf(g);
    if (i >= 0) {
      this.groups.splice(i, 1);
      this.emit("groups");
    }
  }
  /** Moves a field's edges, e.g. to widen a 4-bit field to 8 bits. Other fields stay put. */
  resizeGroup(g: Group, lo: number, hi: number): void {
    [lo, hi] = [Math.min(lo, hi), Math.max(lo, hi)];
    if (lo < 0 || hi >= this.width) throw new ModelError("Group outside the value");
    const clash = this.overlapping(lo, hi).filter((o) => o !== g);
    if (clash.length) {
      throw new ModelError("Groups cannot overlap: " + clash.map((o) => `${o.name} ${o.label()}`).join(", "));
    }
    if (lo === g.lo && hi === g.hi) return;
    g.lo = lo;
    g.hi = hi;
    this.groups.sort((a, b) => b.hi - a.hi);
    this.emit("groups");
  }
  updateGroup(g: Group, changes: { name?: string; color?: string; base?: Base }): void {
    let changed = false;
    if (changes.name !== undefined && changes.name !== g.name) {
      g.name = changes.name;
      changed = true;
    }
    if (changes.color !== undefined && changes.color !== g.color) {
      g.color = changes.color;
      changed = true;
    }
    if (changes.base !== undefined && checkBase(changes.base) !== g.base) {
      g.base = changes.base;
      changed = true;
    }
    if (changed) this.emit("group_meta");
  }
  /** Replaces a field's details (signedness, formula, named values, …). */
  setGroupDetails(g: Group, details: Partial<FieldDetails>): void {
    Object.assign(g, details);
    this.emit("groups"); // the fields panel shows these, so rebuild it
  }
  /** Value of a field as a number: two's complement when the field is signed. */
  groupNumber(g: Group): bigint {
    const raw = this.groupValue(g);
    return g.signed && g.width > 1 ? toSignedBits(raw, g.width) : raw;
  }
  groupValue(g: Group): bigint {
    return this.bitsValue(g.lo, g.width);
  }
  setGroupValue(g: Group, v: bigint): void {
    this.setBitsValue(g.lo, g.width, v);
  }

  // ------------------------------------------------------------ serialization
  toJSON() {
    const hex = (v: bigint) => "0x" + v.toString(16).toUpperCase();
    const sorted = <T>(m: Map<number, T>) => [...m.entries()].sort((a, b) => a[0] - b[0]);
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
      snapshots: this.snapshots.map((x) => ({ name: x.name, value: hex(x.value), at: x.at })),
      row_bases: Object.fromEntries(sorted(this.rowBases).map(([k, v]) => [String(k), v])),
      compares: Object.fromEntries(sorted(this.compares).map(([k, v]) => [String(k), hex(v)])),
      hidden_compares: Object.fromEntries(sorted(this.hiddenCompares).map(([k, v]) => [String(k), hex(v)])),
      groups: this.groups.map((g) => g.toJSON()),
    };
  }

  static fromJSON(d: any): ValueModel {
    if (!d || typeof d !== "object") throw new ModelError("Invalid value entry");
    if (!("width" in d)) throw new ModelError("Invalid value entry: missing width");
    const m = new ValueModel({
      width: Number(d.width),
      value: toBig(d.value ?? 0),
      name: String(d.name ?? "Value"),
      view: d.view ?? "byte",
      msbFirst: Boolean(d.msb_first ?? true),
      fullBase: checkBase(Number(d.full_base ?? 16)),
      defaultRowBase: checkBase(Number(d.default_row_base ?? 16)),
    });
    m.showBases = d.show_bases === true;
    m.collapsed = d.collapsed === true;
    for (const x of Array.isArray(d.snapshots) ? d.snapshots : []) {
      try {
        m.snapshots.push({ name: String(x.name ?? "Snapshot"), value: toBig(x.value) & m.mask, at: Number(x.at) || 0 });
      } catch {
        /* skip a malformed snapshot */
      }
    }
    for (const [k, b] of Object.entries(d.row_bases ?? {})) {
      const lo = Number(k);
      m.checkRow(lo);
      m.rowBases.set(lo, checkBase(Number(b)));
    }
    for (const [k, v] of Object.entries(d.compares ?? {})) {
      const lo = Number(k);
      m.checkRow(lo);
      m.compares.set(lo, toBig(v) & maxValue(m.rowWidthAt(lo)));
    }
    for (const [k, v] of Object.entries(d.hidden_compares ?? {})) {
      const lo = Number(k);
      m.checkRow(lo);
      if (!m.compares.has(lo)) m.hiddenCompares.set(lo, toBig(v) & maxValue(m.rowWidthAt(lo)));
    }
    for (const gd of d.groups ?? []) {
      if (gd?.lo === undefined || gd?.hi === undefined) throw new ModelError("Invalid group entry");
      const g = m.addGroup(
        Number(gd.lo),
        Number(gd.hi),
        String(gd.name ?? ""),
        gd.color,
        checkBase(Number(gd.base ?? 16)),
      );
      Object.assign(g, detailsFromJSON(gd));
    }
    return m;
  }
}

export { BASE_ORDER };
