// The card that shows one value (1 to 512 bits). It owns the selection, the
// keyboard cursor and the expression bar, routes every change of the value
// through commit() (which asks first for read-only and reserved fields), and
// redraws its parts when the model changes:
//
//   header.ts        name, width, address, whole value, Copy, "More" menu
//   toolbar.ts       view, compare, bases, operations, selection editor
//   rows.ts          the bit strips with their row editors and compare rows
//   bases-panel.ts   the value in every base
//   fields-panel.ts  register fields
//   stats.ts         readout chips (signed, floats, …)
//   menus.ts, actions.ts, keyboard.ts, protect.ts, selection.ts  behaviour

import {
  applyOp,
  type ChangeKind,
  ModelError,
  type Op,
  type ValueModel,
} from "../core/model";
import type { Peripheral } from "../core/workspace";
import { html, type MenuItem, openMenu, toast } from "../ui/kit";
import { play } from "../ui/sound";
import * as actions from "./actions";
import { BasesPanel } from "./bases-panel";
import type { StripHost } from "./bitstrip";
import { expressionBar } from "./expr-bar";
import { FieldsPanel } from "./fields-panel";
import { CardHeader } from "./header";
import { rowMenu } from "./menus";
import { ProtectedFields } from "./protect";
import { bitTip, RowsView } from "./rows";
import { BitSelection } from "./selection";
import { StatsBar } from "./stats";
import { CardToolbar } from "./toolbar";

/** About how tall a card is once built, in pixels: measured on the default
 *  look (compact mode is a little shorter). Only used until it is built. */
export function estimatedHeight(model: ValueModel): number {
  if (model.collapsed) return 56;
  const rows =
    model.view === "line"
      ? 77 * Math.ceil(model.width / 32)
      : 71 * model.rowLos().length;
  const fields = model.groups.length ? 36 + 36 * model.groups.length : 0;
  return (
    207 + rows + fields + 56 * model.compares.size + (model.showBases ? 210 : 0)
  );
}

/** What a card asks of the workspace around it. */
export interface CardEvents {
  remove(card: ValueCard): void;
  move(card: ValueCard, delta: number): void;
  duplicate(card: ValueCard): void;
  resize(card: ValueCard): void;
  /** Value of another card by name, for expressions. */
  lookup(card: ValueCard, name: string): bigint | undefined;
  /** The other cards in the workspace. */
  others(card: ValueCard): ValueCard[];
  /** The drag handle was pressed: start reordering. */
  dragStart(card: ValueCard, event: PointerEvent): void;
  /** Group the following changes into one undo step (true) / end the group (false). */
  batch(holding: boolean): void;
  /** The peripheral the value is a register of, if any. */
  peripheral(card: ValueCard): Peripheral | undefined;
  /** Entries for the card's "Peripheral" submenu. */
  peripheralMenu(card: ValueCard): MenuItem[];
  /** Asks for a new offset within the peripheral. */
  editOffset(card: ValueCard): void;
}

export class ValueCard implements StripHost {
  root: HTMLElement;
  /** Keyboard cursor position (a bit index), or null. */
  cursor: number | null = null;
  readonly rows = new RowsView(this);
  private header = new CardHeader(this);
  private toolbar: CardToolbar;
  private bases = new BasesPanel(this);
  private fields = new FieldsPanel(this);
  private statsBar: StatsBar;
  private guard: ProtectedFields;
  private bits = new BitSelection();
  private static nextUid = 1;
  private readonly uniqueId = ValueCard.nextUid++;
  private showExpr = false;
  private exprText = "";
  /** Re-evaluates the open expression bar; null while it's closed. */
  private exprRefresh: (() => void) | null = null;
  private listener = (kind: ChangeKind) => this.onModel(kind);
  /** Whether the card's contents exist. A card far out of view is an empty
   *  box (the workspace builds it when it comes near, see setNearView), so a
   *  large workspace doesn't hold a million elements. */
  built = false;

  /** The card starts empty: the workspace builds it once it is placed near
   *  the screen. */
  constructor(
    public model: ValueModel,
    readonly events: CardEvents,
  ) {
    this.root = html("section", { class: "card" });
    this.guard = new ProtectedFields(model);
    this.toolbar = new CardToolbar(this);
    this.statsBar = new StatsBar(model, (value) => this.commit(value));
    model.subscribe(this.listener);
    this.reserveSpace();
  }

  /** The card came near the screen (build it) or went far away (empty it,
   *  unless something in it has the keyboard focus). */
  setNearView(near: boolean) {
    if (near && !this.built) this.rebuild();
    else if (!near && this.built && !this.root.contains(document.activeElement))
      this.unbuild();
  }

