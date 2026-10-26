// A card's tool row: view (line / bytes / nibbles), compare or row order,
// all bases, operations, the expression bar toggle, and on the right the
// selection editor with "Group selection".

import {
  ArrowUpDown,
  Binary,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  GitCompareArrows,
  Group as GroupIcon,
  type IconNode,
  RectangleHorizontal,
  Rows3,
  Rows4,
  SquareFunction,
  X,
} from "lucide";
import type { Op, View } from "../core/model";
import { button, html, openMenu, segmented } from "../ui/kit";
import type { ValueCard } from "./card";
import { moreOpsMenu } from "./more-ops";
import { SelectionBar } from "./selection-bar";

const VIEW_UI: { value: View; label: string; icon: IconNode; tip: string }[] = [
  {
    value: "line",
    label: "Line",
    icon: RectangleHorizontal,
    tip: "All bits on one line, stretched to the window width (wraps when narrow)",
  },
  { value: "byte", label: "Bytes", icon: Rows3, tip: "One row per byte" },
  { value: "nibble", label: "Nibbles", icon: Rows4, tip: "One row per nibble" },
];

const SEL_NOTE = " — applies to the selection when bits are selected";

const OPS_UI: { value: Op; label?: string; icon?: IconNode; tip: string }[] = [
  {
    value: "invert",
    label: "NOT",
    tip: `Invert every bit (bitwise NOT)${SEL_NOTE}`,
  },
  { value: "clear", label: "CLR", tip: `Clear every bit to 0${SEL_NOTE}` },
  { value: "set", label: "SET", tip: `Set every bit to 1${SEL_NOTE}` },
  {
    value: "shl",
    icon: ChevronsLeft,
    tip: `Logical shift left by one bit${SEL_NOTE}`,
  },
  {
    value: "shr",
    icon: ChevronsRight,
    tip: `Logical shift right by one bit${SEL_NOTE}`,
  },
];

export class CardToolbar {
  /** The selected range and an editor for just those bits. Kept across rebuilds. */
  private selBar: SelectionBar;
  private groupBtn!: HTMLButtonElement;
  private clearSelBtn!: HTMLButtonElement;

  constructor(private card: ValueCard) {
    this.selBar = new SelectionBar(card.model, (lo, width, value, input) => {
      void card.commit(card.model.withBits(lo, width, value), {
        typing: input,
      });
    });
  }

  build(): HTMLElement {
    const card = this.card;
    const model = card.model;
    const view = segmented(VIEW_UI, {
      value: model.view,
      onPick: (view) => model.setView(view),
    });
    const centerElement = card.line
      ? button({
          icon: GitCompareArrows,
          label: "Compare",
          className: `outline${model.hasCompare(0) ? " on" : ""}`,
          tip: "Show a linked compare row under the bits",
          onClick: () =>
            model.hasCompare(0) ? model.removeCompare(0) : model.addCompare(0),
        })
      : button({
          icon: ArrowUpDown,
          label: model.msbFirst ? "MSB row first" : "LSB row first",
          className: "outline",
          tip: "Toggle row order. LSB first in byte view is the little-endian memory order.",
          onClick: () => model.setMsbFirst(!model.msbFirst),
        });
    const operationsControl = segmented(OPS_UI, {
      checkable: false,
      onPick: (operation) => card.applyOp(operation),
      className: "ops",
    });
    const moreOps = button({
      icon: ChevronDown,
      className: "ghost sm more-ops",
      tip: `More operations: rotate, swap bytes, reverse, negate, AND/OR/XOR…${SEL_NOTE}`,
    });
    moreOps.dataset.keepSel = "";
    moreOps.addEventListener("click", () =>
      openMenu(
        moreOpsMenu(
          (operation, argument) => card.applyOp(operation, argument),
          card.opWidth,
          card.lookup,
        ),
        moreOps,
      ),
    );
    const expr = button({
      icon: SquareFunction,
      className: `outline expr-toggle${card.exprOpen ? " on" : ""}`,
      tip: "Expression bar: type a calculation to set the value (or the selected bits)",
      onClick: () => card.toggleExpr(),
    });
    expr.dataset.keepSel = "";
    operationsControl.element.dataset.keepSel = "";
    const bases = button({
      icon: Binary,
      label: "Bases",
      className: `outline${model.showBases ? " on" : ""}`,
      tip: "Show the value in every base (BIN · OCT · DEC · HEX)",
      onClick: () => card.toggleBases(),
    });

    this.groupBtn = button({
      icon: GroupIcon,
      label: "Group selection",
      className: "accent-ghost",
      tip: "Make the selected bits a named register field (Ctrl+G)",
      onClick: () => card.createGroupFromSelection(),
    });
    this.groupBtn.dataset.keepSel = "";
    this.clearSelBtn = button({
      icon: X,
      className: "ghost",
      tip: "Clear selection (Esc)",
      onClick: () => card.clearSelection(),
    });
    return html(
      "div",
      { class: "card-tools" },
      view.element,
      centerElement,
      bases,
      html("div", { class: "ops-wrap" }, operationsControl.element, moreOps),
      expr,
      html("div", { class: "spacer" }),
      this.selBar.element,
      this.groupBtn,
      this.clearSelBtn,
    );
  }

  /** Shows the selection (or that there is none). */
  update(selection: [number, number] | null) {
    this.selBar.update(selection);
    this.groupBtn.disabled = !selection;
    this.clearSelBtn.hidden = !selection;
  }
}
