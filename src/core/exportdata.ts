// The data an export template can read (documented in docs/guide/07-export-templates.md).
// Everything is plain strings, numbers, booleans, lists and objects, so templates
// never need to do bigint maths: values and masks arrive as Num, which prints as
// hex and also has .bin, .dec and .oct.
import { Num } from "./exportlang";
import type { Group, ValueModel } from "./model";
import { byteSize, type Peripheral } from "./workspace";

export interface ExportOptions {
  prefix: string; // e.g. "CTRL", used in names
  includeValue: boolean; // emit the current value as a constant
  accessors?: boolean; // emit get/set helpers (default true)
  platform?: 32 | 64; // register width of the target: values wider than this are split into words
  /** The peripheral the value belongs to, for its address. */
  peripheral?: Peripheral;
}

/** Bits needed for addresses: 32, or 64 when one doesn't fit in 32. */
const addressBits = (...addresses: (bigint | null)[]) =>
  addresses.some((address) => address !== null && address > 0xffffffffn)
    ? 64
    : 32;

/** The address facts every register export gets. */
function placement(model: ValueModel, peripheral: Peripheral | undefined) {
  const base = peripheral?.base ?? null;
  const address =
    model.offset !== null && base !== null ? base + model.offset : null;
  const bits = addressBits(address, model.offset);
  return {
    description: model.description,
    block: model.block,
    has_offset: model.offset !== null,
    offset: Num.of(model.offset ?? 0n, 0),
    has_address: address !== null,
    address: Num.of(address ?? 0n, 0),
    address_bits: bits,
  };
}

/** UPPER_SNAKE identifier from free text ("Value 1" → "VALUE_1"). */
export function ident(text: string, fallback = "REG"): string {
  let id = text
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (!id) id = fallback;
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

/** A prefix for a value: its name as an identifier, or REG for unnamed ones ("Value 1" is the app's default). */
export function defaultPrefix(model: ValueModel): string {
  const name = model.name.trim();
  return !name || /^value \d+$/i.test(name) ? "REG" : ident(name);
}

const maskOf = (width: number) => (1n << BigInt(width)) - 1n;
const rangeOf = (lo: number, hi: number) =>
  hi > lo ? `[${hi}:${lo}]` : `[${lo}]`;
const STORAGE = [8, 16, 32, 64];

/** Identifier for each field; duplicates get _2, _3… so the output always compiles. */
function fieldIds(fields: Group[]): Map<Group, string> {
  const used = new Set<string>();
  const ids = new Map<Group, string>();
  for (const group of fields) {
    const base = ident(group.name, "FIELD");
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) id = `${base}_${suffix}`;
    used.add(id);
    ids.set(group, id);
  }
  return ids;
}

/** The pieces of a field's description: [range, access, signed, formula/unit, description]. */
function describe(group: Group): { comment: string; note: string } {
  const rest: string[] = [];
  if (group.access !== "rw")
    rest.push(group.access === "ro" ? "read-only" : "reserved");
  if (group.signed) rest.push("signed");
  if (group.formula)
    rest.push(`value = ${group.formula}${group.unit ? ` ${group.unit}` : ""}`);
  else if (group.unit) rest.push(group.unit);
  if (group.description) rest.push(group.description);
  return {
    comment: [group.label(), ...rest].join(" · "),
    note: rest.join(" · "),
  };
}

/** Suffixes the built-in templates put after a field's name; a named value
 *  with one of these names would redefine them (e.g. a value called "Mask"). */
const RESERVED_SUFFIXES = new Set([
  "POS",
  "WIDTH",
  "MASK",
  "SHIFT",
  "GET",
  "SET",
  "VALUE",
]);

/** A field's named values with unique identifiers: clashes get _2, _3…, and
 *  names the templates already use get a _VAL suffix. */
function namedItems(group: Group): Record<string, unknown>[] {
  const used = new Set<string>();
  const mask = maskOf(group.width);
  return group.named.map((namedValue) => {
    let base = ident(namedValue.label, "VALUE");
    if (RESERVED_SUFFIXES.has(base)) base = `${base}_VAL`;
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) id = `${base}_${suffix}`;
    used.add(id);
    return {
      label: namedValue.label,
      id,
      value: Num.of(namedValue.value & mask, group.width),
    };
  });
}

type Item = Record<string, unknown>;

