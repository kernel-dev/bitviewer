// The data a peripheral-scope export template reads (documented in
// docs/guide/07-export-templates.md): the peripheral, its registers in offset
// order, and a byte layout with gaps for structs.

import type { ValueModel } from "../model";
import { byteSize, type Peripheral } from "../workspace";
import { Num } from "./language";
import { ident } from "./naming";
import {
  addressBits,
  type ExportOptions,
  exportContext,
  placement,
} from "./register-data";

/** Register ids that would clash with the names the built-in peripheral templates add. */
const RESERVED_REGISTER_NAMES = new Set(["BASE"]);

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