  /** While the card is empty, the room it will take once built, so the
   *  scroll bar and the positions of other cards are about right. The
   *  browser remembers the real size once the card has been shown. */
  private reserveSpace() {
    const height = estimatedHeight(this.model);
    this.root.style.minHeight = `${height}px`;
    // the content box: without the card's padding and border
    this.root.style.containIntrinsicSize = `auto ${height - 32}px`;
  }

  private unbuild() {
    this.rows.destroy();
    this.fields.clear();
    this.root.replaceChildren();
    this.reserveSpace();
    this.built = false;
  }

  /** Resolves a name in an expression: x / this / value, this card's fields, then other values. */
  lookup = (name: string): bigint | undefined => {
    const model = this.model;
    const normalizedName = name.trim().toLowerCase();
    if (["x", "this", "value", "v"].includes(normalizedName))
      return model.value;
    const group = model.groups.find(
      (field) => field.name.toLowerCase() === normalizedName,
    );
    if (group) return model.groupValue(group);
    return this.events.lookup(this, name);
  };

  /** True in line view (all bits in one strip). */
  get line(): boolean {
    return this.model.view === "line";
  }

  /** True while the expression bar is shown. */
  get exprOpen(): boolean {
    return this.showExpr;
  }

  /** Width that operations act on: the selection, or the whole value. */
  get opWidth(): number {
    return this.selection
      ? this.selection[1] - this.selection[0] + 1
      : this.model.width;
  }

  // ================================================================ changes
  /** Runs an operation on the selected bits, or on the whole value when nothing is selected. */
  async applyOp(operation: Op, argument?: bigint) {
    const model = this.model;
    let next: bigint;
    try {
      if (this.selection) {
        const [lo, hi] = this.selection;
        const width = hi - lo + 1;
        next = model.withBits(
          lo,
          width,
          applyOp(operation, model.bitsValue(lo, width), width, argument),
        );
      } else next = applyOp(operation, model.value, model.width, argument);
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      play("error");
      toast(error.message, "error");
      return;
    }
    if (await this.commit(next)) play("op");
  }

  /** Sets the whole value, asking first when that changes a read-only or
   *  reserved field. `typing` is the text box the change comes from: "Change it"
   *  then holds until it loses focus, so each keystroke doesn't ask again.
   *  Resolves false when the user cancels (the display is restored). */
  async commit(
    next: bigint,
    options: { typing?: HTMLElement; onCancel?: () => void } = {},
  ): Promise<boolean> {
    // only wait when there is something to ask, so an ordinary change applies
    // at once (before any input that follows in the same task)
    const blocked = this.guard.blockedBy(next);
    if (
      blocked.length &&
      !(await this.guard.confirm(blocked, options.typing))
    ) {
      options.onCancel?.();
      this.refresh();
      return false;
    }
    this.model.setValue(next);
    return true;
  }

  /** Flips a bit; for read-only / reserved fields, asks first. */
  async flipBit(bit: number) {
    const model = this.model;
    if (!(await this.commit(model.value ^ (1n << BigInt(bit))))) return;
    play(model.bit(bit) ? "bitOn" : "bitOff");
  }

  /** Alt+drag painting: one undo step, and protected fields are skipped. */
  paintStart() {
    this.events.batch(true);
    this.clearSelection();
  }

  paintBit(bit: number, isOn: boolean) {
    const group = this.model.groupAt(bit);
    if (group?.protected && !this.guard.isUnlocked(group)) return; // painting never touches protected fields
    if (this.model.bit(bit) === (isOn ? 1 : 0)) return;
    this.model.setBitsValue(bit, 1, isOn ? 1n : 0n);
    play(isOn ? "bitOn" : "bitOff");
  }

  paintEnd() {
    this.events.batch(false);
  }

  /** Stops listening to the model (the card is being removed). */
  detach() {
    this.model.unsubscribe(this.listener);
    this.rows.destroy();
  }

  // an empty card needs no updates: it is built from the model when it comes near
  private onModel(kind: ChangeKind) {
    if (!this.built && kind !== "value") this.reserveSpace();
    if (kind === "structure" || kind === "groups") this.rebuildWhenShown();
    else if (kind !== "meta") this.refresh();
  }

  /** Rebuilds the contents if they exist (an empty card is built up to date later). */
  rebuildWhenShown() {
    if (this.built) this.rebuild();
  }

  // ================================================================ drawing
  /** Builds the card's contents from scratch. */
  rebuild() {
    this.built = true;
    this.root.style.minHeight = "";
    this.rows.destroy();
    const model = this.model;
    const focusedName =
      document.activeElement?.classList.contains("name-edit") &&
      this.root.contains(document.activeElement);

    this.root.classList.toggle("collapsed", model.collapsed);
    if (model.collapsed) {
      // only the header line; the toolbar's buttons are still created because
      // selection code updates them
      this.fields.clear();
      const header = this.header.build();
      this.toolbar.build();
      this.root.replaceChildren(header);
      if (focusedName)
        (this.root.querySelector(".name-edit") as HTMLElement).focus();
      this.refresh();
      return;
    }

    const rows = this.rows.build();
    this.root.replaceChildren(
      ...[
        this.header.build(),
        this.toolbar.build(),
        this.showExpr ? this.buildExprBar() : null,
        rows,
        this.bases.build(),
        this.fields.build(),
        this.buildStats(),
      ].filter((element): element is HTMLElement => element !== null),
    );
    if (focusedName)
      (this.root.querySelector(".name-edit") as HTMLElement).focus();
    this.refresh();
  }

