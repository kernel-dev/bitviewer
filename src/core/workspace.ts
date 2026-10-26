// Peripherals: named blocks of registers at a base address. A value belongs to
// one through its `block` name and sits at its `offset`; the peripheral itself
// (base address, description, collapsed or not) is stored once, next to the
// values. A peripheral's values are always kept next to each other in the
// workspace, so it shows as one block.

import { ModelError } from "./model";

export interface Peripheral {
  name: string;
  /** Base address, or null when unknown (offsets still work). */
  base: bigint | null;
  description: string;
  collapsed: boolean;
}

/** Anything placed in the workspace order with an optional peripheral name. */
type BlockOf<T> = (item: T) => string;

const hex = (value: bigint) => `0x${value.toString(16).toUpperCase()}`;

export function peripheralToJSON(peripheral: Peripheral) {
  return {
    name: peripheral.name,
    base: peripheral.base === null ? null : hex(peripheral.base),
    ...(peripheral.description ? { description: peripheral.description } : {}),
    ...(peripheral.collapsed ? { collapsed: true } : {}),
  };
}

/** Reads one peripheral from JSON. Throws ModelError when it is unusable. */
export function peripheralFromJSON(json: any): Peripheral {
  if (!json || typeof json.name !== "string" || !json.name.trim())
    throw new ModelError("Invalid peripheral entry: it needs a name");
  let base: bigint | null = null;
  if (json.base !== null && json.base !== undefined) {
    try {
      base = BigInt(String(json.base).trim());
    } catch {
      throw new ModelError(`Invalid base address for ${json.name}`);
    }
    if (base < 0n)
      throw new ModelError(`Invalid base address for ${json.name}`);
  }
  return {
    name: json.name.trim(),
    base,
    description: typeof json.description === "string" ? json.description : "",
    collapsed: json.collapsed === true,
  };
}

/** Reads the peripherals list of a workspace (missing = none). */
export function peripheralsFromJSON(json: unknown): Map<string, Peripheral> {
  const out = new Map<string, Peripheral>();
  if (json === undefined || json === null) return out;
  if (!Array.isArray(json))
    throw new ModelError("The file's peripherals aren't a list");
  for (const entry of json) {
    const peripheral = peripheralFromJSON(entry);
    out.set(peripheral.name, peripheral);
  }
  return out;
}

/** Bytes a register of `width` bits takes. */
export const byteSize = (width: number) => Math.ceil(width / 8);

/** The first offset after the given registers, rounded up to `align` bytes. */
export function nextOffset(
  registers: { offset: bigint | null; width: number }[],
  align = 4n,
): bigint {
  let end = 0n;
  for (const register of registers) {
    if (register.offset === null) continue;
    const registerEnd = register.offset + BigInt(byteSize(register.width));
    if (registerEnd > end) end = registerEnd;
  }
  return ((end + align - 1n) / align) * align;
}

/** A register's address: its peripheral's base plus its offset, when both are known. */
export function addressOf(
  offset: bigint | null,
  peripheral: Peripheral | undefined,
): bigint | null {
  return offset !== null && peripheral && peripheral.base !== null
    ? peripheral.base + offset
    : null;
}

/** Puts each peripheral's items together at the place of its first item;
 *  everything else keeps its order. */
export function groupOrder<T>(items: T[], blockOf: BlockOf<T>): T[] {
  const out: T[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    const block = blockOf(item);
    if (!block) out.push(item);
    else if (!placed.has(block)) {
      placed.add(block);
      out.push(...items.filter((other) => blockOf(other) === block));
    }
  }
  return out;
}

/** Top-level units of the workspace: a loose value, or a whole peripheral. */
function units<T>(items: T[], blockOf: BlockOf<T>): T[][] {
  const out: T[][] = [];
  for (const item of items) {
    const block = blockOf(item);
    const last = out[out.length - 1];
    if (block && last && blockOf(last[0]) === block) last.push(item);
    else out.push([item]);
  }
  return out;
}

/** Moves the item at `from` so it ends up at index `to` of the list without it.
 *  A peripheral's register stays inside its peripheral; a loose value (or the
 *  only register of a peripheral) never lands in the middle of a peripheral:
 *  it goes to the peripheral's start when moving up, its end when moving down. */
export function moveItem<T>(
  items: T[],
  from: number,
  to: number,
  blockOf: BlockOf<T>,
): T[] {
  const item = items[from];
  const rest = items.filter((_, index) => index !== from);
  let destination = Math.max(0, Math.min(to, rest.length));
  const block = blockOf(item);
  const siblings = block
    ? rest.flatMap((other, index) => (blockOf(other) === block ? [index] : []))
    : [];
  if (siblings.length) {
    destination = Math.max(
      siblings[0],
      Math.min(destination, siblings[siblings.length - 1] + 1),
    );
  } else {
    // not between two items of the same peripheral: jump to the edge of it
    // that lies in the direction of the move
    const run = destination > 0 ? blockOf(rest[destination - 1]) : "";
    if (
      run &&
      destination < rest.length &&
      blockOf(rest[destination]) === run
    ) {
      if (to < from)
        while (destination > 0 && blockOf(rest[destination - 1]) === run)
          destination--;
      else
        while (destination < rest.length && blockOf(rest[destination]) === run)
          destination++;
    }
  }
  rest.splice(destination, 0, item);
  return rest;
}

/** Moves a whole peripheral one place up (-1) or down (+1), past the
 *  neighbouring value or peripheral. */
export function moveBlock<T>(
  items: T[],
  block: string,
  direction: -1 | 1,
  blockOf: BlockOf<T>,
): T[] {
  const parts = units(items, blockOf);
  const index = parts.findIndex((part) => blockOf(part[0]) === block);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= parts.length) return items;
  [parts[index], parts[target]] = [parts[target], parts[index]];
  return parts.flat();
}

/** A peripheral name that isn't taken yet: "UART0", then "UART0 (2)"… */
export function freeName(name: string, taken: (name: string) => boolean) {
  let candidate = name;
  for (let suffix = 2; taken(candidate); suffix++)
    candidate = `${name} (${suffix})`;
  return candidate;
}
