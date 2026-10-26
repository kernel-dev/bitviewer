// Adding a value through a dialog (custom width, a template, an expression
// over other values) and changing a value's width.

import type { ValueCard } from "../../card/card";
import { newValueFromExpression } from "../../dialogs/new-value";
import { pickTemplate } from "../../dialogs/templates";
import { pickWidth } from "../../dialogs/width";
import { appSettings } from "../../platform/settings";
import { ask } from "../../ui/kit";
import type { Workspace } from "./workspace";

export async function addCustomValue(workspace: Workspace) {
  const width = await pickWidth(
    "Add value",
    appSettings.get("last_width"),
    "Add value",
  );
  if (width === null) return;
  appSettings.set("last_width", width);
  workspace.addValue(width);
}

export async function addValueFromTemplate(workspace: Workspace) {
  const template = await pickTemplate("Add value from template", "Add value");
  if (!template) return;
  const card = workspace.addValue(template.width);
  card.model.setName(template.name);
  card.model.applyTemplate(template);
  card.rebuildWhenShown();
}

export async function addValueFromExpression(workspace: Workspace) {
  const widest = Math.max(
    32,
    ...workspace.cards.map((card) => card.model.width),
  );
  const result = await newValueFromExpression(
    (name) => {
      const normalizedName = name.trim().toLowerCase();
      // "x" has no meaning here (there's no current value yet)
      return normalizedName === "x" ? undefined : workspace.valueByName(name);
    },
    Math.min(widest, 512),
  );
  if (!result) return;
  const card = workspace.addValue(result.width);
  card.model.setValue(result.value);
  if (result.name) card.model.setName(result.name);
  card.rebuildWhenShown();
}

/** Asks for a new width. Named fields that don't fit are never dropped: the
 *  user removes them first. Losing bits or compare rows asks for consent. */
export async function resizeValue(card: ValueCard) {
  const model = card.model;
  const width = await pickWidth(
    `Change width of “${model.name}”`,
    model.width,
    "Change width",
  );
  if (width === null || width === model.width) return;
  const lostParts = model.lostOnResize(width);
  if (lostParts.groups.length) {
    const names = lostParts.groups
      .map((group) => `“${group.name}” ${group.label()}`)
      .join(", ");
    const severalFieldsLost = lostParts.groups.length > 1;
    await ask(
      "Fields don't fit",
      `${names} ${severalFieldsLost ? "don't" : "doesn't"} fit in ${width} bits. ` +
        `Remove ${severalFieldsLost ? "those fields" : "that field"} first, or use at least ${model.minWidthForGroups} bits.`,
      [{ id: "ok", label: "OK", className: "primary" }],
      "ok",
    );
    return;
  }
  if (lostParts.compares || width < model.width) {
    const parts = [`bits above ${width - 1} are cleared`];
    if (lostParts.compares)
      parts.push(
        `${lostParts.compares} compare row${lostParts.compares > 1 ? "s" : ""} no longer fit and will be removed`,
      );
    const answer = await ask(
      "Change width",
      `Shrinking to ${width} bits: ${parts.join(", and ")}.`,
      [
        { id: "cancel", label: "Cancel" },
        { id: "yes", label: "Change width", className: "danger-btn" },
      ],
    );
    if (answer !== "yes") return;
  }
  card.clearSelection();
  model.setWidth(width);
}
