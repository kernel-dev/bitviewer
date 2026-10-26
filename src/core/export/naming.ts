// Identifiers in generated code: UPPER_SNAKE names from free text, made
// unique so the output always compiles.

import type { Group, ValueModel } from "../model";

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

/** Identifier for each field; duplicates get _2, _3… so the output always compiles. */
export function fieldIds(fields: Group[]): Map<Group, string> {
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
