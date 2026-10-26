// The "Register fields" panel of a card: one row per field with its colour,
// name, range, base, raw value, decoded value (signed / formula / unit),
// named-value picker and buttons for details, selecting and removing.

import {
  Layers,
  LayoutTemplate,
  Lock,
  MousePointerClick,
  Palette,
  SlidersVertical,
  Trash,
} from "lucide";
import { ExprError } from "../core/expr";
import {
  decodeField,
  isInvertible,
  rawFromNumber,
} from "../core/format/fields";
import { type Base, formatInt, ParseError } from "../core/format/integers";
import { parseFloatText } from "../core/format/interpretations";
import { GROUP_COLORS, type Group } from "../core/model";
import {
  button,
  html,
  icon,
  type MenuItem,
  NumberInput,
  openMenu,
  type Segmented,
  setTip,
  toast,
} from "../ui/kit";
import { play } from "../ui/sound";
import { editFieldDetails } from "./actions";
import type { ValueCard } from "./card";
import { baseSeg, removed, stripUnit } from "./widgets";

/** The live parts of one field row, updated on every change. */
interface FieldUi {
  group: Group;
  edit: NumberInput;
  baseControl: Segmented<Base>;
  decoded?: HTMLElement;
  named?: HTMLButtonElement;
  row?: HTMLElement;
}

/** The page's one hidden colour picker (cancelling it fires no event, so a
 *  new input per click would never be removed). */
let sharedColorInput: HTMLInputElement | null = null;
function colorInput(): HTMLInputElement {
  sharedColorInput ??= document.body.appendChild(
    html("input", { type: "color", class: "hidden-color", tabindex: -1 }),
  );
  return sharedColorInput;
}

/** "#abc" → "#aabbcc" (a colour input only takes the long form). */
function expandColor(color: string): string {
  return /^#[0-9a-f]{3}$/i.test(color)
    ? `#${[...color.slice(1)].map((digit) => digit + digit).join("")}`
    : color;
}

export class FieldsPanel {
  private fieldUis: FieldUi[] = [];
  /** Field names matching the current search, highlighted. */
  private matches = new Set<string>();

  constructor(private card: ValueCard) {}

  build(): HTMLElement {
    const card = this.card;
    const model = card.model;
    this.fieldUis = [];
    const head = html(
      "div",
      { class: "fields-head" },
      icon(Layers, 15, "muted"),
      html("span", { class: "fields-title" }, "Register fields"),
      model.groups.length
        ? html("span", { class: "count" }, String(model.groups.length))
        : null,
      model.groups.length
        ? null
        : html(
            "span",
            { class: "muted small hint" },
            "Drag across bits (or click a row label, then Shift+click another) and press “Group selection”. Fields may span rows; they cannot overlap.",
          ),
      html("div", { class: "spacer" }),
      button({
        icon: LayoutTemplate,
        label: "Templates",
        className: "ghost sm",
        tip: "Apply a field layout (IEEE-754, RGB565, IPv4, your own…)",
        onClick: () => card.applyTemplate(),
      }),
    );
    const list = html("div", { class: "fields-list" });
    for (const group of model.groups) list.append(this.buildFieldRow(group));
    return html(
      "div",
      { class: `fields${model.groups.length ? "" : " no-fields"}` },
      head,
      model.groups.length ? list : null,
    );
  }

  /** Forgets the rows (the card is collapsed). */
  clear() {
    this.fieldUis = [];
  }

  /** Shows the current value in every field row. */
  update() {
    const model = this.card.model;
    for (const fieldUi of this.fieldUis) {
      const raw = model.groupValue(fieldUi.group);
      fieldUi.baseControl.set(fieldUi.group.base);
      fieldUi.edit.setFormat(fieldUi.group.width, fieldUi.group.base);
      fieldUi.edit.setValue(raw);
      if (fieldUi.decoded) {
        const decoded = decodeField(fieldUi.group, raw);
        if (fieldUi.decoded instanceof HTMLInputElement) {
          if (document.activeElement !== fieldUi.decoded) {
            fieldUi.decoded.value = decoded.error
              ? "?"
              : stripUnit(decoded.text, fieldUi.group.unit);
            fieldUi.decoded.classList.toggle("invalid", !!decoded.error);
          }
        } else
          fieldUi.decoded.textContent = decoded.error
            ? `⚠ ${decoded.error}`
            : decoded.text;
      }
      if (fieldUi.named)
        fieldUi.named.textContent = fieldUi.group.nameOf(raw) ?? "—";
    }
  }

  /** Highlights fields that match a search (an empty set clears). */
  markMatches(names: Set<string>) {
    this.matches = names;
    for (const fieldUi of this.fieldUis)
      fieldUi.row?.classList.toggle("match", names.has(fieldUi.group.name));
  }

