// Main window: title bar, menus, toolbar, workspace, status bar, save/load,
// undo history and session auto-save. Actions live in the command registry
// (commands.ts); this file wires them up.
import {
  Camera,
  ChevronsUpDown,
  CircleQuestionMark,
  CloudDownload,
  Command,
  FileCode2,
  FilePlus,
  FolderClock,
  FolderOpen,
  Info,
  LayoutTemplate,
  LogOut,
  Maximize,
  Minimize,
  Minus,
  Moon,
  Plus,
  Redo2,
  RotateCcw,
  Ruler,
  Save,
  SaveAll,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareFunction,
  Sun,
  Undo2,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide";
import { ValueCard } from "../card/card";
import { MAX_WIDTH, MIN_WIDTH, ModelError, ValueModel } from "../core/model";
import { BASE_NAMES, BASE_ORDER, type Base } from "../core/numfmt";
import { showAbout, showHelp } from "../dialogs/help";
import { newValueFromExpression } from "../dialogs/newvalue";
import { openSettings } from "../dialogs/settings";
import { pickTemplate } from "../dialogs/templates";
import { pickWidth } from "../dialogs/width";
import { applyAccent } from "../ui/accent";
import { ask, button, h, icon, type MenuItem, menusOpen, modalOpen, openMenu, segmented, toast } from "../ui/kit";
import { logoSvg } from "../ui/logo";
import { play } from "../ui/sound";
import { CommandRegistry } from "./commands";
import { History } from "./history";
import { openPalette, paletteOpen } from "./palette";
import * as P from "./platform";
import { SearchBar } from "./search";
import { loadSession, type Session, saveSessionNow, saveSessionSoon } from "./session";
import { S, ZOOM_STEP } from "./settings";
import { startTour, tourRunning } from "./tour";
import { checkForUpdates } from "./updates";

const FILE_VERSION = 1;
const UNTITLED = "Untitled";

export class App {
  readonly commands = new CommandRegistry();
  cards: ValueCard[] = [];
  private path: string | null = null;
  private fileName = UNTITLED;
  /** Snapshot of the workspace as last saved/opened; null = never saved. */
  private savedSnapshot: string | null = null;
  private history = new History(
    () => this.snapshot(),
    (s) => this.restore(s),
    () => this.onHistoryChange(),
  );
  private workspace!: HTMLElement;
  private empty!: HTMLElement;
  private titleFile!: HTMLElement;
  private zoomLabel!: HTMLElement;
  private themeBtn!: HTMLButtonElement;
  private maxBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private wheelAcc = 0;
  private search = new SearchBar(() => this.cards);
  /** The value last clicked or focused; palette "Value:" commands act on it. */
  private activeCard: ValueCard | null = null;

  constructor(private root: HTMLElement) {}

  async start() {
    this.registerCommands();
    this.applyTheme();
    await P.setZoom(S.get("zoom"));
    this.root.replaceChildren(
      this.buildTitlebar(),
      h("div", { class: "topbars" }, this.buildToolbar(), this.search.el),
      this.buildWorkspace(),
      this.buildStatusbar(),
    );
    this.installInput();
    this.installFileDrop();
    S.onChange((k) => this.onSetting(k));
    await P.guardClose(
      () => this.beforeClose(),
      () => void saveSessionNow(this.sessionData()),
    );
    await P.onResized(() => this.syncMaxButton());
    this.syncMaxButton();

    const initial = await P.initialFile();
    if (!(initial && (await this.loadPath(initial))) && !(await this.restoreSession())) this.startFresh();
    if (!S.get("tour_done")) setTimeout(() => this.runTour(), 700);
    else if (S.get("check_updates")) setTimeout(() => void checkForUpdates(false), 3000);
    void P.onOpenFile(async (path) => {
      if (await this.maybeSave()) await this.loadPath(path);
    });
  }

  private async runTour() {
    if (modalOpen()) return;
    await startTour();
    S.set("tour_done", true);
  }

  get dirty(): boolean {
    return this.history.snapshot !== this.savedSnapshot;
  }

  // ================================================================ commands
  private registerCommands() {
    const dark = () => S.get("theme") === "dark";
    this.registerValueCommands();
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
        id: "edit.undo",
        group: "Edit",
        label: "Undo",
        icon: Undo2,
        keys: ["Ctrl+Z"],
        enabled: () => this.history.canUndo,
        run: () => this.undo(),
      },
      {
        id: "edit.redo",
        group: "Edit",
        label: "Redo",
        icon: Redo2,
        keys: ["Ctrl+Y", "Ctrl+Shift+Z"],
        enabled: () => this.history.canRedo,
        run: () => this.redo(),
      },
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
      {
        id: "edit.find",
        group: "Edit",
        label: "Find…",
        icon: Search,
        keys: ["Ctrl+F"],
        keywords: "search filter",
        run: () => this.search.open(),
      },
      {
        id: "app.palette",
        group: "Help",
        label: "Command palette…",
        icon: Command,
        keys: ["Ctrl+K", "Ctrl+Shift+P"],
        keywords: "actions run",
        run: () => openPalette(this.commands),
        hidden: true,
      },
      {
        id: "value.fromTemplate",
        group: "Edit",
        label: "Add value from template…",
        icon: LayoutTemplate,
        keywords: "float ieee rgb ipv4 layout fields preset",
        run: () => this.addFromTemplate(),
      },
      {
        id: "value.fromExpr",
        group: "Edit",
        label: "New value from expression…",
        icon: SquareFunction,
        keywords: "calculate combine and or xor add",
        run: () => this.addFromExpression(),
      },
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
        id: "view.compact",
        group: "View",
        label: () => (S.get("compact") ? "Normal spacing" : "Compact mode"),
        icon: () => (S.get("compact") ? Maximize : Minimize),
        keywords: "dense tight spacing",
        run: () => S.set("compact", !S.get("compact")),
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
        run: () => showHelp(this.commands, () => this.runTour()),
      },
      { id: "help.about", group: "Help", label: "About Bit Viewer", icon: Info, run: () => showAbout() },
      {
        id: "help.updates",
        group: "Help",
        label: "Check for updates…",
        icon: CloudDownload,
        keywords: "upgrade version new",
        run: () => checkForUpdates(true),
      },
      {
        id: "help.tour",
        group: "Help",
        label: "Take the tour",
        icon: Sparkles,
        keywords: "introduction guide first",
        run: () => this.runTour(),
      },
      // swallow browser shortcuts that make no sense in an app window
      {
        id: "noop.browser",
        group: "Help",
        label: "",
        keys: ["Ctrl+R", "Ctrl+P", "F5"],
        hidden: true,
        run: () => {},
      },
    );
  }

  /** Palette commands that act on the current value ("Value: …"). */
  private registerValueCommands() {
    const card = () => this.activeCard ?? this.cards[0] ?? null;
    const named = (verb: string) => () => {
      const c = card();
      return c ? `${verb} — ${c.model.name || "value"}` : verb;
    };
    const has = () => card() !== null;
    const on = (f: (c: ValueCard) => unknown) => () => {
      const c = card();
      if (c) void f(c);
    };
    this.commands.add(
      {
        id: "card.collapse",
        group: "Value",
        label: named("Collapse / expand"),
        icon: ChevronsUpDown,
        enabled: has,
        run: on((c) => c.toggleCollapsed()),
      },
      {
        id: "card.snapshot",
        group: "Value",
        label: named("Take snapshot…"),
        icon: Camera,
        enabled: has,
        run: on((c) => c.takeSnapshot()),
      },
      {
        id: "card.export",
        group: "Value",
        label: named("Export code…"),
        icon: FileCode2,
        keywords: "c rust python header",
        enabled: has,
        run: on((c) => c.exportCode()),
      },
      {
        id: "card.template",
        group: "Value",
        label: named("Apply template…"),
        icon: LayoutTemplate,
        enabled: has,
        run: on((c) => c.applyTemplate()),
      },
      {
        id: "card.saveTemplate",
        group: "Value",
        label: named("Save fields as template…"),
        enabled: has,
        run: on((c) => c.saveAsTemplate()),
      },
      {
        id: "card.expr",
        group: "Value",
        label: named("Expression bar"),
        icon: SquareFunction,
        keywords: "calculate formula",
        enabled: has,
        run: on((c) => c.toggleExpr()),
      },
      {
        id: "card.bases",
        group: "Value",
        label: named("Show / hide all bases"),
        keywords: "hex dec oct bin",
        enabled: has,
        run: on((c) => c.toggleBases()),
      },
      {
        id: "card.paste",
        group: "Value",
        label: named("Paste bytes…"),
        keywords: "endian",
        enabled: has,
        run: on((c) => c.pasteBytes()),
      },
      {
        id: "card.swap",
        group: "Value",
        label: named("Swap bytes"),
        keywords: "endian bswap",
        enabled: has,
        run: on((c) => c.applyOp("bswap")),
      },
      {
        id: "card.not",
        group: "Value",
        label: named("Invert bits (NOT)"),
        enabled: has,
        run: on((c) => c.applyOp("invert")),
      },
      {
        id: "card.clear",
        group: "Value",
        label: named("Clear to 0"),
        enabled: has,
        run: on((c) => c.applyOp("clear")),
      },
      {
        id: "card.duplicate",
        group: "Value",
        label: named("Duplicate"),
        enabled: has,
        run: on((c) => this.duplicateValue(c)),
      },
      {
        id: "card.width",
        group: "Value",
        label: named("Change width…"),
        icon: Ruler,
        enabled: has,
        run: on((c) => this.resizeValue(c)),
      },
      { id: "card.remove", group: "Value", label: named("Remove"), enabled: has, run: on((c) => this.removeValue(c)) },
    );
  }

  private menus(): [string, (string | MenuItem)[]][] {
    return [
      ["File", ["file.new", "file.open", this.recentMenu(), "sep", "file.save", "file.saveAs", "sep", "file.quit"]],
      [
        "Edit",
        [
          "edit.undo",
          "edit.redo",
          "sep",
          "value.add32",
          "value.add64",
          "value.addCustom",
          "value.fromExpr",
          "value.fromTemplate",
          "sep",
          "sel.group",
          "sel.clear",
          "sep",
          "edit.find",
        ],
      ],
      [
        "View",
        [
          "view.zoomIn",
          "view.zoomOut",
          "view.zoomReset",
          "sep",
          "view.theme",
          "view.compact",
          "view.sounds",
          "sep",
          "app.settings",
        ],
      ],
      ["Help", ["app.palette", "help.controls", "help.tour", "sep", "help.updates", "help.about"]],
    ];
  }

  // ================================================================ chrome
  private buildTitlebar(): HTMLElement {
    const menuBar = h("nav", { class: "menubar" });
    for (const [name] of this.menus()) {
      // built on each open so dynamic entries (recent files, labels) are current
      const items = () => this.commands.menu(this.menus().find(([n]) => n === name)?.[1] ?? []);
      const b = h("button", { type: "button", class: "menubar-item", "data-keep-sel": "" }, name);
      b.addEventListener("click", () => openMenu(items(), b));
      b.addEventListener("pointerenter", () => {
        // slide between open menus like a native menu bar
        if (menusOpen() && document.querySelector(".menubar-item.menu-open") && !b.classList.contains("menu-open")) {
          openMenu(items(), b);
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
    this.undoBtn = button({ icon: Undo2, cls: "ghost", tip: "Undo (Ctrl+Z)", onClick: run("edit.undo") });
    this.redoBtn = button({ icon: Redo2, cls: "ghost", tip: "Redo (Ctrl+Y)", onClick: run("edit.redo") });
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
      this.undoBtn,
      this.redoBtn,
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
    document.body.classList.toggle("compact", S.get("compact"));
    applyAccent(S.get("accent"), S.get("theme") === "contrast");
  }

  private onSetting(key: string) {
    if (key === "theme" || key === "compact" || key === "accent") {
      this.applyTheme();
      this.syncThemeButton();
    } else if (key === "zoom") {
      P.setZoom(S.get("zoom"));
      this.updateZoomLabel();
    } else if (["msb_left", "show_readouts", "show_interp", "readout_chips"].includes(key)) {
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
    // Ctrl+T switches dark ↔ light; high contrast is chosen in Settings
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

  // ================================================================ undo history
  private snapshot(): string {
    return JSON.stringify(this.cards.map((c) => c.model.toJSON()));
  }

  /** Rebuilds the workspace from a snapshot (undo / redo / session restore). */
  private restore(snap: string) {
    const scroll = this.workspace.scrollTop;
    const models = (JSON.parse(snap) as unknown[]).map((d) => ValueModel.fromJSON(d));
    this.clearCards();
    for (const m of models) this.addValue(m.width, m, undefined, false);
    this.workspace.scrollTop = scroll;
  }

  private undo() {
    if (this.history.undo()) play("op");
  }

  private redo() {
    if (this.history.redo()) play("op");
  }

  private onHistoryChange() {
    this.undoBtn.disabled = !this.history.canUndo;
    this.redoBtn.disabled = !this.history.canRedo;
    this.updateTitle();
    saveSessionSoon(() => this.sessionData());
  }

  /** Marks the current state as the saved one. */
  private markSaved() {
    this.history.flush();
    this.savedSnapshot = this.history.snapshot;
    this.updateTitle();
  }

  // ================================================================ session
  private sessionData(): Session {
    return {
      version: 1,
      path: this.path,
      fileName: this.fileName,
      dirty: this.dirty,
      values: this.cards.map((c) => c.model.toJSON()),
      savedAt: Date.now(),
    };
  }

  /** Reopens what was open last time. Returns false when there was nothing to restore. */
  private async restoreSession(): Promise<boolean> {
    const s = await loadSession();
    if (!s) return false;
    if (!s.dirty && s.path && (await this.loadPath(s.path, true))) return true;
    if (!s.values) return false;
    try {
      this.loadValues(s.values, s.path, s.fileName);
    } catch {
      return false;
    }
    if (s.dirty) {
      this.savedSnapshot = null; // contents differ from any file on disk
      this.updateTitle();
      toast("Restored unsaved changes from your last session", "ok");
    }
    return true;
  }

  /** Window close: ask about unsaved changes, then leave the session tidy. */
  private async beforeClose(): Promise<boolean> {
    const dirtyBefore = this.dirty;
    if (!(await this.maybeSave())) return false;
    // "Don't save" means the changes are discarded, so don't bring them back next time
    const discarded = dirtyBefore && this.dirty;
    await saveSessionNow({ ...this.sessionData(), dirty: false, values: discarded ? null : this.sessionData().values });
    await S.flush();
    return true;
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
      lookup: (_c, name) => this.valueByName(name),
      others: (c) => this.cards.filter((x) => x !== c),
      dragStart: (c, e) => this.dragCard(c, e),
      batch: (on) => (on ? this.history.hold() : this.history.release()),
    });
    model.subscribe(() => this.history.touch());
    this.cards.splice(index ?? this.cards.length, 0, card);
    this.relayout();
    this.history.touch();
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
    this.history.touch();
    play("remove");
  }

  private drop(card: ValueCard) {
    card.detach();
    this.cards.splice(this.cards.indexOf(card), 1);
    card.root.remove();
  }

  /** Drag a card by its handle; a line shows where it will land. */
  private dragCard(card: ValueCard, e: PointerEvent) {
    e.preventDefault();
    if (this.cards.length < 2) return;
    const from = this.cards.indexOf(card);
    let target = from;
    let lastY = e.clientY;
    const line = h("div", { class: "drop-line" });
    card.root.classList.add("dragging");
    document.body.classList.add("reordering");

    const place = () => {
      let idx = 0;
      for (const c of this.cards) {
        const r = c.root.getBoundingClientRect();
        if (lastY > r.top + r.height / 2) idx++;
      }
      target = idx;
      this.workspace.insertBefore(line, this.cards[idx]?.root ?? null);
    };
    // keep scrolling while the pointer rests near the top or bottom edge
    const scroller = window.setInterval(() => {
      const r = this.workspace.getBoundingClientRect();
      const edge = 48;
      const dy = lastY < r.top + edge ? -14 : lastY > r.bottom - edge ? 14 : 0;
      if (dy) {
        this.workspace.scrollTop += dy;
        place();
      }
    }, 16);
    const move = (ev: PointerEvent) => {
      lastY = ev.clientY;
      place();
    };
    const end = (commit: boolean) => {
      window.clearInterval(scroller);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", esc, true);
      line.remove();
      card.root.classList.remove("dragging");
      document.body.classList.remove("reordering");
      const to = target > from ? target - 1 : target;
      if (commit && to !== from) {
        this.cards.splice(from, 1);
        this.cards.splice(to, 0, card);
        this.relayout();
        this.history.touch();
        play("toggle");
      }
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const esc = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        end(false);
      }
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", esc, true);
    place();
  }

  private moveValue(card: ValueCard, delta: number) {
    const i = this.cards.indexOf(card);
    const j = i + delta;
    if (j < 0 || j >= this.cards.length) return;
    [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    this.relayout();
    this.history.touch();
  }

  private async addCustom() {
    const width = await pickWidth("Add value", S.get("last_width"), "Add value");
    if (width === null) return;
    S.set("last_width", width);
    this.addValue(width);
  }

  private async addFromTemplate() {
    const t = await pickTemplate("Add value from template", "Add value");
    if (!t) return;
    const card = this.addValue(t.width);
    card.model.setName(t.name);
    card.model.applyTemplate(t);
    card.rebuild();
  }

  /** A value by name for expressions. Case, spaces and underscores don't matter. */
  private valueByName(name: string): bigint | undefined {
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[\s_]+/g, " ")
        .trim();
    const n = norm(name);
    return this.cards.find((c) => norm(c.model.name) === n)?.model.value;
  }

  private async addFromExpression() {
    const widest = Math.max(32, ...this.cards.map((c) => c.model.width));
    const r = await newValueFromExpression(
      (name) => {
        const n = name.trim().toLowerCase();
        // "x" has no meaning here (there's no current value yet)
        return n === "x" ? undefined : this.valueByName(name);
      },
      Math.min(widest, 512),
    );
    if (!r) return;
    const card = this.addValue(r.width);
    card.model.setValue(r.value);
    if (r.name) card.model.setName(r.name);
    card.rebuild();
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
    if (this.activeCard && !this.cards.includes(this.activeCard)) this.activeCard = null;
    const focused = document.activeElement;
    this.workspace.replaceChildren(...(this.cards.length ? this.cards.map((c) => c.root) : [this.empty]));
    if (focused instanceof HTMLElement && this.workspace.contains(focused)) focused.focus({ preventScroll: true });
    if (this.search.isOpen) this.search.apply();
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
  private updateTitle() {
    const mark = this.dirty ? " •" : "";
    this.titleFile.textContent = `${this.fileName}${mark}`;
    P.setTitle(`${this.fileName}${mark} — Bit Viewer`);
  }

  /** Resolves true when it is fine to discard the current workspace. */
  private async maybeSave(): Promise<boolean> {
    this.history.flush();
    if (!this.dirty || !this.cards.length) return true;
    const r = await ask("Unsaved changes", `Save changes to “${this.fileName}”?`, [
      { id: "cancel", label: "Cancel" },
      { id: "discard", label: "Don't save", cls: "outline" },
      { id: "save", label: "Save", cls: "primary" },
    ]);
    if (r === "save") return this.save();
    return r === "discard";
  }

  private clearCards() {
    for (const c of [...this.cards]) this.drop(c);
    this.relayout();
  }

  /** A new untitled workspace with one 32-bit value. */
  private startFresh() {
    this.clearCards();
    this.path = null;
    this.fileName = UNTITLED;
    this.addValue(32, undefined, undefined, false);
    this.history.reset();
    this.markSaved();
  }

  private async newWorkspace() {
    if (!(await this.maybeSave())) return;
    this.startFresh();
    void saveSessionNow(this.sessionData());
  }

  private recentMenu(): MenuItem {
    const files = P.isTauri ? S.get("recent_files") : [];
    const folder = (p: string) => {
      const d = p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
      return d.length > 38 ? `…${d.slice(-37)}` : d;
    };
    return {
      label: "Open recent",
      icon: FolderClock,
      disabled: !files.length,
      submenu: [
        ...files.map(
          (p): MenuItem => ({ label: P.basename(p), shortcut: folder(p), action: () => this.openRecent(p) }),
        ),
        "sep",
        { label: "Clear list", action: () => S.set("recent_files", []) },
      ],
    };
  }

  private async openRecent(path: string) {
    if (!(await this.maybeSave())) return;
    if (!(await this.loadPath(path))) S.removeRecent(path);
  }

  private installFileDrop() {
    const overlay = h(
      "div",
      { class: "drop-overlay" },
      h("div", { class: "drop-card" }, icon(FolderOpen, 28), h("b", {}, "Drop to open the workspace")),
    );
    document.body.append(overlay);
    void P.onFileDrop(
      (over) => overlay.classList.toggle("show", over),
      async (f) => {
        if (!(await this.maybeSave())) return;
        this.loadText(f.text, f.path, f.name);
      },
    );
  }

  private async openFile() {
    if (!(await this.maybeSave())) return;
    try {
      const f = await P.pickAndRead(S.get("last_dir") || (await P.defaultDir()));
      if (f) this.loadText(f.text, f.path, f.name);
    } catch (e) {
      this.fail("Could not open file", e);
    }
  }

  private async loadPath(path: string, quiet = false): Promise<boolean> {
    try {
      return this.loadText(await P.readText(path), path, P.basename(path), quiet);
    } catch (e) {
      if (!quiet) this.fail("Could not open file", e, path);
      return false;
    }
  }

  private loadText(text: string, path: string | null, name: string, quiet = false): boolean {
    let values: unknown[];
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || data.app !== "bitviewer") {
        throw new ModelError("This is not a Bit Viewer workspace file");
      }
      values = data.values ?? [];
      // validate everything before replacing the workspace
      for (const d of values) ValueModel.fromJSON(d);
    } catch (e) {
      if (!quiet) this.fail("Could not open file", e, name);
      return false;
    }
    this.loadValues(values, path, name);
    if (path) {
      this.rememberDir(path);
      S.addRecent(path);
    }
    void saveSessionNow(this.sessionData());
    if (!quiet) toast(`Opened ${name}`, "ok");
    return true;
  }

  /** Replaces the workspace and starts a fresh undo history. */
  private loadValues(values: unknown[], path: string | null, name: string) {
    const models = values.map((d) => ValueModel.fromJSON(d));
    this.clearCards();
    for (const m of models) this.addValue(m.width, m, undefined, false);
    this.path = path;
    this.fileName = name;
    this.history.reset();
    this.markSaved();
    this.workspace.scrollTop = 0;
  }

  private async save(): Promise<boolean> {
    if (!this.path) return this.saveAs();
    return this.write(this.path);
  }

  private async saveAs(): Promise<boolean> {
    const dir = S.get("last_dir") || (await P.defaultDir());
    const start = this.path ?? (dir ? P.joinPath(dir, "workspace.bitview") : "workspace.bitview");
    let path = await P.pickSavePath(start);
    if (!path) return false;
    if (!/\.(bitview|json)$/i.test(path)) path += ".bitview";
    return this.write(path);
  }

  private async write(path: string): Promise<boolean> {
    this.history.flush();
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
    if (P.isTauri) S.addRecent(path);
    this.markSaved();
    void saveSessionNow(this.sessionData());
    toast(`Saved ${this.fileName}`, "ok");
    return true;
  }

  private rememberDir(path: string) {
    const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
    if (i > 0) S.set("last_dir", path.slice(0, i));
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

    const track = (e: Event) => {
      const c = this.cards.find((x) => x.root.contains(e.target as Node));
      if (c) this.activeCard = c;
    };
    document.addEventListener("pointerdown", track, true);
    // Record any pending undo step before the next edit starts, so that a bit
    // click followed instantly by typing (or the reverse) stays two steps.
    // Capture-phase listeners run before the field's or strip's own handlers.
    document.addEventListener("input", () => this.history.flush(), true);
    document.addEventListener("pointerdown", () => this.history.flush(), true);
    document.addEventListener("focusin", track);

    document.addEventListener("keydown", (e) => {
      if (modalOpen() || menusOpen() || paletteOpen() || tourRunning()) return;
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
