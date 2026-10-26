// Palette commands that act on the current value ("Value: …"): the one last
// clicked or focused, or the first one.

import {
  Camera,
  ChevronsUpDown,
  FileCode2,
  LayoutTemplate,
  Ruler,
  SquareFunction,
} from "lucide";
import type { ValueCard } from "../../card/card";
import type { App } from "../app";
import { resizeValue } from "../workspace/value-dialogs";
import type { Command } from "./registry";

export function valueCommands(app: App): Command[] {
  const workspace = app.workspace;
  const card = () => workspace.activeCard ?? workspace.cards[0] ?? null;
  const named = (label: string) => () => {
    const activeCard = card();
    return activeCard
      ? `${label} — ${activeCard.model.name || "value"}`
      : label;
  };
  const has = () => card() !== null;
  const runOnActiveCard = (action: (card: ValueCard) => unknown) => () => {
    const activeCard = card();
    if (activeCard) void action(activeCard);
  };
  return [
    {
      id: "card.collapse",
      group: "Value",
      label: named("Collapse / expand"),
      icon: ChevronsUpDown,
      enabled: has,
      run: runOnActiveCard((card) => card.toggleCollapsed()),
    },
    {
      id: "card.snapshot",
      group: "Value",
      label: named("Take snapshot…"),
      icon: Camera,
      enabled: has,
      run: runOnActiveCard((card) => card.takeSnapshot()),
    },
    {
      id: "card.export",
      group: "Value",
      label: named("Export code…"),
      icon: FileCode2,
      keywords: "c rust python header",
      enabled: has,
      run: runOnActiveCard((card) => card.exportCode()),
    },
    {
      id: "card.template",
      group: "Value",
      label: named("Apply template…"),
      icon: LayoutTemplate,
      enabled: has,
      run: runOnActiveCard((card) => card.applyTemplate()),
    },
    {
      id: "card.saveTemplate",
      group: "Value",
      label: named("Save fields as template…"),
      enabled: has,
      run: runOnActiveCard((card) => card.saveAsTemplate()),
    },
    {
      id: "card.expr",
      group: "Value",
      label: named("Expression bar"),
      icon: SquareFunction,
      keywords: "calculate formula",
      enabled: has,
      run: runOnActiveCard((card) => card.toggleExpr()),
    },
    {
      id: "card.bases",
      group: "Value",
      label: named("Show / hide all bases"),
      keywords: "hex dec oct bin",
      enabled: has,
      run: runOnActiveCard((card) => card.toggleBases()),
    },
    {
      id: "card.paste",
      group: "Value",
      label: named("Paste bytes…"),
      keywords: "endian",
      enabled: has,
      run: runOnActiveCard((card) => card.pasteBytes()),
    },
    {
      id: "card.swap",
      group: "Value",
      label: named("Swap bytes"),
      keywords: "endian bswap",
      enabled: has,
      run: runOnActiveCard((card) => card.applyOp("bswap")),
    },
    {
      id: "card.not",
      group: "Value",
      label: named("Invert bits (NOT)"),
      enabled: has,
      run: runOnActiveCard((card) => card.applyOp("invert")),
    },
    {
      id: "card.clear",
      group: "Value",
      label: named("Clear to 0"),
      enabled: has,
      run: runOnActiveCard((card) => card.applyOp("clear")),
    },
    {
      id: "card.duplicate",
      group: "Value",
      label: named("Duplicate"),
      enabled: has,
      run: runOnActiveCard((card) => workspace.duplicateValue(card)),
    },
    {
      id: "card.width",
      group: "Value",
      label: named("Change width…"),
      icon: Ruler,
      enabled: has,
      run: runOnActiveCard((card) => resizeValue(card)),
    },
    {
      id: "card.remove",
      group: "Value",
      label: named("Remove"),
      enabled: has,
      run: runOnActiveCard((card) => workspace.removeValue(card)),
    },
  ];
}
