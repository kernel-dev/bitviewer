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
import { bringIntoView } from "./reveal";
import { resizeValue } from "./value-dialogs";

/** Makes `parent`'s children exactly `wanted`, in order. Nodes already in
 *  place stay put: moving every card on each change would make the browser
 *  restyle the whole workspace. */
function setChildren(parent: Element, wanted: Node[]) {
  const keep = new Set(wanted);
  let current = parent.firstChild;

  for (const node of wanted) {
    // drop what doesn't belong here any more, so it isn't counted as "in place"
    while (current && current !== node && !keep.has(current)) {
      const next = current.nextSibling;
      current.remove();
      current = next;
    }

    if (current === node) current = current.nextSibling;
    else parent.insertBefore(node, current);
  }

  while (current) {
    const next: ChildNode | null = current.nextSibling;
    current.remove();
    current = next;
  }
}

export class Workspace {
  cards: ValueCard[] = [];
  /** Peripheral blocks by name; values join one through `model.block`. */
  peripherals = new Map<string, Peripheral>();
  /** The value last clicked or focused; palette "Value:" commands act on it. */
  activeCard: ValueCard | null = null;
  readonly element: HTMLElement;
  private empty: HTMLElement;
  readonly blockOf = (card: ValueCard) => card.model.block;
  /** While above 0, relayout() only notes that a layout is due (see batch()). */
  private layoutHolds = 0;
  private layoutDue = false;
  /** Builds cards that come within a screen of the view and empties those
   *  that leave it, so only those hold elements. */
  private nearView: IntersectionObserver;
  private cardOf = new WeakMap<Element, ValueCard>();

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

    this.nearView = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          this.cardOf.get(entry.target)?.setNearView(entry.isIntersecting);
      },
      { root: this.element, rootMargin: "100% 0px" },
    );
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

  /** Puts the workspace back to a snapshot (undo / redo), keeping the scroll
   *  position. Cards whose value is the same in the snapshot are kept, so an
   *  undo only rebuilds what it changes, and those cards keep their selection,
   *  cursor and expression bar. */
  restore(snapshotJson: string) {
    const scroll = this.element.scrollTop;
    const data = JSON.parse(snapshotJson);
    const peripherals = peripheralsFromJSON(data.peripherals);
    const reusable = new Map<string, ValueCard[]>();

    for (const card of this.cards) {
      const key = JSON.stringify(valueToJSON(card.model));
      reusable.set(key, [...(reusable.get(key) ?? []), card]);
    }

    const kept = new Set<ValueCard>();

    const next = (data.values as unknown[]).map((serialized) => {
      const card = reusable.get(JSON.stringify(serialized))?.shift();
      if (card) {
        kept.add(card);
        return card;
      }

      return this.createCard(valueFromJSON(serialized));
    });

    // a kept register shows its peripheral's base address: redraw it when that changed
    const describe = (map: Map<string, Peripheral>, name: string) => {
      const peripheral = map.get(name);
      return peripheral ? JSON.stringify(peripheralToJSON(peripheral)) : "";
    };

    const changedBlocks = new Set(
      [...new Set([...this.peripherals.keys(), ...peripherals.keys()])].filter(
        (name) =>
          describe(this.peripherals, name) !== describe(peripherals, name),
      ),
    );

    this.batch(() => {
      for (const card of [...this.cards]) if (!kept.has(card)) this.drop(card);
      this.peripherals = peripherals;
      this.cards = next;

      for (const card of kept)
        if (changedBlocks.has(card.model.block)) card.rebuildWhenShown();

      this.relayout();
    });

    this.element.scrollTop = scroll;
  }

  /** Replaces every value and peripheral (validated JSON). */
  replace(values: unknown[], peripherals: unknown) {
    const models = values.map((serialized) => valueFromJSON(serialized));
    const blocks = peripheralsFromJSON(peripherals);

    this.batch(() => {
      this.clear();
      this.peripherals = blocks;

      for (const model of models)
        this.addValue(model.width, model, undefined, false);
    });
  }

  /** Runs `change` and lays the workspace out once at the end, instead of
   *  after every value it adds or removes. Batches can nest. */
  batch<T>(change: () => T): T {
    this.layoutHolds++;
    try {
      return change();
    } finally {
      if (--this.layoutHolds === 0 && this.layoutDue) {
        this.layoutDue = false;
        this.relayout();
      }
    }
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

    const card = this.createCard(model);
    this.cards.splice(index ?? this.cards.length, 0, card);
    this.relayout();
    this.app.history.touch();

    if (reveal) {
      play("add");
      card.root.classList.add("enter");
      requestAnimationFrame(() =>
        bringIntoView(card.root, "nearest", () => this.buildNearView()),
      );
    }

    return card;
  }

  /** A card for `model`, connected to this workspace (not placed yet). */
  private createCard(model: ValueModel): ValueCard {
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
    this.cardOf.set(card.root, card);
    this.nearView.observe(card.root);
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
    this.nearView.unobserve(card.root);
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
    if (this.layoutHolds) {
      this.layoutDue = true;
      return;
    }

    if (this.activeCard && !this.cards.includes(this.activeCard))
      this.activeCard = null;

    this.tidyPeripherals();
    const focused = document.activeElement;
    // what goes where: loose cards and peripheral blocks in the workspace,
    // each peripheral's cards in its block (they are next to each other)
    const children: HTMLElement[] = [];
    const blocks: { name: string; cards: HTMLElement[] }[] = [];

    for (const card of this.cards) {
      const block = card.model.block;
      if (!block) children.push(card.root);
      else if (blocks.at(-1)?.name === block)
        blocks.at(-1)!.cards.push(card.root);
      else {
        blocks.push({ name: block, cards: [card.root] });
        children.push(card.root); // stands for the block until it exists
      }
    }

    for (const { name, cards } of blocks) {
      const section = this.app.peripherals.section(name, cards.length);
      setChildren(section.body, cards);
      children[children.indexOf(cards[0])] = section.element;
    }

    this.app.peripherals.keepSections(new Set(blocks.map(({ name }) => name)));
    setChildren(this.element, this.cards.length ? children : [this.empty]);

    if (
      focused instanceof HTMLElement &&
      focused !== document.activeElement &&
      this.element.contains(focused)
    )
      focused.focus({ preventScroll: true });

    if (this.app.search.isOpen) this.app.search.apply();
    this.buildNearView();
  }

  /** Builds the cards on or near the screen right away, so they never show
   *  empty (the observer takes over when scrolling). */
  buildNearView() {
    const view = this.element.getBoundingClientRect();
    for (const card of this.cards) {
      if (card.built) continue;
      // hidden: in a collapsed peripheral, or filtered out by a search
      if (!card.root.offsetParent && view.height) continue;
      const rect = card.root.getBoundingClientRect();
      if (rect.top > view.bottom + view.height) break; // the rest is further down
      if (rect.bottom >= view.top - view.height) card.setNearView(true);
    }
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
        card.rebuildWhenShown(); // its header shows the peripheral's address
      }
    }

    for (const name of [...this.peripherals.keys()])
      if (!this.cards.some((card) => card.model.block === name))
        this.peripherals.delete(name);

    this.cards = groupOrder(this.cards, this.blockOf);
  }
}
