// Main window: title bar, menus, toolbar, workspace, status bar, save/load.
// Actions live in the command registry (commands.ts); this file wires them up.
import {
  CircleQuestionMark,
  FilePlus,
  FolderOpen,
  Info,
  LogOut,
  Maximize,
  Minimize,
  Minus,
  Moon,
  Plus,
  RotateCcw,
  Ruler,
  Save,
  SaveAll,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Square,
  Sun,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide";
import { ValueCard } from "./card";
import { CommandRegistry } from "./commands";
import { showAbout, showControls } from "./dialogs/help";
import { openSettings } from "./dialogs/settings";
import { pickWidth } from "./dialogs/width";
import { logoSvg } from "./logo";
import { MAX_WIDTH, MIN_WIDTH, ModelError, ValueModel } from "./model";
import { BASE_NAMES, BASE_ORDER, type Base } from "./numfmt";
import * as P from "./platform";
import { S, ZOOM_STEP } from "./settings";
import { play } from "./sound";
import { ask, button, h, icon, menusOpen, modalOpen, openMenu, segmented, toast } from "./ui";

const FILE_VERSION = 1;

export class App {
  readonly commands = new CommandRegistry();
  cards: ValueCard[] = [];
  private path: string | null = null;
  private fileName = "Untitled";
  private dirty = false;
  private workspace!: HTMLElement;
  private empty!: HTMLElement;
  private titleFile!: HTMLElement;
  private zoomLabel!: HTMLElement;
  private themeBtn!: HTMLButtonElement;
  private maxBtn!: HTMLButtonElement;
  private wheelAcc = 0;

  constructor(private root: HTMLElement) {}

  async start() {
    this.registerCommands();
    this.applyTheme();
    await P.setZoom(S.get("zoom"));
    this.root.replaceChildren(this.buildTitlebar(), this.buildToolbar(), this.buildWorkspace(), this.buildStatusbar());
    this.installInput();
    S.onChange((k) => this.onSetting(k));
    await P.guardClose(() => this.maybeSave());
    await P.onResized(() => this.syncMaxButton());
    this.syncMaxButton();

    const initial = await P.initialFile();
    if (!initial || !(await this.loadPath(initial))) {
      this.addValue(32);
      this.setDirty(false);
    }
  }

  // ================================================================ commands
  private registerCommands() {
    const dark = () => S.get("theme") === "dark";
    this.commands.add(
      // File
      {
        id: "file.new",
        group: "File",
        label: "New workspace",
        icon: FilePlus,
        keys: ["Ctrl+N"],
        run: () => this.newWorkspace(),
      },
      {
        id: "file.open",
        group: "File",
        label: "Open…",
        icon: FolderOpen,
        keys: ["Ctrl+O"],
        run: () => this.openFile(),
      },
      { id: "file.save", group: "File", label: "Save", icon: Save, keys: ["Ctrl+S"], run: () => this.save() },
      {
        id: "file.saveAs",
        group: "File",
        label: "Save as…",
        icon: SaveAll,
        keys: ["Ctrl+Shift+S"],
        run: () => this.saveAs(),
      },
      { id: "file.quit", group: "File", label: "Quit", icon: LogOut, run: () => P.closeWindow() },
      // Edit
      {
        id: "value.add32",
        group: "Edit",
        label: "Add 32-bit value",
        icon: Plus,
        keys: ["Ctrl+1"],
        run: () => this.addValue(32),
      },
      {
        id: "value.add64",
        group: "Edit",
        label: "Add 64-bit value",
        icon: Plus,
        keys: ["Ctrl+2"],
        run: () => this.addValue(64),
      },
      {
        id: "value.addCustom",
        group: "Edit",
        label: "Add value with custom width…",
        icon: Ruler,
        keys: ["Ctrl+3"],
        keywords: "bits width size",
        run: () => this.addCustom(),
      },
      {
        id: "sel.group",
        group: "Edit",
        label: "Group selection",
        keys: ["Ctrl+G"],
        keywords: "field register",
        run: () => this.groupSelection(),
      },
      { id: "sel.clear", group: "Edit", label: "Clear selection", keys: ["Esc"], run: () => this.clearSelections() },
      // View
      {
        id: "view.zoomIn",
        group: "View",
        label: "Zoom in",
        icon: ZoomIn,
        keys: ["Ctrl+=", "Ctrl++"],
        run: () => this.zoomBy(1),
      },
      {
        id: "view.zoomOut",
        group: "View",
        label: "Zoom out",
        icon: ZoomOut,
        keys: ["Ctrl+-"],
        run: () => this.zoomBy(-1),
      },
      {
        id: "view.zoomReset",
        group: "View",
        label: "Reset zoom",
        icon: RotateCcw,
        keys: ["Ctrl+0"],
        run: () => S.set("zoom", 1),
      },
      {
        id: "view.theme",
        group: "View",
        label: () => (dark() ? "Light theme" : "Dark theme"),
        icon: () => (dark() ? Sun : Moon),
        keys: ["Ctrl+T"],
        run: () => this.toggleTheme(),
      },
      {
        id: "view.sounds",
        group: "View",
        label: () => (S.get("sounds") ? "Turn sounds off" : "Turn sounds on"),
        icon: () => (S.get("sounds") ? VolumeX : Volume2),
        keywords: "audio mute",
        run: () => this.toggleSounds(),
      },
      {
        id: "app.settings",
        group: "View",
        label: "Settings…",
        icon: SettingsIcon,
        keys: ["Ctrl+,"],
        keywords: "preferences options",
        run: () => openSettings(),
      },
      // Help
      {
        id: "help.controls",
        group: "Help",
        label: "Controls & shortcuts",
        icon: CircleQuestionMark,
        keys: ["F1"],
        run: () => showControls(this.commands),
      },
      { id: "help.about", group: "Help", label: "About Bit Viewer", icon: Info, run: () => showAbout() },
      // swallow browser shortcuts that make no sense in an app window
      {
        id: "noop.browser",
        group: "Help",
        label: "",
        keys: ["Ctrl+R", "Ctrl+P", "Ctrl+F", "F5"],
        hidden: true,
        run: () => {},
      },
    );
  }

  private menus(): [string, (string | "sep")[]][] {
    return [
      ["File", ["file.new", "file.open", "sep", "file.save", "file.saveAs", "sep", "file.quit"]],
      ["Edit", ["value.add32", "value.add64", "value.addCustom", "sep", "sel.group", "sel.clear"]],
      [
        "View",
        ["view.zoomIn", "view.zoomOut", "view.zoomReset", "sep", "view.theme", "view.sounds", "sep", "app.settings"],
      ],
      ["Help", ["help.controls", "help.about"]],
    ];
  }

  // ================================================================ chrome
  private buildTitlebar(): HTMLElement {
    const menuBar = h("nav", { class: "menubar" });
    for (const [name, ids] of this.menus()) {
      const b = h("button", { type: "button", class: "menubar-item", "data-keep-sel": "" }, name);
      b.addEventListener("click", () => openMenu(this.commands.menu(ids), b));
      b.addEventListener("pointerenter", () => {
        // slide between open menus like a native menu bar
        if (menusOpen() && document.querySelector(".menubar-item.menu-open") && !b.classList.contains("menu-open")) {
          openMenu(this.commands.menu(ids), b);
        }
      });
      menuBar.append(b);
    }
    this.titleFile = h("span", { class: "title-file" });
    this.maxBtn = h("button", { type: "button", class: "win-btn", tip: "Maximize" }, icon(Square, 13));
    this.maxBtn.addEventListener("click", async () => {
      await P.toggleMaximize();
      this.syncMaxButton();
    });
    const controls = P.isTauri
      ? h(
          "div",
          { class: "win-controls" },
          h(
            "button",
            { type: "button", class: "win-btn", tip: "Minimize", onClick: () => P.minimize() },
            icon(Minus, 15),
          ),
          this.maxBtn,
          h(
            "button",
            { type: "button", class: "win-btn close", tip: "Close", onClick: () => P.closeWindow() },
            icon(X, 16),
          ),
        )
      : null;
    const drag = h(
      "div",
      { class: "drag", "data-tauri-drag-region": "" },
      h("span", { class: "title-text", "data-tauri-drag-region": "" }, "Bit Viewer"),
      this.titleFile,
    );
    return h(
      "div",
      { class: "titlebar" },
      h("div", { class: "brand", "data-tauri-drag-region": "" }, logoSvg(20)),
      menuBar,
      drag,
      controls,
    );
  }

  private async syncMaxButton() {
    if (!P.isTauri) return;
    const max = await P.isMaximized();
    this.maxBtn.replaceChildren(icon(max ? Minimize : Maximize, 13));
  }

  private buildToolbar(): HTMLElement {
    const allRows = segmented(
      BASE_ORDER.map((b) => ({
        value: b,
        label: BASE_NAMES[b],
        tip: `Switch every row of every value to ${BASE_NAMES[b]}`,
      })),
      { checkable: false, onPick: (b) => this.applyGlobalBase(b) },
    );
    this.themeBtn = button({
      cls: "ghost",
      tip: "Toggle light / dark theme (Ctrl+T)",
      onClick: () => this.toggleTheme(),
    });
    this.syncThemeButton();
    const run = (id: string) => () => this.commands.run(id);
    return h(
      "div",
      { class: "toolbar" },
      button({
        icon: Plus,
        label: "32-bit",
        cls: "primary",
        tip: "Add a 32-bit value (Ctrl+1)",
        onClick: run("value.add32"),
      }),
      button({
        icon: Plus,
        label: "64-bit",
        cls: "primary",
        tip: "Add a 64-bit value (Ctrl+2)",
        onClick: run("value.add64"),
      }),
      button({
        icon: Ruler,
        label: "Custom",
        cls: "outline",
        tip: `Add a value with any width, ${MIN_WIDTH}–${MAX_WIDTH} bits (Ctrl+3)`,
        onClick: run("value.addCustom"),
      }),
      h("div", { class: "tb-sep" }),
      button({
        icon: FolderOpen,
        label: "Open",
        cls: "ghost",
        tip: "Open a workspace (Ctrl+O)",
        onClick: run("file.open"),
      }),
      button({
        icon: Save,
        label: "Save",
        cls: "ghost",
        tip: "Save the workspace (Ctrl+S)",
        onClick: run("file.save"),
      }),
      h("div", { class: "tb-sep" }),
      h("span", { class: "tb-label" }, "All rows"),
      allRows.el,
      h("div", { class: "spacer" }),
      this.themeBtn,
      button({
        icon: SlidersHorizontal,
        label: "Settings",
        cls: "ghost",
        tip: "Settings (Ctrl+,)",
        onClick: run("app.settings"),
      }),
    );
  }

  private syncThemeButton() {
    const dark = S.get("theme") === "dark";
    this.themeBtn.replaceChildren(icon(dark ? Sun : Moon, 16), h("span", {}, dark ? "Light" : "Dark"));
  }

  private buildWorkspace(): HTMLElement {
    const run = (id: string) => () => this.commands.run(id);
    this.empty = h(
      "div",
      { class: "empty" },
      logoSvg(56),
      h("h3", {}, "No values yet"),
      h("p", { class: "muted" }, "Add a value to start inspecting bits."),
      h(
        "div",
        { class: "empty-actions" },
        button({ icon: Plus, label: "32-bit value", cls: "primary", onClick: run("value.add32") }),
        button({ icon: Plus, label: "64-bit value", cls: "outline", onClick: run("value.add64") }),
        button({ icon: Ruler, label: "Custom width", cls: "outline", onClick: run("value.addCustom") }),
      ),
    );
    this.workspace = h("main", { class: "workspace" }, this.empty);
    return this.workspace;
  }

  private buildStatusbar(): HTMLElement {
    this.zoomLabel = h("button", {
      type: "button",
      class: "zoom-label",
      tip: "Reset zoom (Ctrl+0)",
      onClick: () => S.set("zoom", 1),
    });
    this.updateZoomLabel();
    return h(
      "footer",
      { class: "statusbar" },
      h(
        "span",
        { class: "status-hint" },
        "Click a bit to flip · drag to select · right-click for row actions · F1 for help",
      ),
      h("div", { class: "spacer" }),
      h(
        "div",
        { class: "zoom" },
        button({ icon: Minus, cls: "ghost xs", tip: "Zoom out (Ctrl+-)", onClick: () => this.zoomBy(-1), size: 13 }),
        this.zoomLabel,
        button({ icon: Plus, cls: "ghost xs", tip: "Zoom in (Ctrl+=)", onClick: () => this.zoomBy(1), size: 13 }),
      ),
    );
  }

  private updateZoomLabel() {
    this.zoomLabel.textContent = `${Math.round(S.get("zoom") * 100)}%`;
  }

  // ================================================================ settings
  private applyTheme() {
    document.documentElement.dataset.theme = S.get("theme");
  }

  private onSetting(key: string) {
    if (key === "theme") {
      this.applyTheme();
      this.syncThemeButton();
    } else if (key === "zoom") {
      P.setZoom(S.get("zoom"));
      this.updateZoomLabel();
    } else if (key === "msb_left" || key === "show_readouts" || key === "show_interp") {
      for (const c of this.cards) c.rebuild();
    }
  }

  private toggleSounds() {
    const on = !S.get("sounds");
    S.set("sounds", on);
    if (on) play("bitOn");
    toast(on ? "Sounds on" : "Sounds off");
  }

  private toggleTheme() {
    S.set("theme", S.get("theme") === "dark" ? "light" : "dark");
  }

  private zoomBy(steps: number) {
    S.set("zoom", S.get("zoom") + steps * ZOOM_STEP);
  }

  private applyGlobalBase(b: Base) {
    for (const c of this.cards) c.model.setAllRowBases(b);
    S.set("default_base", b);
    toast(`All rows now use ${BASE_NAMES[b]}`);
  }

  // ================================================================ values
  addValue(width: number, model?: ValueModel, index?: number, reveal = true): ValueCard {
    if (!model) {
      const names = new Set(this.cards.map((c) => c.model.name));
      let n = this.cards.length + 1;
      while (names.has(`Value ${n}`)) n++;
      model = new ValueModel({
        width,
        name: `Value ${n}`,
        view: S.get("default_view"),
        defaultRowBase: S.get("default_base"),
      });
    }
    const card = new ValueCard(model, {
      remove: (c) => this.removeValue(c),
      move: (c, d) => this.moveValue(c, d),
      duplicate: (c) => this.duplicateValue(c),
      resize: (c) => this.resizeValue(c),
    });
    model.subscribe(() => this.setDirty(true));
    this.cards.splice(index ?? this.cards.length, 0, card);
    this.relayout();
    this.setDirty(true);
    if (reveal) {
      play("add");
      card.root.classList.add("enter");
      requestAnimationFrame(() => card.root.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    }
    return card;
  }

  private async removeValue(card: ValueCard) {
    const m = card.model;
    if (m.groups.length || m.compares.size) {
      const r = await ask("Remove value", `Remove “${m.name}” together with its fields and compare rows?`, [
        { id: "cancel", label: "Cancel" },
        { id: "yes", label: "Remove", cls: "danger-btn" },
      ]);
      if (r !== "yes") return;
    }
    this.drop(card);
    this.relayout();
    this.setDirty(true);
    play("remove");
  }

  private drop(card: ValueCard) {
    card.detach();
    this.cards.splice(this.cards.indexOf(card), 1);
    card.root.remove();
  }

  private moveValue(card: ValueCard, delta: number) {
    const i = this.cards.indexOf(card);
    const j = i + delta;
    if (j < 0 || j >= this.cards.length) return;
    [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    this.relayout();
    this.setDirty(true);
  }

  private async addCustom() {
    const last = Number(localStorage.getItem("bitviewer.lastWidth")) || 16;
    const width = await pickWidth("Add value", last, "Add value");
    if (width === null) return;
    localStorage.setItem("bitviewer.lastWidth", String(width));
    this.addValue(width);
  }

  private async resizeValue(card: ValueCard) {
    const m = card.model;
    const width = await pickWidth(`Change width of “${m.name}”`, m.width, "Change width");
    if (width === null || width === m.width) return;
    const lost = m.lostOnResize(width);
    if (lost.groups.length) {
      // named fields are only ever removed by the user, never by a resize
      const names = lost.groups.map((g) => `“${g.name}” ${g.label()}`).join(", ");
      const many = lost.groups.length > 1;
      await ask(
        "Fields don't fit",
        `${names} ${many ? "don't" : "doesn't"} fit in ${width} bits. ` +
          `Remove ${many ? "those fields" : "that field"} first, or use at least ${m.minWidthForGroups} bits.`,
        [{ id: "ok", label: "OK", cls: "primary" }],
        "ok",
      );
      return;
    }
    if (lost.compares || width < m.width) {
      const parts = [`bits above ${width - 1} are cleared`];
      if (lost.compares)
        parts.push(`${lost.compares} compare row${lost.compares > 1 ? "s" : ""} no longer fit and will be removed`);
      const r = await ask("Change width", `Shrinking to ${width} bits: ${parts.join(", and ")}.`, [
        { id: "cancel", label: "Cancel" },
        { id: "yes", label: "Change width", cls: "danger-btn" },
      ]);
      if (r !== "yes") return;
    }
    card.clearSelection();
    m.setWidth(width);
  }

  private duplicateValue(card: ValueCard) {
    const d = card.model.toJSON();
    d.name = `${card.model.name} copy`;
    this.addValue(card.model.width, ValueModel.fromJSON(d), this.cards.indexOf(card) + 1);
  }

  private relayout() {
    const focused = document.activeElement;
    this.workspace.replaceChildren(...(this.cards.length ? this.cards.map((c) => c.root) : [this.empty]));
    if (focused instanceof HTMLElement && this.workspace.contains(focused)) focused.focus({ preventScroll: true });
  }

  private groupSelection() {
    const c = this.cards.find((x) => x.sel);
    if (c) c.createGroupFromSelection();
    else toast("Select some bits first (drag across them)");
  }

  private clearSelections() {
    for (const c of this.cards) c.clearSelection();
  }

  // ================================================================ files
  private setDirty(dirty: boolean) {
    this.dirty = dirty;
    this.titleFile.textContent = `${this.fileName}${dirty ? " •" : ""}`;
    P.setTitle(`${this.fileName}${dirty ? " •" : ""} — Bit Viewer`);
  }

  /** Resolves true when it is fine to discard the current workspace. */
  private async maybeSave(): Promise<boolean> {
    if (!this.dirty || !this.cards.length) return true;
    const r = await ask("Unsaved changes", `Save changes to “${this.fileName}”?`, [
      { id: "cancel", label: "Cancel" },
      { id: "discard", label: "Don't save", cls: "outline" },
      { id: "save", label: "Save", cls: "primary" },
    ]);
    if (r === "save") return this.save();
    return r === "discard";
  }

  private clear() {
    for (const c of [...this.cards]) this.drop(c);
    this.relayout();
  }

  private async newWorkspace() {
    if (!(await this.maybeSave())) return;
    this.clear();
    this.path = null;
    this.fileName = "Untitled";
    this.addValue(32);
    this.setDirty(false);
  }

  private async openFile() {
    if (!(await this.maybeSave())) return;
    try {
      const f = await P.pickAndRead(localStorage.getItem("bitviewer.lastDir") ?? (await P.defaultDir()));
      if (f) this.loadText(f.text, f.path, f.name);
    } catch (e) {
      this.fail("Could not open file", e);
    }
  }

  private async loadPath(path: string): Promise<boolean> {
    try {
      return this.loadText(await P.readText(path), path, P.basename(path));
    } catch (e) {
      this.fail("Could not open file", e, path);
      return false;
    }
  }

  private loadText(text: string, path: string | null, name: string): boolean {
    let models: ValueModel[];
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || data.app !== "bitviewer") {
        throw new ModelError("This is not a Bit Viewer workspace file");
      }
      models = (data.values ?? []).map((d: unknown) => ValueModel.fromJSON(d));
    } catch (e) {
      this.fail("Could not open file", e, name);
      return false;
    }
    this.clear();
    for (const m of models) this.addValue(m.width, m, undefined, false);
    this.path = path;
    this.fileName = name;
    this.rememberDir(path);
    this.setDirty(false);
    this.workspace.scrollTop = 0;
    toast(`Opened ${name}`, "ok");
    return true;
  }

  private async save(): Promise<boolean> {
    if (!this.path) return this.saveAs();
    return this.write(this.path);
  }

  private async saveAs(): Promise<boolean> {
    const dir = localStorage.getItem("bitviewer.lastDir") ?? (await P.defaultDir());
    const start = this.path ?? (dir ? P.joinPath(dir, "workspace.bitview.json") : "workspace.bitview.json");
    let path = await P.pickSavePath(start);
    if (!path) return false;
    if (!path.toLowerCase().endsWith(".json")) path += ".bitview.json";
    return this.write(path);
  }

  private async write(path: string): Promise<boolean> {
    const data = { app: "bitviewer", version: FILE_VERSION, values: this.cards.map((c) => c.model.toJSON()) };
    try {
      await P.writeText(path, JSON.stringify(data, null, 2));
    } catch (e) {
      this.fail("Could not save", e, path);
      return false;
    }
    this.path = P.isTauri ? path : null;
    this.fileName = P.basename(path);
    this.rememberDir(path);
    this.setDirty(false);
    toast(`Saved ${this.fileName}`, "ok");
    return true;
  }

  private rememberDir(path: string | null) {
    if (!path) return;
    const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
    if (i > 0) localStorage.setItem("bitviewer.lastDir", path.slice(0, i));
  }

  private fail(title: string, e: unknown, where = "") {
    const msg = e instanceof Error ? e.message : String(e);
    ask(title, where ? `${where}\n\n${msg}` : msg, [{ id: "ok", label: "OK", cls: "primary" }], "ok");
  }

  // ================================================================ input
  private installInput() {
    window.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        this.wheelAcc += -e.deltaY;
        while (this.wheelAcc >= 100) {
          this.wheelAcc -= 100;
          this.zoomBy(1);
        }
        while (this.wheelAcc <= -100) {
          this.wheelAcc += 100;
          this.zoomBy(-1);
        }
      },
      { passive: false },
    );

    document.addEventListener("keydown", (e) => {
      if (modalOpen() || menusOpen()) return;
      // Esc inside a field reverts that field instead of clearing the selection
      if (e.key === "Escape" && document.activeElement instanceof HTMLInputElement) return;
      this.commands.handleKey(e);
    });

    // Clicking anywhere that isn't part of selecting drops the selection.
    document.addEventListener("pointerdown", (e) => {
      if (!this.cards.some((c) => c.sel)) return;
      const t = e.target as Element;
      if (t.closest(".bit, .row-label, .menu, .backdrop, [data-keep-sel]")) return;
      // clicks on a scrollbar land on the scrolling element itself
      if (t instanceof HTMLElement && (e.offsetX >= t.clientWidth || e.offsetY >= t.clientHeight)) return;
      this.clearSelections();
    });

    document.addEventListener("contextmenu", (e) => {
      // keep the native menu for text fields, suppress the browser one elsewhere
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
    });
  }
}
