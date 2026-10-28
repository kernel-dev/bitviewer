// The JSON form of a value, as saved in workspace files, sessions and undo
// steps. Reading is strict about the structure (a broken entry throws a
// ModelError) but skips malformed optional parts, such as one bad snapshot.

import { maxValue } from "../format/integers";
import { assignDetails, detailsFromJSON } from "./group";
import { bitPosition, checkBase, ModelError, toBig } from "./validate";
import { ValueModel } from "./value-model";

/** Each value's JSON text and the revision it was made for. */
const texts = new WeakMap<ValueModel, { revision: number; text: string }>();
let textMade = 0;

/** The value's JSON text. Made again only after the value changed, so an
 *  unchanged value gives the very same string each time (undo steps and the
 *  auto-saved session share it instead of holding copies). */
export function valueText(model: ValueModel): string {
  const cached = texts.get(model);
  if (cached?.revision === model.revision) return cached.text;
  const text = JSON.stringify(valueToJSON(model));
  textMade += text.length;
  texts.set(model, { revision: model.revision, text });
  return text;
}

/** Records `text` as the value's JSON text when it was just read from that
 *  text (an undo step), so the step's string is reused rather than remade. */
export function rememberValueText(model: ValueModel, text: string): void {
  texts.set(model, { revision: model.revision, text });
}

/** Characters of value JSON text made so far, for estimating what undo holds. */
export const valueTextMade = () => textMade;

/** Gives back the first copy of each text seen, so repeated texts (field
 *  names, descriptions, colours…) are stored once. Share one across a load. */
export type TextPool = Map<string, string>;

const pooled = (pool: TextPool | undefined, text: string): string => {
  if (!pool) return text;
  const found = pool.get(text);
  if (found !== undefined) return found;
  pool.set(text, text);
  return text;
};

/** The workspace JSON of a value. */
export function valueToJSON(model: ValueModel) {
  const hex = (value: bigint) => `0x${value.toString(16).toUpperCase()}`;
  const sorted = <T>(map: Map<number, T>) =>
    [...map.entries()].sort((first, second) => first[0] - second[0]);
  return {
    name: model.name,
    width: model.width,
    value: hex(model.value),
    view: model.view,
    msb_first: model.msbFirst,
    full_base: model.fullBase,
    default_row_base: model.defaultRowBase,
    show_bases: model.showBases,
    collapsed: model.collapsed,
    snapshots: model.snapshots.map((snapshot) => ({
      name: snapshot.name,
      value: hex(snapshot.value),
      at: snapshot.at,
    })),
    row_bases: Object.fromEntries(
      sorted(model.rowBases).map(([rowStart, base]) => [
        String(rowStart),
        base,
      ]),
    ),
    compares: Object.fromEntries(
      sorted(model.compares).map(([rowStart, value]) => [
        String(rowStart),
        hex(value),
      ]),
    ),
    hidden_compares: Object.fromEntries(
      sorted(model.hiddenCompares).map(([rowStart, value]) => [
        String(rowStart),
        hex(value),
      ]),
    ),
    groups: model.groups.map((group) => group.toJSON()),
    // only written when set, so plain values stay as they were
    ...(model.block ? { block: model.block } : {}),
    ...(model.offset !== null ? { offset: hex(model.offset) } : {}),
    ...(model.description ? { description: model.description } : {}),
  };
}

/** Reads a value from its workspace JSON. Throws ModelError when it is unusable.
 *  Values read with the same `pool` share their repeated texts. */
export function valueFromJSON(json: any, pool?: TextPool): ValueModel {
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
    model.description = pooled(pool, json.description);

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

  for (const [rowStart, value] of Object.entries(json.hidden_compares ?? {})) {
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
      pooled(pool, String(groupJson.name ?? "")),
      typeof groupJson.color === "string"
        ? pooled(pool, groupJson.color)
        : groupJson.color,
      checkBase(Number(groupJson.base ?? 16)),
    );
    assignDetails(group, detailsFromJSON(groupJson));

    if (pool) {
      group.description = pooled(pool, group.description);
      group.unit = pooled(pool, group.unit);
      group.formula = pooled(pool, group.formula);
      for (const named of group.named) named.label = pooled(pool, named.label);
    }
  }

  return model;
}
