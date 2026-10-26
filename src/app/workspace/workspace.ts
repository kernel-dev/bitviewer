// The values in the window: their order and layout (a peripheral's registers
// are shown together under its header), adding, removing, moving and
// duplicating them, and the JSON of it all for files, the session and undo.

import { Plus, Ruler } from "lucide";
import { ValueCard } from "../../card/card";
import { ValueModel, valueFromJSON, valueToJSON } from "../../core/model";
import {
  groupOrder,
  moveItem,
  type Peripheral,
  peripheralsFromJSON,
  peripheralToJSON,
} from "../../core/workspace";
import { appSettings } from "../../platform/settings";
import { ask, button, html } from "../../ui/kit";
import { logoSvg } from "../../ui/logo";
import { play } from "../../ui/sound";
import type { App } from "../app";
import { dragCard } from "./drag";
import { resizeValue } from "./value-dialogs";

export class Workspace {
  cards: ValueCard[] = [];
  /** Peripheral blocks by name; values join one through `model.block`. */
  peripherals = new Map<string, Peripheral>();
  /** The value last clicked or focused; palette "Value:" commands act on it. */
  activeCard: ValueCard | null = null;
  readonly element: HTMLElement;
  private empty: HTMLElement;
  readonly blockOf = (card: ValueCard) => card.model.block;

  constructor(private app: App) {
    const run = (id: string) => () => app.commands.run(id);
    this.empty = html(
      "div",
      { class: "empty" },
      logoSvg(56),
      html("h3", {}, "No values yet"),
      html("p", { class: "muted" }, "Add a value to start inspecting bits."),
      html(
        "div",
        { class: "empty-actions" },
        button({
          icon: Plus,
          label: "32-bit value",
          className: "primary",
          onClick: run("value.add32"),
        }),
        button({
          icon: Plus,
          label: "64-bit value",
          className: "outline",
          onClick: run("value.add64"),
        }),
        button({
          icon: Ruler,
          label: "Custom width",
          className: "outline",
          onClick: run("value.addCustom"),
        }),
      ),
    );
    this.element = html("main", { class: "workspace" }, this.empty);
  }

  // ================================================================ JSON
  /** The values and their peripherals, as saved in files, sessions and undo steps. */
  toJSON() {
    return {
      values: this.cards.map((card) => valueToJSON(card.model)),
      peripherals: this.usedPeripherals().map(peripheralToJSON),
    };
  }

  /** The workspace as one string, for undo steps. */
  snapshot(): string {
    return JSON.stringify(this.toJSON());
  }

  /** Rebuilds the workspace from a snapshot (undo / redo), keeping the scroll position. */
  restore(snapshotJson: string) {
    const scroll = this.element.scrollTop;
    const data = JSON.parse(snapshotJson);
    this.replace(data.values, data.peripherals);
    this.element.scrollTop = scroll;
  }

  /** Replaces every value and peripheral (validated JSON). */
  replace(values: unknown[], peripherals: unknown) {
    const models = values.map((serialized) => valueFromJSON(serialized));
    const blocks = peripheralsFromJSON(peripherals);
    this.clear();
    this.peripherals = blocks;
    for (const model of models)
      this.addValue(model.width, model, undefined, false);
  }

  /** Peripherals that have registers, in workspace order. */
  usedPeripherals(): Peripheral[] {
    const out: Peripheral[] = [];
    for (const card of this.cards) {
      const peripheral = this.peripherals.get(card.model.block);
      if (peripheral && !out.includes(peripheral)) out.push(peripheral);
    }
    return out;
  }

  // ================================================================ values
  /** Adds a value (a new `width`-bit one unless `model` is given) at `index`
   *  (default: the end). `reveal` scrolls to it with a sound. */
  addValue(
    width: number,
    model?: ValueModel,
    index?: number,
    reveal = true,
  ): ValueCard {
    if (!model) {
      const names = new Set(this.cards.map((card) => card.model.name));
      let valueNumber = this.cards.length + 1;
      while (names.has(`Value ${valueNumber}`)) valueNumber++;
      model = new ValueModel({
        width,
        name: `Value ${valueNumber}`,
        view: appSettings.get("default_view"),
        defaultRowBase: appSettings.get("default_base"),
      });
    }
    const app = this.app;
    const history = app.history;
    const card = new ValueCard(model, {
      remove: (card) => this.removeValue(card),
      move: (card, direction) => this.moveValue(card, direction),
      duplicate: (card) => this.duplicateValue(card),
      resize: (card) => resizeValue(card),
      lookup: (_card, name) => this.valueByName(name),
      others: (card) => this.cards.filter((otherCard) => otherCard !== card),
      dragStart: (card, event) => dragCard(this, card, event),
      batch: (holding) => (holding ? history.hold() : history.release()),
      peripheral: (card) => this.peripherals.get(card.model.block),
      peripheralMenu: (card) => app.peripherals.menu(card),
      editOffset: (card) => void app.peripherals.editOffset(card),
    });
    model.subscribe(() => history.touch());
    this.cards.splice(index ?? this.cards.length, 0, card);
    this.relayout();
    history.touch();
    if (reveal) {
      play("add");
      card.root.classList.add("enter");
      requestAnimationFrame(() =>
        card.root.scrollIntoView({ block: "nearest", behavior: "smooth" }),
      );
    }
    return card;
  }

