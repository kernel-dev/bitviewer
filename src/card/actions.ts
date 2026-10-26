// What a card does through a dialog: templates, snapshots, new and renamed
// fields, field details, the description, pasting bytes and exporting code.

import { BookmarkPlus, Camera, PencilLine, Tag } from "lucide";
import { type Group, ModelError } from "../core/model";
import { pasteBytes as askForBytes } from "../dialogs/bytes";
import { pickCompareValue } from "../dialogs/compare";
import { exportCode as openExportDialog } from "../dialogs/export";
import { editField } from "../dialogs/field";
import { pickTemplate, saveTemplate } from "../dialogs/templates";
import { appSettings } from "../platform/settings";
import { ask, prompt, toast } from "../ui/kit";
import { play } from "../ui/sound";
import type { ValueCard } from "./card";

export async function editDescription(card: ValueCard) {
  const text = await prompt(
    "Description",
    `What “${card.model.name || "this value"}” is for (shown when you point at its name)`,
    card.model.description,
    PencilLine,
  );
  if (text !== null) card.model.setDescription(text.trim());
}

export async function takeSnapshot(card: ValueCard) {
  const model = card.model;
  const name = await prompt(
    "Take snapshot",
    `Name for the current value of “${model.name || "value"}”`,
    `Snapshot ${model.snapshots.length + 1}`,
    Camera,
  );
  if (name === null) return;
  const snap = model.takeSnapshot(name);
  play("group");
  toast(`Saved snapshot “${snap.name}”`, "ok");
}

/** Fills compare rows on every row with a value the user types or picks. */
export async function compareWith(card: ValueCard) {
  const model = card.model;
  const value = await pickCompareValue({
    name: model.name,
    width: model.width,
    value: model.value,
    lookup: card.lookup,
    candidates: card.events.others(card).map((other) => ({
      name: other.model.name || "(unnamed)",
      width: other.model.width,
      value: other.model.value,
    })),
  });
  if (value === null) return;
  model.compareWith(value);
  play("toggle");
}

export async function pasteBytes(card: ValueCard) {
  const value = await askForBytes(card.model.width);
  if (value !== null && (await card.commit(value))) play("op");
}

export function exportCode(card: ValueCard) {
  void openExportDialog({
    kind: "register",
    model: card.model,
    peripheral: card.events.peripheral(card),
  });
}

// ------------------------------------------------------------ fields
/** Makes the selected bits a new field, after asking for its name. */
export async function createGroupFromSelection(card: ValueCard) {
  if (!card.selection) return;
  const [lo, hi] = card.selection;
  const clash = card.model.overlapping(lo, hi);
  if (clash.length) {
    play("error");
    await ask(
      "Fields cannot overlap",
      `The selection [${hi}:${lo}] overlaps ${clash.map((group) => `“${group.name}” ${group.label()}`).join(", ")}. ` +
        "Remove that field first or select a different range.",
      [{ id: "ok", label: "OK", className: "primary" }],
      "ok",
    );
    return;
  }
  const suggestion = card.model.suggestGroupName();
  const name = await prompt(
    "New register field",
    `Name for bits [${hi}:${lo}] (${hi - lo + 1} bits)`,
    suggestion,
    Tag,
  );
  if (name === null) return;
  try {
    card.model.addGroup(lo, hi, name.trim() || suggestion);
    play("group");
  } catch (error) {
    if (error instanceof ModelError) toast(error.message, "error");
    return;
  }
  card.clearSelection();
}

/** Widens or narrows a field so it covers exactly the selected bits. */
export function resizeGroupToSelection(card: ValueCard, group: Group) {
  if (!card.selection) return;
  try {
    card.model.resizeGroup(group, card.selection[0], card.selection[1]);
    play("group");
  } catch (error) {
    if (!(error instanceof ModelError)) throw error;
    play("error");
    toast(error.message, "error");
    return;
  }
  card.clearSelection();
}

export async function renameGroup(card: ValueCard, group: Group) {
  const name = await prompt(
    "Rename field",
    "Field name",
    group.name,
    PencilLine,
  );
  if (name?.trim()) {
    card.model.updateGroup(group, { name: name.trim() });
    card.rebuildWhenShown();
  }
}

export async function editFieldDetails(card: ValueCard, group: Group) {
  const details = await editField(group);
  if (details) {
    card.model.setGroupDetails(group, details);
    play("toggle");
  }
}

// ------------------------------------------------------------ templates
/** Replaces the fields with a template's, widening the value if needed. Both
 *  only with the user's go-ahead. */
export async function applyTemplate(card: ValueCard) {
  const model = card.model;
  const template = await pickTemplate(
    `Apply a template to “${model.name || "value"}”`,
    "Apply",
  );
  if (!template) return;
  const widen = template.width > model.width;
  if (widen) {
    const answer = await ask(
      "Template is wider",
      `“${template.name}” is ${template.width} bits wide; this value has ${model.width}. Widen the value to ${template.width} bits?`,
      [
        { id: "cancel", label: "Cancel" },
        {
          id: "yes",
          label: `Widen to ${template.width} bits`,
          className: "primary",
        },
      ],
    );
    if (answer !== "yes") return;
  }
  if (model.groups.length) {
    // replacing named fields is only ever done with the user's explicit go-ahead
    const answer = await ask(
      "Replace fields?",
      `This removes the current field${model.groups.length > 1 ? "s" : ""} (${model.groups.map((group) => group.name).join(", ")}) ` +
        `and applies “${template.name}”. You can undo this with Ctrl+Z.`,
      [
        { id: "cancel", label: "Cancel" },
        { id: "yes", label: "Replace fields", className: "danger-btn" },
      ],
    );
    if (answer !== "yes") return;
  }
  try {
    // one undo step for the widening and the new fields
    card.events.batch(true);
    try {
      if (widen) model.setWidth(template.width);
      model.applyTemplate(template);
    } finally {
      card.events.batch(false);
    }
    play("group");
  } catch (error) {
    if (!(error instanceof ModelError)) throw error;
    toast(error.message, "error");
  }
}

/** Saves the fields as a template of the user's, asking before replacing one. */
export async function saveAsTemplate(card: ValueCard) {
  const model = card.model;
  if (!model.groups.length) {
    toast("Create some fields first", "error");
    return;
  }
  const name = await prompt(
    "Save fields as template",
    "Template name",
    model.name || "My register",
    BookmarkPlus,
  );
  if (!name?.trim()) return;
  const existing = appSettings
    .get("templates")
    .find(
      (template) => template.name.toLowerCase() === name.trim().toLowerCase(),
    );
  if (existing) {
    const answer = await ask(
      "Replace template?",
      `You already have a template called “${existing.name}”. Replace it with these fields?`,
      [
        { id: "cancel", label: "Cancel" },
        { id: "yes", label: "Replace", className: "danger-btn" },
      ],
    );
    if (answer !== "yes") return;
  }
  saveTemplate({
    name: name.trim(),
    width: model.width,
    fields: model.groups.map((group) => group.toJSON() as never),
  });
}