  private buildFieldRow(group: Group): HTMLElement {
    const card = this.card;
    const model = card.model;
    const swatch = html("button", {
      type: "button",
      class: "swatch",
      style: `--g:${group.color}`,
      tip: "Change colour",
    });
    swatch.addEventListener("click", () => this.pickColor(group, swatch));
    const name = html("input", {
      class: "field",
      value: group.name,
      placeholder: "Field name",
      spellcheck: false,
    });
    name.addEventListener("input", () =>
      model.updateGroup(group, { name: name.value }),
    );
    if (group.description) setTip(name, group.description);
    const baseControl = baseSeg(
      group.base,
      (base) => model.updateGroup(group, { base: base }),
      "xs",
    );
    const edit = new NumberInput(
      group.width,
      group.base,
      (value) =>
        void card.commit(model.withBits(group.lo, group.width, value), {
          typing: edit.element,
        }),
      {
        className: "group-edit",
      },
    );
    edit.element.style.setProperty(
      "--chars",
      String(Math.min(Math.max(group.width, 4), 34)),
    );
    const fieldUi: FieldUi = { group, edit, baseControl };

    const decoded =
      group.signed || group.formula || group.unit
        ? this.buildDecoded(group, fieldUi)
        : null;
    const named = group.named.length ? this.buildNamedPicker(group) : null;
    if (named) fieldUi.named = named;
    this.fieldUis.push(fieldUi);
    const row = html(
      "div",
      { class: `field-row${group.protected ? " protected" : ""}` },
      swatch,
      name,
      html(
        "span",
        { class: "muted mono small range" },
        group.protected ? icon(Lock, 12, "lock") : null,
        `${group.label()} · ${group.width} bit${group.width > 1 ? "s" : ""}`,
      ),
      baseControl.element,
      edit.element,
      decoded,
      named,
      html("div", { class: "spacer" }),
      button({
        icon: SlidersVertical,
        className: "ghost sm",
        tip: "Field details: description, signed, formula & unit, named values, access",
        onClick: () => editFieldDetails(card, group),
      }),
      button({
        icon: MousePointerClick,
        className: "ghost sm",
        tip: "Select this field's bits",
        onClick: () => card.setSelection(group.lo, group.hi),
      }),
      button({
        icon: Trash,
        className: "ghost danger sm",
        tip: "Remove this field",
        onClick: () => removed(() => model.removeGroup(group)),
      }),
    );
    fieldUi.row = row;
    row.classList.toggle("match", this.matches.has(group.name));
    return row;
  }

  /** The field's meaning: a signed number or formula result with its unit, editable when the formula can be inverted. */
  private buildDecoded(group: Group, fieldUi: FieldUi): HTMLElement {
    if (!isInvertible(group)) {
      const span = html("span", {
        class: "decoded-ro mono",
        tip: "Not linear, so it can't be typed in; edit the raw value",
      });
      fieldUi.decoded = span;
      return span;
    }
    const card = this.card;
    const model = card.model;
    const input = html("input", {
      class: "field mono decoded-edit",
      spellcheck: false,
      tip: "Type a value to set the raw bits",
    });
    const commit = () => {
      if (input.dataset.dirty !== "1") return;
      input.dataset.dirty = "";
      try {
        const typedValue = parseFloatText(stripUnit(input.value, group.unit));
        const raw = rawFromNumber(group, typedValue);
        input.classList.remove("invalid");
        void card.commit(model.withBits(group.lo, group.width, raw), {
          onCancel: () => input.blur(),
        });
      } catch (error) {
        if (!(error instanceof ExprError || error instanceof ParseError))
          throw error;
        input.classList.add("invalid");
        play("error");
        toast(error.message, "error");
      }
    };
    input.addEventListener("input", () => {
      input.dataset.dirty = "1";
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commit();
      if (event.key === "Escape") {
        event.stopPropagation();
        input.dataset.dirty = "";
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      commit();
      card.refresh();
    });
    fieldUi.decoded = input;
    return html(
      "span",
      { class: "decoded" },
      input,
      group.unit ? html("span", { class: "muted small" }, group.unit) : null,
    );
  }

  /** A button that opens a menu of the field's named values. */
  private buildNamedPicker(group: Group): HTMLButtonElement {
    const card = this.card;
    const model = card.model;
    const picker = html("button", {
      type: "button",
      class: "btn outline sm named-pick",
      tip: "Pick a named value",
    });
    picker.addEventListener("click", () =>
      openMenu(
        group.named.map((namedValue) => ({
          label: `${namedValue.label}  ·  ${formatInt(namedValue.value, group.base, group.width, { prefix: true })}`,
          checked: model.groupValue(group) === namedValue.value,
          action: async () => {
            const next = model.withBits(
              group.lo,
              group.width,
              namedValue.value,
            );
            if (await card.commit(next)) play("toggle");
          },
        })),
        picker,
      ),
    );
    return picker;
  }

  private pickColor(
    group: Group,
    anchor: HTMLElement | { x: number; y: number },
  ) {
    const card = this.card;
    const custom = () => {
      const input = colorInput();
      input.value = expandColor(group.color);
      input.oninput = () =>
        card.model.updateGroup(group, { color: input.value });
      input.onchange = () => card.rebuild();
      input.click();
    };
    openMenu(
      [
        ...GROUP_COLORS.map(
          (color): MenuItem => ({
            label: color.toUpperCase(),
            swatch: color,
            action: () => {
              card.model.updateGroup(group, { color: color });
              card.rebuild();
            },
          }),
        ),
        "sep",
        { label: "Custom colour…", icon: Palette, action: custom },
      ],
      anchor,
    );
  }
}
