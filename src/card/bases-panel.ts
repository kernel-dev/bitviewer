// The optional "All bases" panel: the value in hex, decimal, octal and
// binary, each line editable and copyable.

import { Binary, Copy, X } from "lucide";
import { BASE_NAMES, type Base } from "../core/format/integers";
import { button, html, icon, NumberInput } from "../ui/kit";
import type { ValueCard } from "./card";
import { copyValue } from "./widgets";

export class BasesPanel {
  private edits = new Map<Base, NumberInput>();

  constructor(private card: ValueCard) {}

  /** The panel, or null while it is hidden. */
  build(): HTMLElement | null {
    const card = this.card;
    const model = card.model;
    this.edits.clear();
    if (!model.showBases) return null;
    const list = html("div", { class: "bases-list" });

    for (const base of [16, 10, 8, 2] as Base[]) {
      const edit = new NumberInput(
        model.width,
        base,
        (value) => void card.commit(value, { typing: edit.element }),
        {
          allowNegative: base === 10,
          group: true,
          className: "bases-edit",
        },
      );
      this.edits.set(base, edit);
      list.append(
        html(
          "div",
          { class: "bases-row" },
          html(
            "span",
            { class: "bases-name" },
            BASE_NAMES[base],
            html("small", {}, `base ${base}`),
          ),
          edit.element,
          button({
            icon: Copy,
            className: "ghost sm",
            tip: `Copy as ${BASE_NAMES[base]}`,
            onClick: () => copyValue(model.value, base, model.width),
          }),
        ),
      );
    }

    return html(
      "div",
      { class: "bases" },
      html(
        "div",
        { class: "fields-head" },
        icon(Binary, 15, "muted"),
        html("span", { class: "fields-title" }, "All bases"),
        html(
          "span",
          { class: "muted small hint" },
          "Type into any line to change the value",
        ),
        html("div", { class: "spacer" }),
        button({
          icon: X,
          className: "ghost sm",
          tip: "Hide all bases",
          onClick: () => card.toggleBases(),
        }),
      ),
      list,
    );
  }

  /** Shows the current value on every line. */
  update() {
    const model = this.card.model;
    for (const edit of this.edits.values()) {
      edit.setFormat(model.width, edit.base);
      edit.setValue(model.value);
    }
  }
}
