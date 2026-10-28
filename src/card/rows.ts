// The rows of a card: in line view one strip with all bits, otherwise one row
// per byte or nibble with its label, base, editor and readout. Each row can
// have a compare row under it.

import { Ellipsis, GitCompareArrows, X } from "lucide";
import { decodeField } from "../core/format/fields";
import {
  BASE_NAMES,
  type Base,
  formatInt,
  popcount,
} from "../core/format/integers";
import type { ValueModel } from "../core/model";
import { appSettings } from "../platform/settings";
import {
  button,
  html,
  icon,
  NumberInput,
  openMenu,
  type Segmented,
} from "../ui/kit";
import { BitStrip } from "./bitstrip";
import type { ValueCard } from "./card";
import { onBitKey } from "./keyboard";
import { rowMenu } from "./menus";
import { baseSeg, readout, removed } from "./widgets";

export class RowsView {
  /** The rows container, while the card is expanded. */
  element: HTMLElement | null = null;
  private strips = new Map<number, BitStrip>();
  private cmpStrips = new Map<number, BitStrip>();
  private rowBases = new Map<number, Segmented<Base>>();
  private rowEdits = new Map<number, NumberInput>();
  private rowReadouts = new Map<number, HTMLElement>();
  private cmpEdits = new Map<number, NumberInput>();
  private cmpReadouts = new Map<number, HTMLElement>();
  private cmpBases = new Map<number, HTMLElement>();

  constructor(private card: ValueCard) {}

  private get model(): ValueModel {
    return this.card.model;
  }

  /** Bits per wrapped line of the first strip (line view wraps when narrow). */
  get lineBits(): number | undefined {
    return this.strips.values().next().value?.lineBits;
  }

  build(): HTMLElement {
    const card = this.card;
    const model = this.model;
    const rows = html("div", {
      class: `rows ${card.line ? "line" : "grid"}`,
      tabindex: 0,
      role: "group",
      "aria-label": `Bits of ${model.name || "value"}. Arrow keys move, Space flips, 0 and 1 set, Shift+arrows select.`,
    });
    rows.addEventListener("keydown", (event) => onBitKey(card, event));
    this.element = rows;

    for (const lo of model.rowLos()) {
      if (card.line) {
        rows.append(this.buildLineRow(lo));
        if (model.hasCompare(lo)) rows.append(this.buildLineCompareRow(lo));
      } else {
        rows.append(this.buildRow(lo));
        if (model.hasCompare(lo)) rows.append(this.buildCompareRow(lo));
      }
    }

    return rows;
  }

  /** Drops the strips (they listen for resizes) before a rebuild. */
  destroy() {
    for (const strip of [...this.strips.values(), ...this.cmpStrips.values()])
      strip.destroy();

    this.strips.clear();
    this.cmpStrips.clear();
    this.rowBases.clear();
    this.rowEdits.clear();
    this.rowReadouts.clear();
    this.cmpEdits.clear();
    this.cmpReadouts.clear();
    this.cmpBases.clear();
    this.element = null; // or the whole old bit grid stays alive
  }

  /** Redraws the bit cells only (selection or cursor moved). */
  repaint() {
    for (const strip of this.strips.values()) strip.update();
  }