  /** Shows the current value everywhere, without rebuilding. */
  refresh() {
    if (!this.built) return;
    this.header.update();
    this.rows.update();
    this.bases.update();
    if (this.showExpr) this.exprRefresh?.();
    this.fields.update();
    this.statsBar.update();
    this.toolbar.update(this.selection);
  }

  private buildExprBar(): HTMLElement {
    const bar = expressionBar({
      width: () => this.opWidth,
      lookup: this.lookup,
      target: () =>
        this.selection
          ? `bits [${this.selection[1]}:${this.selection[0]}]`
          : "value",
      text: this.exprText,
      onText: (text) => {
        this.exprText = text;
      },
      apply: async (value) => {
        const next = this.selection
          ? this.model.withBits(this.selection[0], this.opWidth, value)
          : value;
        if (await this.commit(next)) play("op");
      },
      close: () => this.toggleExpr(false),
    });
    this.exprRefresh = bar.refresh;
    return bar.element;
  }

  private buildStats(): HTMLElement {
    this.statsBar.build();
    return this.statsBar.element;
  }

  toggleExpr(open = !this.showExpr) {
    this.showExpr = open;
    play("toggle");
    this.rebuild();
  }

  toggleBases() {
    play("toggle");
    this.model.setShowBases(!this.model.showBases);
  }

  toggleCollapsed(collapsed = !this.model.collapsed) {
    play("toggle");
    this.model.setCollapsed(collapsed);
  }

  /** Highlights fields that match a search (an empty set clears). */
  markMatches(names: Set<string>) {
    this.fields.markMatches(names);
  }

  // ================================================================ bit cells
  bitId(bit: number): string {
    return `v${this.uniqueId}-bit${bit}`;
  }

  bitTip(bit: number, lo: number, compare: boolean): string {
    return bitTip(this.model, bit, lo, compare);
  }

  setCursor(bit: number, focus = true) {
    const model = this.model;
    this.cursor = Math.max(0, Math.min(model.width - 1, bit));
    this.rows.repaint();
    this.rows.element?.setAttribute(
      "aria-activedescendant",
      this.bitId(this.cursor),
    );
    if (focus) this.rows.element?.focus({ preventScroll: true });
    document
      .getElementById(this.bitId(this.cursor))
      ?.scrollIntoView({ block: "nearest" });
  }

  openRowMenu(
    lo: number,
    compare: boolean,
    bit: number | null,
    position: { x: number; y: number },
  ) {
    openMenu(rowMenu(this, lo, compare, bit), position);
  }

  // ================================================================ selection
  get selection(): [number, number] | null {
    return this.bits.range;
  }

  setSelection(fromBit: number, toBit: number) {
    this.bits.set(fromBit, toBit);
    this.selectionChanged();
  }

  clearSelection() {
    if (this.bits.clear()) this.selectionChanged();
  }

  beginDrag(bit: number) {
    this.bits.begin(bit);
  }

  updateDrag(bit: number) {
    const before = this.selection?.join();
    if (!this.bits.drag(bit)) return;
    this.selectionChanged();
    if (this.selection?.join() !== before) play("select");
  }

  extendSelection(bit: number) {
    this.bits.extend(bit);
    this.selectionChanged();
  }

  extendSelectionFromCursor(current: number, next: number) {
    this.bits.extendFromCursor(current, next);
    this.selectionChanged();
  }

  /** A row label was clicked (with Shift: extend over the rows in between). */
  selectRows(lo: number, shift: boolean) {
    this.bits.selectRows(
      lo,
      shift,
      (rowStart) => rowStart + this.model.rowWidthAt(rowStart) - 1,
    );
    this.selectionChanged();
  }

  private selectionChanged() {
    if (!this.built) return;
    this.rows.repaint();
    this.toolbar.update(this.selection);
  }

  // ================================================================ dialogs
  createGroupFromSelection() {
    return actions.createGroupFromSelection(this);
  }

  applyTemplate() {
    return actions.applyTemplate(this);
  }

  saveAsTemplate() {
    return actions.saveAsTemplate(this);
  }

  takeSnapshot() {
    return actions.takeSnapshot(this);
  }

  pasteBytes() {
    return actions.pasteBytes(this);
  }

  compareWith() {
    return actions.compareWith(this);
  }

  exportCode() {
    actions.exportCode(this);
  }
}
