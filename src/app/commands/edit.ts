// Edit menu: undo, adding values, selection, find and the command palette.

import {
  Command as CommandIcon,
  LayoutTemplate,
  Plus,
  Redo2,
  Ruler,
  Search,
  SquareFunction,
  Undo2,
} from "lucide";
import { toast } from "../../ui/kit";
import { play } from "../../ui/sound";
import type { App } from "../app";
import { openPalette } from "../palette";
import {
  addCustomValue,
  addValueFromExpression,
  addValueFromTemplate,
} from "../workspace/value-dialogs";
import type { Command } from "./registry";

export function editCommands(app: App): Command[] {
  const { history, workspace } = app;
  return [
    {
      id: "edit.undo",
      group: "Edit",
      label: "Undo",
      icon: Undo2,
      keys: ["Ctrl+Z"],
      enabled: () => history.canUndo,
      run: () => {
        if (history.undo()) play("op");
      },
    },
    {
      id: "edit.redo",
      group: "Edit",
      label: "Redo",
      icon: Redo2,
      keys: ["Ctrl+Y", "Ctrl+Shift+Z"],
      enabled: () => history.canRedo,
      run: () => {
        if (history.redo()) play("op");
      },
    },
    {
      id: "value.add32",
      group: "Edit",
      label: "Add 32-bit value",
      icon: Plus,
      keys: ["Ctrl+1"],
      run: () => workspace.addValue(32),
    },
    {
      id: "value.add64",
      group: "Edit",
      label: "Add 64-bit value",
      icon: Plus,
      keys: ["Ctrl+2"],
      run: () => workspace.addValue(64),
    },
    {
      id: "value.addCustom",
      group: "Edit",
      label: "Add value with custom width…",
      icon: Ruler,
      keys: ["Ctrl+3"],
      keywords: "bits width size",
      run: () => addCustomValue(workspace),
    },
    {
      id: "sel.group",
      group: "Edit",
      label: "Group selection",
      keys: ["Ctrl+G"],
      keywords: "field register",
      run: () => {
        if (!workspace.groupSelection())
          toast("Select some bits first (drag across them)");
      },
    },
    {
      id: "sel.clear",
      group: "Edit",
      label: "Clear selection",
      keys: ["Esc"],
      run: () => workspace.clearSelections(),
    },
    {
      id: "edit.find",
      group: "Edit",
      label: "Find…",
      icon: Search,
      keys: ["Ctrl+F"],
      keywords: "search filter",
      run: () => app.search.open(),
    },
    {
      id: "app.palette",
      group: "Help",
      label: "Command palette…",
      icon: CommandIcon,
      keys: ["Ctrl+K", "Ctrl+Shift+P"],
      keywords: "actions run",
      run: () => openPalette(app.commands),
      hidden: true,
    },
    {
      id: "value.fromTemplate",
      group: "Edit",
      label: "Add value from template…",
      icon: LayoutTemplate,
      keywords: "float ieee rgb ipv4 layout fields preset",
      run: () => addValueFromTemplate(workspace),
    },
    {
      id: "value.fromExpr",
      group: "Edit",
      label: "New value from expression…",
      icon: SquareFunction,
      keywords: "calculate combine and or xor add",
      run: () => addValueFromExpression(workspace),
    },
  ];
}
