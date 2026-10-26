// Register fields ("groups"): a named, inclusive bit range [lo, hi] with a
// colour, a display base and optional details (signedness, formula, unit,
// named values, description, access).

import { type Base, maxValue } from "../format/integers";
import { checkBase, checkPositions, ModelError, toBig } from "./validate";

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
export function assignDetails(
  group: Group,
  details: Partial<FieldDetails>,
): void {
  Object.assign(group, details);
  group.named = fitNamed(group.named, group.width);
}

// ------------------------------------------------------------ field lists
// A value's fields never overlap and are kept sorted from the top bit down.

/** Fields that share at least one bit with [lo, hi]. */
export function overlappingFields(
  groups: Group[],
  lo: number,
  hi: number,
): Group[] {
  return groups.filter((group) => !(group.hi < lo || group.lo > hi));
}

/** Checks that [lo, hi] (in either order) fits a `width`-bit value without
 *  overlapping a field other than `except`. Returns it as [low, high]. */
export function fieldRange(
  groups: Group[],
  width: number,
  lo: number,
  hi: number,
  except?: Group,
): [number, number] {
  checkPositions(lo, hi);
  [lo, hi] = [Math.min(lo, hi), Math.max(lo, hi)];
  if (lo < 0 || hi >= width) throw new ModelError("Group outside the value");
  const clash = overlappingFields(groups, lo, hi).filter(
    (other) => other !== except,
  );

  if (clash.length) {
    throw new ModelError(
      "Groups cannot overlap: " +
        clash.map((other) => `${other.name} ${other.label()}`).join(", "),
    );
  }

  return [lo, hi];
}

/** The first free name of the form FIELD1, FIELD2, … */
export function suggestFieldName(groups: Group[]): string {
  const names = new Set(groups.map((group) => group.name));
  let suffix = 1;
  while (names.has(`FIELD${suffix}`)) suffix++;
  return `FIELD${suffix}`;
}

/** A colour no field uses yet (or the next one round when all are taken). */
export function nextFieldColor(groups: Group[]): string {
  const used = new Set(groups.map((group) => group.color.toLowerCase()));
  return (
    GROUP_COLORS.find((color) => !used.has(color)) ??
    GROUP_COLORS[groups.length % GROUP_COLORS.length]
  );
}

/** A new field for a `width`-bit value that already has `groups`. Missing or
 *  invalid names and colours get defaults; short fields default to binary. */
export function newField(
  groups: Group[],
  width: number,
  lo: number,
  hi: number,
  name?: string,
  color?: string,
  base?: Base,
): Group {
  [lo, hi] = fieldRange(groups, width, lo, hi);
  return new Group(
    lo,
    hi,
    (name ?? "").trim() || suggestFieldName(groups),
    isColor(color) ? color : nextFieldColor(groups),
    base ? checkBase(base) : hi - lo + 1 <= 3 ? 2 : 16,
  );
}

/** Sorts fields from the top bit down, in place. */
export function sortFields(groups: Group[]): void {
  groups.sort((first, second) => second.hi - first.hi);
}