/** One field, or the part of it that lies in one word. All items have the same properties, gaps included. */
function item(
  model: ValueModel,
  group: Group | null,
  id: string,
  lo: number,
  hi: number,
  wordLo: number,
  extra: Partial<Item>,
): Item {
  const width = hi - lo + 1;
  const mask = maskOf(width);
  const description = group
    ? describe(group)
    : { comment: `${rangeOf(lo, hi)} unused`, note: "" };
  return {
    gap: group === null,
    id: group ? id : "",
    field_id: group ? ident(group.name, "FIELD") : "",
    name: group?.name ?? "",
    lo,
    hi,
    bit: lo - wordLo,
    width,
    range: rangeOf(lo, hi),
    mask: Num.of(mask, width),
    shifted_mask: Num.of(mask << BigInt(lo), model.width),
    value: Num.of((model.value >> BigInt(lo)) & mask, width),
    access: group?.access ?? "rw",
    readonly: group?.access === "ro",
    reserved: group?.access === "reserved",
    signed: group?.signed ?? false,
    formula: group?.formula ?? "",
    unit: group?.unit ?? "",
    description: group?.description ?? "",
    comment: description.comment,
    note: description.note,
    named: group ? namedItems(group) : [],
    partial: false,
    part: 1,
    parts: 1,
    crosses: false,
    ...extra,
  };
}

export function exportContext(
  model: ValueModel,
  options: ExportOptions,
): Record<string, unknown> {
  const prefix = ident(options.prefix);
  const platform = options.platform === 64 ? 64 : 32;
  const ascending = [...model.groups].sort(
    (first, second) => first.lo - second.lo,
  );
  const ids = fieldIds(ascending);
  const wordCount = Math.max(1, Math.ceil(model.width / platform));
  const wordOf = (bit: number) => Math.floor(bit / platform);

  const fields = ascending.map((group) => {
    const spans = wordOf(group.hi) - wordOf(group.lo) + 1;
    return item(
      model,
      group,
      ids.get(group) ?? "FIELD",
      group.lo,
      group.hi,
      0,
      { parts: spans, crosses: spans > 1 },
    );
  });

  const words = Array.from({ length: wordCount }, (_index, wordIndex) => {
    const lo = wordIndex * platform;
    const hi = Math.min(model.width, lo + platform) - 1;
    const width = hi - lo + 1;
    const storage = STORAGE.find((size) => size >= width) ?? 64;
    const name =
      wordCount === 1
        ? ""
        : wordCount === 2
          ? wordIndex === 0
            ? "lower"
            : "upper"
          : String(wordIndex + 1);
    const items: Item[] = [];
    let next = lo;
    for (const group of ascending) {
      if (group.hi < lo || group.lo > hi) continue;
      const partLow = Math.max(group.lo, lo);
      const partHigh = Math.min(group.hi, hi);
      const firstWord = wordOf(group.lo);
      const spans = wordOf(group.hi) - firstWord + 1;
      const partial = spans > 1;
      const part = wordIndex - firstWord + 1;
      const base = ids.get(group) ?? "FIELD";
      if (partLow > next)
        items.push(item(model, null, "", next, partLow - 1, lo, {}));
      const description = describe(group);
      items.push(
        item(
          model,
          group,
          partial ? `${base}_PART${part}` : base,
          partLow,
          partHigh,
          lo,
          {
            partial,
            part,
            parts: spans,
            crosses: partial,
            comment: partial
              ? `${rangeOf(partLow, partHigh)} · part ${part} of ${spans} of ${group.label()}${description.note ? ` · ${description.note}` : ""}`
              : description.comment,
          },
        ),
      );
      next = Math.max(next, partHigh + 1);
    }
    if (next < lo + storage)
      items.push(item(model, null, "", next, lo + storage - 1, lo, {}));
    return {
      index: wordIndex + 1,
      name,
      suffix: name ? `_${name}` : "",
      member:
        wordCount === 1
          ? "reg"
          : wordCount === 2
            ? name
            : `word${wordIndex + 1}`,
      title:
        wordCount === 1
          ? "register"
          : wordCount === 2
            ? `${name} word`
            : `word ${wordIndex + 1}`,
      lo,
      hi,
      width,
      storage,
      value: Num.of((model.value >> BigInt(lo)) & maskOf(width), width),
      items,
      fields: items.filter((item) => !item.gap),
    };
  });

  const idWidth = Math.max(
    4,
    ...words.flatMap((word) =>
      word.items.map((item) => String(item.id).length),
    ),
  );
  return {
    name: model.name || prefix,
    prefix,
    width: model.width,
    value: Num.of(model.value, model.width),
    include_value: options.includeValue,
    accessors: options.accessors !== false,
    platform,
    uint_bits:
      [8, 16, 32, 64, 128].find((candidate) => candidate >= model.width) ?? 0,
    word_count: wordCount,
    name_width: idWidth,
    range_width: `[${model.width - 1}:0]`.length,
    fields,
    words,
    ...placement(model, options.peripheral),
  };
}