  /** Shows the current value in every row and compare row. */
  update() {
    const card = this.card;
    const model = this.model;

    for (const [lo, strip] of this.strips) {
      const base = card.line ? model.fullBase : model.rowBase(lo);
      const value = model.rowValue(lo);
      const edit = this.rowEdits.get(lo);
      if (edit) {
        this.rowBases.get(lo)!.set(base);
        edit.setFormat(model.rowWidthAt(lo), base);
        edit.setValue(value);
        this.rowReadouts.get(lo)!.textContent = readoutText(
          value,
          model.rowWidthAt(lo),
        );
      }

      strip.update();
      const compareStrip = this.cmpStrips.get(lo);
      if (compareStrip) {
        this.cmpBases.get(lo)!.textContent = BASE_NAMES[base];
        this.cmpEdits.get(lo)!.setFormat(model.rowWidthAt(lo), base);
        this.cmpEdits.get(lo)!.setValue(model.compareValue(lo));
        const diff = model.compareDiff(lo);
        const readoutElement = this.cmpReadouts.get(lo)!;

        if (diff) {
          const differingBits = popcount(diff);
          readoutElement.replaceChildren(
            html(
              "span",
              { class: "diff-text" },
              `Δ ${differingBits} bit${differingBits > 1 ? "s" : ""}`,
            ),
            ` · XOR ${formatInt(diff, 16, model.rowWidthAt(lo), { prefix: true, group: card.line })}`,
          );
        } else
          readoutElement.replaceChildren(
            html("span", { class: "same-text" }, "identical"),
          );

        compareStrip.update();
      }
    }
  }

  private rowMenuButton(lo: number, compare: boolean): HTMLButtonElement {
    const buttonElement = button({
      icon: Ellipsis,
      className: "ghost sm",
      tip: compare ? "Compare row operations" : "Row operations",
    });
    buttonElement.addEventListener("click", () =>
      openMenu(rowMenu(this.card, lo, compare, null), buttonElement),
    );
    return buttonElement;
  }

  // ------------------------------------------------------------ line view
  private buildLineRow(lo: number): HTMLElement {
    const strip = new BitStrip(this.card, lo, false, true);
    this.strips.set(lo, strip);
    return html(
      "div",
      { class: `row line-row${this.model.hasCompare(lo) ? " linked" : ""}` },
      strip.element,
    );
  }

  private buildLineCompareRow(lo: number): HTMLElement {
    const model = this.model;
    const base = html("span", {
      class: "muted mono small",
      tip: "Uses the value's base",
    });
    this.cmpBases.set(lo, base);
    const edit = new NumberInput(
      model.rowWidthAt(lo),
      model.fullBase,
      (value) => model.setCompare(lo, value),
      {
        group: true,
        className: "cmp-edit",
      },
    );
    this.cmpEdits.set(lo, edit);
    const readoutElement = readout();
    this.cmpReadouts.set(lo, readoutElement);
    const strip = new BitStrip(this.card, lo, true, true);
    this.cmpStrips.set(lo, strip);
    return html(
      "div",
      { class: "row cmp-row cmp-line" },
      html(
        "div",
        { class: "cmp-bar" },
        html(
          "span",
          {
            class: "cmp-label",
            tip: "Independent value compared against the bits above",
          },
          icon(GitCompareArrows, 14),
          "Compare",
        ),
        base,
        edit.element,
        readoutElement,
        html("div", { class: "spacer" }),
        button({
          icon: X,
          label: "Remove",
          className: "ghost danger sm",
          tip: "Remove this compare row",
          onClick: () => removed(() => model.removeCompare(lo)),
        }),
        this.rowMenuButton(lo, true),
      ),
      strip.element,
    );
  }

  // ------------------------------------------------------------ byte / nibble view
  private buildRow(lo: number): HTMLElement {
    const card = this.card;
    const model = this.model;
    const hi = lo + model.rowWidthAt(lo) - 1;
    const label = html(
      "button",
      {
        type: "button",
        class: "row-label",
        tip: "Click to select this row · Shift+click to extend over consecutive rows",
      },
      html("b", {}, model.rowTitle(lo)),
      html("span", { class: "muted mono" }, `[${hi}:${lo}]`),
    );
    label.addEventListener("click", (event) =>
      card.selectRows(lo, event.shiftKey),
    );

    const strip = new BitStrip(card, lo);
    this.strips.set(lo, strip);
    const baseControl = baseSeg(
      model.rowBase(lo),
      (base) => model.setRowBase(lo, base),
      "xs",
    );
    this.rowBases.set(lo, baseControl);
    const edit = new NumberInput(
      model.rowWidthAt(lo),
      model.rowBase(lo),
      (value) =>
        void card.commit(model.withBits(lo, model.rowWidthAt(lo), value), {
          typing: edit.element,
        }),
      {
        className: `row-edit w${model.rowWidth}`,
      },
    );
    this.rowEdits.set(lo, edit);
    const readoutElement = readout();
    readoutElement.classList.toggle("off", !appSettings.get("show_readouts"));
    this.rowReadouts.set(lo, readoutElement);
    const compareButton = button({
      icon: GitCompareArrows,
      label: "Compare",
      className: `ghost sm${model.hasCompare(lo) ? " on" : ""}`,
      tip: "Show a linked compare row under this one",
      onClick: () =>
        model.hasCompare(lo) ? model.removeCompare(lo) : model.addCompare(lo),
    });
    return html(
      "div",
      { class: `row${model.hasCompare(lo) ? " linked" : ""}` },
      label,
      strip.element,
      baseControl.element,
      edit.element,
      readoutElement,
      compareButton,
      this.rowMenuButton(lo, false),
    );
  }