  /** Removes a value, asking first when it has fields or compare rows. */
  async removeValue(card: ValueCard) {
    const model = card.model;
    if (model.groups.length || model.compares.size) {
      const answer = await ask(
        "Remove value",
        `Remove “${model.name}” together with its fields and compare rows?`,
        [
          { id: "cancel", label: "Cancel" },
          { id: "yes", label: "Remove", className: "danger-btn" },
        ],
      );
      if (answer !== "yes") return;
    }
    this.drop(card);
    this.relayout();
    this.app.history.touch();
    play("remove");
  }

  /** Takes a card out without relayout or undo step (for batch changes). */
  drop(card: ValueCard) {
    card.detach();
    this.cards.splice(this.cards.indexOf(card), 1);
    card.root.remove();
  }

  /** Removes every value. */
  clear() {
    for (const card of [...this.cards]) this.drop(card);
    this.relayout();
  }

  duplicateValue(card: ValueCard) {
    const serialized = valueToJSON(card.model);
    serialized.name = `${card.model.name} copy`;
    this.addValue(
      card.model.width,
      valueFromJSON(serialized),
      this.cards.indexOf(card) + 1,
    );
  }

  /** Moves a value up (-1) or down (+1), staying inside its peripheral. */
  moveValue(card: ValueCard, delta: number) {
    const index = this.cards.indexOf(card);
    const newIndex = index + delta;
    if (newIndex < 0 || newIndex >= this.cards.length) return;
    this.reorder(moveItem(this.cards, index, newIndex, this.blockOf));
  }

  /** Puts the values in a new order (one undo step). */
  reorder(cards: ValueCard[]) {
    this.cards = cards;
    this.relayout();
    this.app.history.touch();
  }

  /** The values of one peripheral, in workspace order. */
  members(name: string): ValueCard[] {
    return this.cards.filter((card) => card.model.block === name);
  }

  /** A value by name for expressions. Case, spaces and underscores don't matter. */
  valueByName(name: string): bigint | undefined {
    const normalize = (text: string) =>
      text
        .toLowerCase()
        .replace(/[\s_]+/g, " ")
        .trim();
    const normalizedName = normalize(name);
    return this.cards.find(
      (card) => normalize(card.model.name) === normalizedName,
    )?.model.value;
  }

  /** Ctrl+G: makes the selection (in whichever card has one) a field. */
  groupSelection(): boolean {
    const card = this.cards.find((candidate) => candidate.selection);
    if (card) card.createGroupFromSelection();
    return card !== undefined;
  }

  clearSelections() {
    for (const card of this.cards) card.clearSelection();
  }

  // ================================================================ layout
  /** Puts the cards on screen in order, each peripheral's registers in its block. */
  relayout() {
    if (this.activeCard && !this.cards.includes(this.activeCard))
      this.activeCard = null;
    this.tidyPeripherals();
    const focused = document.activeElement;
    const children: HTMLElement[] = [];
    let body: HTMLElement | null = null;
    let block = "";
    for (const card of this.cards) {
      if (!card.model.block) {
        children.push(card.root);
        block = "";
        continue;
      }
      if (card.model.block !== block) {
        block = card.model.block;
        const section = this.app.peripherals.section(block);
        body = section.querySelector(".periph-body");
        children.push(section);
      }
      body!.append(card.root);
    }
    this.element.replaceChildren(
      ...(this.cards.length ? children : [this.empty]),
    );
    if (focused instanceof HTMLElement && this.element.contains(focused))
      focused.focus({ preventScroll: true });
    if (this.app.search.isOpen) this.app.search.apply();
  }

  /** Every value's peripheral exists, unused ones are gone, and each
   *  peripheral's values are next to each other. */
  private tidyPeripherals() {
    for (const card of this.cards) {
      const block = card.model.block;
      if (block && !this.peripherals.has(block)) {
        this.peripherals.set(block, {
          name: block,
          base: null,
          description: "",
          collapsed: false,
        });
        card.rebuild(); // its header shows the peripheral's address
      }
    }
    for (const name of [...this.peripherals.keys()])
      if (!this.cards.some((card) => card.model.block === name))
        this.peripherals.delete(name);
    this.cards = groupOrder(this.cards, this.blockOf);
  }
}
