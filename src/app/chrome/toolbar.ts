// The toolbar under the title bar: add values, open, save, undo / redo, the
// base of all rows, theme and settings.

import {
  FolderOpen,
  Moon,
  Plus,
  Redo2,
  Ruler,
  Save,
  SlidersHorizontal,
  Sun,
  Undo2,
} from "lucide";
import { BASE_NAMES, BASE_ORDER } from "../../core/format/integers";
import { MAX_WIDTH, MIN_WIDTH } from "../../core/model";
import { appSettings } from "../../platform/settings";
import { button, html, icon, segmented } from "../../ui/kit";
import type { App } from "../app";
import { applyGlobalBase, toggleTheme } from "../view";

export class Toolbar {
  readonly element: HTMLElement;
  private themeBtn: HTMLButtonElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;

  constructor(app: App) {
    const allRows = segmented(
      BASE_ORDER.map((base) => ({
        value: base,
        label: BASE_NAMES[base],
        tip: `Switch every row of every value to ${BASE_NAMES[base]}`,
      })),
      {
        checkable: false,
        onPick: (base) => applyGlobalBase(app.workspace, base),
      },
    );
    this.themeBtn = button({
      className: "ghost",
      tip: "Toggle light / dark theme (Ctrl+T)",
      onClick: () => toggleTheme(),
    });
    this.syncTheme();
    const run = (id: string) => () => app.commands.run(id);
    this.undoBtn = button({
      icon: Undo2,
      className: "ghost",
      tip: "Undo (Ctrl+Z)",
      onClick: run("edit.undo"),
    });
    this.redoBtn = button({
      icon: Redo2,
      className: "ghost",
      tip: "Redo (Ctrl+Y)",
      onClick: run("edit.redo"),
    });
    this.element = html(
      "div",
      { class: "toolbar" },
      button({
        icon: Plus,
        label: "32-bit",
        className: "primary",
        tip: "Add a 32-bit value (Ctrl+1)",
        onClick: run("value.add32"),
      }),
      button({
        icon: Plus,
        label: "64-bit",
        className: "primary",
        tip: "Add a 64-bit value (Ctrl+2)",
        onClick: run("value.add64"),
      }),
      button({
        icon: Ruler,
        label: "Custom",
        className: "outline",
        tip: `Add a value with any width, ${MIN_WIDTH}–${MAX_WIDTH} bits (Ctrl+3)`,
        onClick: run("value.addCustom"),
      }),
      html("div", { class: "tb-sep" }),
      button({
        icon: FolderOpen,
        label: "Open",
        className: "ghost",
        tip: "Open a workspace (Ctrl+O)",
        onClick: run("file.open"),
      }),
      button({
        icon: Save,
        label: "Save",
        className: "ghost",
        tip: "Save the workspace (Ctrl+S)",
        onClick: run("file.save"),
      }),
      html("div", { class: "tb-sep" }),
      this.undoBtn,
      this.redoBtn,
      html("div", { class: "tb-sep" }),
      html("span", { class: "tb-label" }, "All rows"),
      allRows.element,
      html("div", { class: "spacer" }),
      this.themeBtn,
      button({
        icon: SlidersHorizontal,
        label: "Settings",
        className: "ghost",
        tip: "Settings (Ctrl+,)",
        onClick: run("app.settings"),
      }),
    );
  }

  /** The theme button offers the other theme. */
  syncTheme() {
    const dark = appSettings.get("theme") === "dark";
    this.themeBtn.replaceChildren(
      icon(dark ? Sun : Moon, 16),
      html("span", {}, dark ? "Light" : "Dark"),
    );
  }

  syncHistory(canUndo: boolean, canRedo: boolean) {
    this.undoBtn.disabled = !canUndo;
    this.redoBtn.disabled = !canRedo;
  }
}
