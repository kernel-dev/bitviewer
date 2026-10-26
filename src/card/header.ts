// A card's header line: drag handle, collapse, name, width and address
// badges, the whole value in a base of your choice, Copy and the "More" menu.

import {
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  GripVertical,
} from "lucide";
import { BASE_NAMES, BASE_ORDER, type Base } from "../core/format/integers";
import { addressOf } from "../core/workspace";
import {
  button,
  html,
  icon,
  NumberInput,
  openMenu,
  type Segmented,
  setTip,
} from "../ui/kit";
import type { ValueCard } from "./card";
import { cardMenu } from "./menus";
import { baseSeg, copyValue } from "./widgets";

const hex = (value: bigint) => `0x${value.toString(16).toUpperCase()}`;

export class CardHeader {
  private fullBase!: Segmented<Base>;
  private fullEdit!: NumberInput;

  constructor(private card: ValueCard) {}

  build(): HTMLElement {
    const card = this.card;
    const model = card.model;
    const name = html("input", {
      class: "name-edit",
      value: model.name,
      placeholder: "Name",
      spellcheck: false,
      tip: model.description
        ? `${model.description}\n\nClick to rename`
        : "Click to rename",
    });
    name.addEventListener("input", () => model.setName(name.value));
    name.addEventListener(
      "keydown",
      (event) => event.key === "Enter" && name.blur(),
    );

    this.fullBase = baseSeg(
      model.fullBase,
      (base) => model.setFullBase(base),
      "",
    );
    setTip(this.fullBase.element, "Number base of the whole value");
    this.fullEdit = new NumberInput(
      model.width,
      model.fullBase,
      (value) => void card.commit(value, { typing: this.fullEdit.element }),
      {
        allowNegative: true,
        group: true,
        className: "value-edit",
      },
    );

    const copyBtn = button({
      icon: Copy,
      label: "Copy",
      className: "outline",
      tip: "Copy the whole value to the clipboard",
    });
    copyBtn.addEventListener("click", () =>
      openMenu(
        BASE_ORDER.map((base) => ({
          label: `Copy as ${BASE_NAMES[base]}`,
          action: () => copyValue(model.value, base, model.width),
        })),
        copyBtn,
      ),
    );
    const moreButton = button({
      icon: Ellipsis,
      className: "ghost more-btn",
      tip: "More",
    });
    moreButton.addEventListener("click", () =>
      openMenu(cardMenu(card), moreButton),
    );

    const grip = html(
      "button",
      {
        type: "button",
        class: "grip",
        tip: "Drag to reorder",
        "aria-label": "Drag to reorder",
      },
      icon(GripVertical, 16),
    );

    grip.addEventListener("pointerdown", (event) => {
      if (event.button === 0) card.events.dragStart(card, event);
    });

    const collapse = button({
      icon: model.collapsed ? ChevronRight : ChevronDown,
      className: "ghost sm collapse-btn",
      tip: model.collapsed ? "Expand" : "Collapse to the header line",
      onClick: () => card.toggleCollapsed(),
    });
    return html(
      "header",
      { class: "card-head" },
      grip,
      collapse,
      name,
      html(
        "button",
        {
          type: "button",
          class: `badge${model.width > 32 ? " wide" : ""}`,
          tip: "Change width…",
          onClick: () => card.events.resize(card),
        },
        `${model.width}-bit`,
      ),
      this.addressBadge(),
      html("div", { class: "spacer-sm" }),
      this.fullBase.element,
      this.fullEdit.element,
      copyBtn,
      moreButton,
    );
  }

  /** Shows the current value. */
  update() {
    const model = this.card.model;
    this.fullBase.set(model.fullBase);
    this.fullEdit.setFormat(model.width, model.fullBase);
    this.fullEdit.setValue(model.value);
  }

  /** Where the register sits: its address (base + offset), or just the
   *  offset when the peripheral has no base address. Null outside peripherals. */
  private addressBadge(): HTMLElement | null {
    const card = this.card;
    const model = card.model;
    const peripheral = card.events.peripheral(card);
    if (!peripheral) return null;
    const address = addressOf(model.offset, peripheral);
    const text =
      address !== null
        ? hex(address)
        : model.offset !== null
          ? `+${hex(model.offset)}`
          : "no offset";
    const tip =
      model.offset === null
        ? `In ${peripheral.name}, without an offset. Click to set one.`
        : address !== null
          ? `${peripheral.name} ${hex(peripheral.base!)} + ${hex(model.offset)}. Click to change the offset.`
          : `Offset ${hex(model.offset)} in ${peripheral.name} (no base address). Click to change it.`;
    return html(
      "button",
      {
        type: "button",
        class: `badge addr mono${model.offset === null ? " warn" : ""}`,
        tip,
        onClick: () => card.events.editOffset(card),
      },
      text,
    );
  }
}
