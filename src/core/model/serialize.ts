// The JSON form of a value, as saved in workspace files, sessions and undo
// steps. Reading is strict about the structure (a broken entry throws a
// ModelError) but skips malformed optional parts, such as one bad snapshot.

import { maxValue } from "../format/integers";
import { assignDetails, detailsFromJSON } from "./group";
import { bitPosition, checkBase, ModelError, toBig } from "./validate";
import { ValueModel } from "./value-model";

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

/** Reads a value from its workspace JSON. Throws ModelError when it is unusable. */
export function valueFromJSON(json: any): ValueModel {
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
      String(groupJson.name ?? ""),
      groupJson.color,
      checkBase(Number(groupJson.base ?? 16)),
    );
    assignDetails(group, detailsFromJSON(groupJson));
  }

  return model;
}