/** C-style storage for a register: the unsigned type that holds it, or an
 *  array of 32-bit words when it is wider than 64 bits. */
function storageOf(width: number): {
  bits: number;
  count: number;
  bytes: number;
} {
  const bits = [8, 16, 32, 64].find((size) => size >= width);
  if (bits) return { bits, count: 1, bytes: bits / 8 };
  const count = Math.ceil(width / 32);
  return { bits: 32, count, bytes: count * 4 };
}

/** The data a peripheral-scope template reads: the peripheral, its registers
 *  (in offset order) and a byte layout with gaps, for structs. */
export function peripheralContext(
  peripheral: Peripheral,
  models: ValueModel[],
  options: Pick<ExportOptions, "prefix" | "includeValue">,
): Record<string, unknown> {
  const prefix = ident(options.prefix);
  const sorted = [...models].sort((first, second) =>
    first.offset === null
      ? 1
      : second.offset === null
        ? -1
        : first.offset < second.offset
          ? -1
          : first.offset > second.offset
            ? 1
            : 0,
  );
  const used = new Set<string>();
  const ownName = (model: ValueModel) =>
    model.name.startsWith(`${peripheral.name}.`)
      ? model.name.slice(peripheral.name.length + 1)
      : model.name;
  const registers = sorted.map((model) => {
    let base = ident(ownName(model), "REG");
    if (RESERVED_REGISTER_NAMES.has(base)) base = `${base}_REG`;
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) id = `${base}_${suffix}`;
    used.add(id);
    const storage = storageOf(model.width);
    const context = exportContext(model, {
      prefix: `${prefix}_${id}`,
      includeValue: options.includeValue,
      peripheral,
    });
    return {
      ...context,
      ...placement(model, peripheral),
      id,
      name: model.name,
      bytes: byteSize(model.width),
      storage: storage.bits,
      count: storage.count,
      // C member type and array suffix: uint32_t, or uint32_t …[3] above 64 bits
      type: `uint${storage.bits}_t`,
      array: storage.count > 1 ? `[${storage.count}]` : "",
      rust_type:
        storage.count > 1 ? `[u32; ${storage.count}]` : `u${storage.bits}`,
      member_bytes: storage.bytes,
    };
  });

  // Byte layout for structs: registers at their offsets, gaps padded, and
  // registers that start inside the one before them marked as overlapping.
  const layout: Record<string, unknown>[] = [];
  let cursor = 0n;
  let gaps = 0;
  for (const register of registers) {
    if (!register.has_offset) continue;
    const offset = (register.offset as Num).big;
    if (offset < cursor) {
      layout.push({ ...register, member: false, gap: false, overlap: true });
      continue;
    }
    if (offset > cursor) {
      layout.push({
        gap: true,
        member: false,
        overlap: false,
        id: `RESERVED${gaps++}`,
        offset: Num.of(cursor, 0),
        bytes: Number(offset - cursor),
        range: `${Num.of(cursor, 0).hex}–${Num.of(offset - 1n, 0).hex}`,
        declaration: `RESERVED${gaps - 1}[${Number(offset - cursor)}]`,
      });
    }
    layout.push({
      ...register,
      member: true,
      gap: false,
      overlap: false,
      declaration: register.id + register.array,
    });
    cursor = offset + BigInt(register.member_bytes);
  }
  const base = peripheral.base;
  return {
    name: peripheral.name,
    prefix,
    description: peripheral.description,
    has_base: base !== null,
    base: Num.of(base ?? 0n, 0),
    address_bits: addressBits(
      base,
      ...registers.map((register) =>
        register.has_address ? (register.address as Num).big : null,
      ),
    ),
    include_value: options.includeValue,
    registers,
    layout,
    unplaced: registers
      .filter((register) => !register.has_offset)
      .map((register) => register.id),
    size: Number(cursor),
    // longest "NAME[n]" in the struct, to line up the comments
    name_width: Math.max(
      4,
      ...layout.map((item) => String(item.declaration ?? item.id).length),
    ),
  };
}

/** Register ids that would clash with the names the built-in peripheral templates add. */
const RESERVED_REGISTER_NAMES = new Set(["BASE"]);