  private buildCompareRow(lo: number): HTMLElement {
    const model = this.model;
    const strip = new BitStrip(this.card, lo, true);
    this.cmpStrips.set(lo, strip);
    const base = html("span", {
      class: "cmp-base muted mono small",
      tip: "Uses the parent row's base",
    });
    this.cmpBases.set(lo, base);
    const edit = new NumberInput(
      model.rowWidthAt(lo),
      model.rowBase(lo),
      (value) => model.setCompare(lo, value),
      {
        className: `row-edit w${model.rowWidth}`,
      },
    );
    this.cmpEdits.set(lo, edit);
    const readoutElement = readout();
    this.cmpReadouts.set(lo, readoutElement);
    return html(
      "div",
      { class: "row cmp-row" },
      html(
        "span",
        {
          class: "cmp-label",
          tip: `Independent value compared against ${model.rowTitle(lo)}; it shares that row's fields`,
        },
        icon(GitCompareArrows, 14),
        "Compare",
      ),
      strip.element,
      base,
      edit.element,
      readoutElement,
      button({
        icon: X,
        label: "Remove",
        className: "ghost danger sm",
        tip: "Remove this compare row",
        onClick: () => removed(() => model.removeCompare(lo)),
      }),
      this.rowMenuButton(lo, true),
    );
  }
}

/** "0x41 · 65 · 0o101", plus the character for printable bytes. */
function readoutText(value: bigint, width: number): string {
  const parts = [
    formatInt(value, 16, width, { prefix: true }),
    value.toString(),
    formatInt(value, 8, width, { prefix: true }),
  ];

  if (width === 8 && value >= 0x20n && value < 0x7fn)
    parts.push(`'${String.fromCharCode(Number(value))}'`);

  return parts.join(" · ");
}

/** The tooltip of a bit cell: its value, the field it belongs to, and hints. */
export function bitTip(
  model: ValueModel,
  bit: number,
  lo: number,
  compare: boolean,
): string {
  const lines: string[] = [];

  if (compare) {
    const compareBit = model.compareBit(lo, bit);
    const parentBit = model.bit(bit);
    lines.push(
      `Bit ${bit} (compare) = ${compareBit}` +
        (compareBit === parentBit ? "" : `   ≠ parent ${parentBit}`),
    );
  } else lines.push(`Bit ${bit} = ${model.bit(bit)}`);

  const group = model.groupAt(bit);
  if (group) {
    const raw = model.groupValue(group);
    const extra = [decodeField(group, raw).text, group.nameOf(raw)]
      .filter(Boolean)
      .join(" · ");
    lines.push(
      `${group.name} ${group.label()} = ${formatInt(raw, group.base, group.width, { prefix: true })}${extra ? `  (${extra})` : ""}`,
    );

    if (group.access !== "rw")
      lines.push(
        group.access === "ro" ? "🔒 read-only field" : "🔒 reserved field",
      );

    if (group.description) lines.push(group.description);
  }

  if (!compare) lines.push("Click: flip · Drag: select · Shift+click: extend");
  return lines.join("\n");
}
