// Main window: title bar, menus, toolbar, workspace, status bar, save/load,
// undo history and session auto-save. Actions live in the command registry
// (commands.ts); this file wires them up.
import {
  BookOpen,
  Camera,
  ChevronsUpDown,
  CircleQuestionMark,
  CloudDownload,
  Command,
  Cpu,
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
  ScrollText,
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
import { BASE_NAMES, BASE_ORDER, type Base } from "../core/format/integers";
import {
  MAX_WIDTH,
  MIN_WIDTH,
  ModelError,
  ValueModel,
  valueFromJSON,
  valueToJSON,
} from "../core/model";
import {
  parseSvd,
  registerTemplate,
  type SvdDevice,
  type SvdRegister,
} from "../core/svd";
import {
  freeName,
  groupOrder,
  moveBlock,
  moveItem,
  nextOffset,
  type Peripheral,
  peripheralsFromJSON,
  peripheralToJSON,
} from "../core/workspace";
import { exportCode } from "../dialogs/export";
import { showGuide } from "../dialogs/guide";
import { showAbout, showHelp, VERSION } from "../dialogs/help";
import { newValueFromExpression } from "../dialogs/newvalue";
import { openSettings } from "../dialogs/settings";
import { pickSvdRegisters } from "../dialogs/svd";
import { pickTemplate } from "../dialogs/templates";
import { showWhatsNew } from "../dialogs/whatsnew";
import { pickWidth } from "../dialogs/width";
import * as P from "../platform/native";
import {
  loadSession,
  type Session,
  saveSessionNow,
  saveSessionSoon,
} from "../platform/session";
import { appSettings, ZOOM_STEP } from "../platform/settings";
import { applyAccent } from "../ui/accent";
import {
  ask,
  button,
  html,
  icon,
  type MenuItem,
  menusOpen,
  modalOpen,
  openMenu,
  segmented,
  toast,
} from "../ui/kit";
import { logoSvg } from "../ui/logo";
import { play } from "../ui/sound";
import { CommandRegistry } from "./commands";
import { History } from "./history";
import { openPalette, paletteOpen } from "./palette";
import {
  askOffset,
  editPeripheralDialog,
  type PeripheralActions,
  peripheralHeader,
} from "./peripherals";
import { SearchBar } from "./search";
import { startTour, tourRunning } from "./tour";
import { checkForUpdates } from "./updates";

const FILE_VERSION = 1;
const UNTITLED = "Untitled";

/** A dropped file that is a CMSIS-SVD description rather than a workspace. */
const looksLikeSvd = (file: { name: string; text: string }) =>
  /\.(svd|xml)$/i.test(file.name) || file.text.trimStart().startsWith("<");

/** Inputs, text areas and editable regions: they keep the native right-click menu and their own Esc. */
const isTextField = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable);

export class App {
  readonly commands = new CommandRegistry();
  cards: ValueCard[] = [];
  /** Peripheral blocks by name; values join one through `model.block`. */
  private peripherals = new Map<string, Peripheral>();
  private readonly blockOf = (card: ValueCard) => card.model.block;
  private path: string | null = null;
  private fileName = UNTITLED;
  /** Snapshot of the workspace as last saved/opened; null = never saved. */
  private savedSnapshot: string | null = null;
  private history = new History(
    () => this.snapshot(),
    (text) => this.restore(text),
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
    await P.setZoom(appSettings.get("zoom"));
    this.root.replaceChildren(
      this.buildTitlebar(),
      html(
        "div",
        { class: "topbars" },
        this.buildToolbar(),
        this.search.element,
      ),
      this.buildWorkspace(),
      this.buildStatusbar(),
    );
    this.installInput();
    this.installFileDrop();
    appSettings.onChange((key) => this.onSetting(key));
    await P.guardClose(
      () => this.prepareToQuit(),
      () => void saveSessionNow(this.sessionData()),
    );
    await P.onResized(() => this.syncMaxButton());
    this.syncMaxButton();

    await P.onOpenFile(async (path) => {
      if (await this.maybeSave()) await this.loadPath(path);
    });
    const initial = await P.initialFile();
    if (
      !(initial && (await this.loadPath(initial))) &&
      !(await this.restoreSession())
    )
      this.startFresh();
    if (!appSettings.get("tour_done")) {
      appSettings.set("last_seen_version", VERSION); // nothing is "new" to a first-time user
      setTimeout(() => this.runTour(), 700);
    } else setTimeout(() => void this.runStartupChecks(), 700);
  }

  /** After an update, shows the new version's changes once; then looks for a newer version. */
  private async runStartupChecks() {
    if (appSettings.get("last_seen_version") !== VERSION) {
      appSettings.set("last_seen_version", VERSION);
      if (!modalOpen()) await showWhatsNew();
    }
    if (appSettings.get("check_updates"))
      setTimeout(
        () => void checkForUpdates(false, () => this.prepareToQuit()),
        2300,
      );
  }

  private async runTour() {
    if (modalOpen()) return;
    await startTour();
    appSettings.set("tour_done", true);
  }

  get dirty(): boolean {
    return this.history.snapshot !== this.savedSnapshot;
  }

  // ================================================================ commands
  private registerCommands() {
    this.registerFileCommands();
    this.registerEditCommands();
    this.registerViewCommands();
    this.registerHelpCommands();
    this.registerValueCommands();
  }

  /** New, open, save, quit. */
  private registerFileCommands() {
    this.commands.add(
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
      {
        id: "file.save",
        group: "File",
        label: "Save",
        icon: Save,
        keys: ["Ctrl+S"],
        run: () => this.save(),
      },
      {
        id: "file.saveAs",
        group: "File",
        label: "Save as…",
        icon: SaveAll,
        keys: ["Ctrl+Shift+S"],
        run: () => this.saveAs(),
      },
      {
        id: "file.importSvd",
        group: "File",
        label: "Import CMSIS-SVD…",
        icon: Cpu,
        keywords:
          "svd cmsis register description peripheral arm stm32 nrf import",
        run: () => this.importSvd(),
      },
      {
        id: "file.quit",
        group: "File",
        label: "Quit",
        icon: LogOut,
        run: () => P.closeWindow(),
      },
    );
  }

  /** Undo, adding values, selection and find. */
  private registerEditCommands() {
    this.commands.add(
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
      {
        id: "sel.clear",
        group: "Edit",
        label: "Clear selection",
        keys: ["Esc"],
        run: () => this.clearSelections(),
      },
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
    );
  }

  /** Zoom, theme, spacing, sounds and settings. */
  private registerViewCommands() {
    const dark = () => appSettings.get("theme") === "dark";
    this.commands.add(
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
        run: () => appSettings.set("zoom", 1),
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
        label: () =>
          appSettings.get("compact") ? "Normal spacing" : "Compact mode",
        icon: () => (appSettings.get("compact") ? Maximize : Minimize),
        keywords: "dense tight spacing",
        run: () => appSettings.set("compact", !appSettings.get("compact")),
      },
      {
        id: "view.sounds",
        group: "View",
        label: () =>
          appSettings.get("sounds") ? "Turn sounds off" : "Turn sounds on",
        icon: () => (appSettings.get("sounds") ? VolumeX : Volume2),
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
    );
  }

  /** Help, the palette itself, and shortcuts to swallow. */
  private registerHelpCommands() {
    this.commands.add(
      {
        id: "help.controls",
        group: "Help",
        label: "Controls & shortcuts",
        icon: CircleQuestionMark,
        keys: ["F1"],
        run: () =>
          showHelp(
            this.commands,
            () => this.runTour(),
            (page) => showGuide(page),
          ),
      },
      {
        id: "help.guide",
        group: "Help",
        label: "Guide",
        icon: BookOpen,
        keywords: "docs documentation manual how to tutorial",
        run: () => showGuide(),
      },
      {
        id: "help.about",
        group: "Help",
        label: "About Bit Viewer",
        icon: Info,
        run: () => showAbout(),
      },
      {
        id: "help.whatsnew",
        group: "Help",
        label: "What's new",
        icon: ScrollText,
        keywords: "changelog changes release notes version",
        run: async () => {
          if (!(await showWhatsNew()))
            toast("No release notes for this version");
        },
      },
      {
        id: "help.updates",
        group: "Help",
        label: "Check for updates…",
        icon: CloudDownload,
        keywords: "upgrade version new",
        run: () => checkForUpdates(true, () => this.prepareToQuit()),
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
    this.commands.add(
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
        run: runOnActiveCard((card) => this.duplicateValue(card)),
      },
      {
        id: "card.width",
        group: "Value",
        label: named("Change width…"),
        icon: Ruler,
        enabled: has,
        run: runOnActiveCard((card) => this.resizeValue(card)),
      },
      {
        id: "card.remove",
        group: "Value",
        label: named("Remove"),
        enabled: has,
        run: runOnActiveCard((card) => this.removeValue(card)),
      },
    );
  }

  private menus(): [string, (string | MenuItem)[]][] {
    return [
      [
        "File",
        [
          "file.new",
          "file.open",
          this.recentMenu(),
          "file.importSvd",
          "sep",
          "file.save",
          "file.saveAs",
          "sep",
          "file.quit",
        ],
      ],
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
      [
        "Help",
        [
          "app.palette",
          "help.controls",
          "help.guide",
          "help.whatsnew",
          "help.tour",
          "sep",
          "help.updates",
          "help.about",
        ],
      ],
    ];
  }

  // ================================================================ chrome
  private buildTitlebar(): HTMLElement {
    const menuBar = html("nav", { class: "menubar" });
    for (const [name] of this.menus()) {
      // built on each open so dynamic entries (recent files, labels) are current
      const items = () =>
        this.commands.menu(
          this.menus().find(([menuName]) => menuName === name)?.[1] ?? [],
        );
      const buttonElement = html(
        "button",
        { type: "button", class: "menubar-item", "data-keep-sel": "" },
        name,
      );
      buttonElement.addEventListener("click", () =>
        openMenu(items(), buttonElement),
      );
      buttonElement.addEventListener("pointerenter", () => {
        // slide between open menus like a native menu bar
        if (
          menusOpen() &&
          document.querySelector(".menubar-item.menu-open") &&
          !buttonElement.classList.contains("menu-open")
        ) {
          openMenu(items(), buttonElement);
        }
      });
      menuBar.append(buttonElement);
    }
    this.titleFile = html("span", { class: "title-file" });
    this.maxBtn = html(
      "button",
      { type: "button", class: "win-btn", tip: "Maximize" },
      icon(Square, 13),
    );
    this.maxBtn.addEventListener("click", async () => {
      await P.toggleMaximize();
      this.syncMaxButton();
    });
    const controls = P.isTauri
      ? html(
          "div",
          { class: "win-controls" },
          html(
            "button",
            {
              type: "button",
              class: "win-btn",
              tip: "Minimize",
              onClick: () => P.minimize(),
            },
            icon(Minus, 15),
          ),
          this.maxBtn,
          html(
            "button",
            {
              type: "button",
              class: "win-btn close",
              tip: "Close",
              onClick: () => P.closeWindow(),
            },
            icon(X, 16),
          ),
        )
      : null;
    const drag = html(
      "div",
      { class: "drag", "data-tauri-drag-region": "" },
      html(
        "span",
        { class: "title-text", "data-tauri-drag-region": "" },
        "Bit Viewer",
      ),
      this.titleFile,
    );
    return html(
      "div",
      { class: "titlebar" },
      html(
        "div",
        { class: "brand", "data-tauri-drag-region": "" },
        logoSvg(20),
      ),
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
      BASE_ORDER.map((base) => ({
        value: base,
        label: BASE_NAMES[base],
        tip: `Switch every row of every value to ${BASE_NAMES[base]}`,
      })),
      { checkable: false, onPick: (base) => this.applyGlobalBase(base) },
    );
    this.themeBtn = button({
      className: "ghost",
      tip: "Toggle light / dark theme (Ctrl+T)",
      onClick: () => this.toggleTheme(),
    });
    this.syncThemeButton();
    const run = (id: string) => () => this.commands.run(id);
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
    return html(
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

  private syncThemeButton() {
    const dark = appSettings.get("theme") === "dark";
    this.themeBtn.replaceChildren(
      icon(dark ? Sun : Moon, 16),
      html("span", {}, dark ? "Light" : "Dark"),
    );
  }

  private buildWorkspace(): HTMLElement {
    const run = (id: string) => () => this.commands.run(id);
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
    this.workspace = html("main", { class: "workspace" }, this.empty);
    return this.workspace;
  }

  private buildStatusbar(): HTMLElement {
    this.zoomLabel = html("button", {
      type: "button",
      class: "zoom-label",
      tip: "Reset zoom (Ctrl+0)",
      onClick: () => appSettings.set("zoom", 1),
    });
    this.updateZoomLabel();
    return html(
      "footer",
      { class: "statusbar" },
      html(
        "span",
        { class: "status-hint" },
        "Click a bit to flip · drag to select · right-click for row actions · F1 for help",
      ),
      html("div", { class: "spacer" }),
      html(
        "div",
        { class: "zoom" },
        button({
          icon: Minus,
          className: "ghost xs",
          tip: "Zoom out (Ctrl+-)",
          onClick: () => this.zoomBy(-1),
          size: 13,
        }),
        this.zoomLabel,
        button({
          icon: Plus,
          className: "ghost xs",
          tip: "Zoom in (Ctrl+=)",
          onClick: () => this.zoomBy(1),
          size: 13,
        }),
      ),
    );
  }

  private updateZoomLabel() {
    this.zoomLabel.textContent = `${Math.round(appSettings.get("zoom") * 100)}%`;
  }

  // ================================================================ settings
  private applyTheme() {
    document.documentElement.dataset.theme = appSettings.get("theme");
    document.body.classList.toggle("compact", appSettings.get("compact"));
    applyAccent(
      appSettings.get("accent"),
      appSettings.get("theme") === "contrast",
    );
  }

  private onSetting(key: string) {
    if (key === "theme" || key === "compact" || key === "accent") {
      this.applyTheme();
      this.syncThemeButton();
    } else if (key === "zoom") {
      P.setZoom(appSettings.get("zoom"));
      this.updateZoomLabel();
    } else if (
      ["msb_left", "show_readouts", "show_interp", "readout_chips"].includes(
        key,
      )
    ) {
      for (const card of this.cards) card.rebuild();
    }
  }

  private toggleSounds() {
    const enabled = !appSettings.get("sounds");
    appSettings.set("sounds", enabled);
    if (enabled) play("bitOn");
    toast(enabled ? "Sounds on" : "Sounds off");
  }

  private toggleTheme() {
    // Ctrl+T switches dark ↔ light; high contrast is chosen in Settings
    appSettings.set(
      "theme",
      appSettings.get("theme") === "dark" ? "light" : "dark",
    );
  }

  private zoomBy(steps: number) {
    appSettings.set("zoom", appSettings.get("zoom") + steps * ZOOM_STEP);
  }

  private applyGlobalBase(base: Base) {
    for (const card of this.cards) card.model.setAllRowBases(base);
    appSettings.set("default_base", base);
    toast(`All rows now use ${BASE_NAMES[base]}`);
  }

  // ================================================================ undo history
  private snapshot(): string {
    return JSON.stringify(this.workspaceJSON());
  }

  /** The values and their peripherals, as saved in files, sessions and undo steps. */
  private workspaceJSON() {
    return {
      values: this.cards.map((card) => valueToJSON(card.model)),
      peripherals: this.usedPeripherals().map(peripheralToJSON),
    };
  }

  /** Peripherals that have registers, in workspace order. */
  private usedPeripherals(): Peripheral[] {
    const out: Peripheral[] = [];
    for (const card of this.cards) {
      const peripheral = this.peripherals.get(card.model.block);
      if (peripheral && !out.includes(peripheral)) out.push(peripheral);
    }
    return out;
  }

  /** Rebuilds the workspace from a snapshot (undo / redo / session restore). */
  private restore(snapshotJson: string) {
    const scroll = this.workspace.scrollTop;
    const data = JSON.parse(snapshotJson);
    const models = (data.values as unknown[]).map((serialized) =>
      valueFromJSON(serialized),
    );
    this.clearCards();
    this.peripherals = peripheralsFromJSON(data.peripherals);
    for (const model of models)
      this.addValue(model.width, model, undefined, false);
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
      ...this.workspaceJSON(),
      savedAt: Date.now(),
    };
  }

  /** Reopens what was open last time. Returns false when there was nothing to restore. */
  private async restoreSession(): Promise<boolean> {
    const session = await loadSession();
    if (!session) return false;
    if (
      !session.dirty &&
      session.path &&
      (await this.loadPath(session.path, true))
    )
      return true;
    if (!session.values) return false;
    try {
      this.loadValues(
        session.values,
        session.path,
        session.fileName,
        session.peripherals,
      );
    } catch {
      return false;
    }
    if (session.dirty) {
      this.savedSnapshot = null; // contents differ from any file on disk
      this.updateTitle();
      toast("Restored unsaved changes from your last session", "ok");
    }
    return true;
  }

  /** Before the app closes (or restarts to install an update): asks about
   *  unsaved changes, then leaves the session and settings on disk. */
  private async prepareToQuit(): Promise<boolean> {
    const dirtyBefore = this.dirty;
    if (!(await this.maybeSave())) return false;
    // "Don't save" means the changes are discarded, so don't bring them back next time
    const discarded = dirtyBefore && this.dirty;
    await saveSessionNow({
      ...this.sessionData(),
      dirty: false,
      values: discarded ? null : this.sessionData().values,
    });
    await appSettings.flush();
    return true;
  }

  // ================================================================ values
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
    const card = new ValueCard(model, {
      remove: (card) => this.removeValue(card),
      move: (card, direction) => this.moveValue(card, direction),
      duplicate: (card) => this.duplicateValue(card),
      resize: (card) => this.resizeValue(card),
      lookup: (_card, name) => this.valueByName(name),
      others: (card) => this.cards.filter((otherCard) => otherCard !== card),
      dragStart: (card, event) => this.dragCard(card, event),
      batch: (holding) =>
        holding ? this.history.hold() : this.history.release(),
      peripheral: (card) => this.peripherals.get(card.model.block),
      peripheralMenu: (card) => this.peripheralMenu(card),
      editOffset: (card) => void this.editOffset(card),
    });
    model.subscribe(() => this.history.touch());
    this.cards.splice(index ?? this.cards.length, 0, card);
    this.relayout();
    this.history.touch();
    if (reveal) {
      play("add");
      card.root.classList.add("enter");
      requestAnimationFrame(() =>
        card.root.scrollIntoView({ block: "nearest", behavior: "smooth" }),
      );
    }
    return card;
  }

  private async removeValue(card: ValueCard) {
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
    this.history.touch();
    play("remove");
  }

  private drop(card: ValueCard) {
    card.detach();
    this.cards.splice(this.cards.indexOf(card), 1);
    card.root.remove();
  }

  /** Drag a card by its handle; a line shows where it will land. */
  private dragCard(card: ValueCard, event: PointerEvent) {
    event.preventDefault();
    if (this.cards.length < 2) return;
    const from = this.cards.indexOf(card);
    let target = from;
    let lastY = event.clientY;
    const line = html("div", { class: "drop-line" });
    card.root.classList.add("dragging");
    document.body.classList.add("reordering");

    const place = () => {
      let index = 0;
      for (const card of this.cards) {
        // a collapsed peripheral's registers aren't laid out: use its header
        const shown = card.root.offsetParent
          ? card.root
          : (card.root.closest(".periph") ?? card.root);
        const rect = shown.getBoundingClientRect();
        if (lastY > rect.top + rect.height / 2) index++;
      }
      target = index;
      const before = this.cards[index]?.root;
      if (before?.parentElement)
        before.parentElement.insertBefore(line, before);
      else this.workspace.append(line);
    };
    // keep scrolling while the pointer rests near the top or bottom edge
    const scroller = window.setInterval(() => {
      const rect = this.workspace.getBoundingClientRect();
      const edge = 48;
      const scrollStep =
        lastY < rect.top + edge ? -14 : lastY > rect.bottom - edge ? 14 : 0;
      if (scrollStep) {
        this.workspace.scrollTop += scrollStep;
        place();
      }
    }, 16);
    const onPointerMove = (pointerEvent: PointerEvent) => {
      lastY = pointerEvent.clientY;
      place();
    };
    const finishDrag = (commit: boolean) => {
      window.clearInterval(scroller);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", onEscape, true);
      window.removeEventListener("blur", cancel);
      line.remove();
      card.root.classList.remove("dragging");
      document.body.classList.remove("reordering");
      const destination = target > from ? target - 1 : target;
      const reordered = moveItem(this.cards, from, destination, this.blockOf);
      if (
        commit &&
        reordered.some((item, index) => item !== this.cards[index])
      ) {
        this.cards = reordered;
        this.relayout();
        this.history.touch();
        play("toggle");
      }
    };
    const onPointerUp = () => finishDrag(true);
    const cancel = () => finishDrag(false);
    const onEscape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") {
        keyEvent.stopPropagation();
        finishDrag(false);
      }
    };
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", onEscape, true);
    window.addEventListener("blur", cancel);
    place();
  }

  private moveValue(card: ValueCard, delta: number) {
    const index = this.cards.indexOf(card);
    const newIndex = index + delta;
    if (newIndex < 0 || newIndex >= this.cards.length) return;
    this.cards = moveItem(this.cards, index, newIndex, this.blockOf);
    this.relayout();
    this.history.touch();
  }

  private async addCustom() {
    const width = await pickWidth(
      "Add value",
      appSettings.get("last_width"),
      "Add value",
    );
    if (width === null) return;
    appSettings.set("last_width", width);
    this.addValue(width);
  }

  private async addFromTemplate() {
    const template = await pickTemplate("Add value from template", "Add value");
    if (!template) return;
    const card = this.addValue(template.width);
    card.model.setName(template.name);
    card.model.applyTemplate(template);
    card.rebuild();
  }

  /** A value by name for expressions. Case, spaces and underscores don't matter. */
  private valueByName(name: string): bigint | undefined {
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

  private async addFromExpression() {
    const widest = Math.max(32, ...this.cards.map((card) => card.model.width));
    const result = await newValueFromExpression(
      (name) => {
        const normalizedName = name.trim().toLowerCase();
        // "x" has no meaning here (there's no current value yet)
        return normalizedName === "x" ? undefined : this.valueByName(name);
      },
      Math.min(widest, 512),
    );
    if (!result) return;
    const card = this.addValue(result.width);
    card.model.setValue(result.value);
    if (result.name) card.model.setName(result.name);
    card.rebuild();
  }

  private async resizeValue(card: ValueCard) {
    const model = card.model;
    const width = await pickWidth(
      `Change width of “${model.name}”`,
      model.width,
      "Change width",
    );
    if (width === null || width === model.width) return;
    const lostParts = model.lostOnResize(width);
    if (lostParts.groups.length) {
      // named fields are only ever removed by the user, never by a resize
      const names = lostParts.groups
        .map((group) => `“${group.name}” ${group.label()}`)
        .join(", ");
      const severalFieldsLost = lostParts.groups.length > 1;
      await ask(
        "Fields don't fit",
        `${names} ${severalFieldsLost ? "don't" : "doesn't"} fit in ${width} bits. ` +
          `Remove ${severalFieldsLost ? "those fields" : "that field"} first, or use at least ${model.minWidthForGroups} bits.`,
        [{ id: "ok", label: "OK", className: "primary" }],
        "ok",
      );
      return;
    }
    if (lostParts.compares || width < model.width) {
      const parts = [`bits above ${width - 1} are cleared`];
      if (lostParts.compares)
        parts.push(
          `${lostParts.compares} compare row${lostParts.compares > 1 ? "s" : ""} no longer fit and will be removed`,
        );
      const answer = await ask(
        "Change width",
        `Shrinking to ${width} bits: ${parts.join(", and ")}.`,
        [
          { id: "cancel", label: "Cancel" },
          { id: "yes", label: "Change width", className: "danger-btn" },
        ],
      );
      if (answer !== "yes") return;
    }
    card.clearSelection();
    model.setWidth(width);
  }

  private duplicateValue(card: ValueCard) {
    const serialized = valueToJSON(card.model);
    serialized.name = `${card.model.name} copy`;
    this.addValue(
      card.model.width,
      valueFromJSON(serialized),
      this.cards.indexOf(card) + 1,
    );
  }

  private relayout() {
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
        const section = this.peripheralSection(block);
        body = section.querySelector(".periph-body");
        children.push(section);
      }
      body!.append(card.root);
    }
    this.workspace.replaceChildren(
      ...(this.cards.length ? children : [this.empty]),
    );
    if (focused instanceof HTMLElement && this.workspace.contains(focused))
      focused.focus({ preventScroll: true });
    if (this.search.isOpen) this.search.apply();
  }

  // ================================================================ peripherals
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

  private members(name: string): ValueCard[] {
    return this.cards.filter((card) => card.model.block === name);
  }

  /** The block for one peripheral: header plus a body the cards go into. */
  private peripheralSection(name: string): HTMLElement {
    const peripheral = this.peripherals.get(name)!;
    const body = html("div", {
      class: "periph-body",
      role: "group",
      "aria-label": `Registers of ${name}`,
    });
    return html(
      "section",
      {
        class: `periph${peripheral.collapsed ? " collapsed" : ""}`,
        "data-peripheral": name,
      },
      peripheralHeader(
        peripheral,
        this.members(name).length,
        this.peripheralActions(name),
      ),
      body,
    );
  }

  /** Records a change to the peripherals themselves (not their values). */
  private peripheralsChanged() {
    this.relayout();
    this.history.touch();
  }

  private peripheralActions(name: string): PeripheralActions {
    const peripheral = () => this.peripherals.get(name)!;
    return {
      toggle: () => {
        peripheral().collapsed = !peripheral().collapsed;
        play("toggle");
        this.peripheralsChanged();
      },
      edit: () => void this.editPeripheral(name),
      exportCode: () =>
        void exportCode({
          kind: "peripheral",
          peripheral: peripheral(),
          models: this.members(name).map((card) => card.model),
        }),
      addRegister: () => {
        const members = this.members(name);
        const taken = new Set(this.cards.map((card) => card.model.name));
        let number = members.length + 1;
        while (taken.has(`${name}.REG${number}`)) number++;
        const model = new ValueModel({
          width: 32,
          name: `${name}.REG${number}`,
          view: appSettings.get("default_view"),
          defaultRowBase: appSettings.get("default_base"),
        });
        model.setPeripheral(
          name,
          nextOffset(members.map((card) => card.model)),
        );
        if (peripheral().collapsed) peripheral().collapsed = false;
        const last = this.cards.indexOf(members[members.length - 1]);
        this.addValue(32, model, last + 1);
      },
      sortByOffset: () => {
        const members = this.members(name);
        const sorted = [...members].sort((first, second) => {
          const [a, b] = [first.model.offset, second.model.offset];
          if (a === null || b === null)
            return a === null ? (b === null ? 0 : 1) : -1;
          return a < b ? -1 : a > b ? 1 : 0;
        });
        let next = 0;
        this.cards = this.cards.map((card) =>
          card.model.block === name ? sorted[next++] : card,
        );
        this.peripheralsChanged();
      },
      move: (direction) => {
        this.cards = moveBlock(this.cards, name, direction, this.blockOf);
        this.peripheralsChanged();
      },
      ungroup: () => {
        const members = this.members(name);
        this.history.hold(); // one undo step
        try {
          for (const card of members) card.model.setPeripheral("", null);
        } finally {
          this.history.release();
        }
        this.relayout();
        toast(`Ungrouped ${name}; Ctrl+Z puts it back`);
      },
      remove: async () => {
        const members = this.members(name);
        const answer = await ask(
          "Remove peripheral",
          `Remove ${name} and its ${members.length} register${members.length === 1 ? "" : "s"}?`,
          [
            { id: "cancel", label: "Cancel" },
            { id: "yes", label: "Remove", className: "danger-btn" },
          ],
        );
        if (answer !== "yes") return;
        for (const card of members) this.drop(card);
        this.relayout();
        this.history.touch();
        play("remove");
      },
    };
  }

  private async editPeripheral(name: string) {
    const peripheral = this.peripherals.get(name);
    if (!peripheral) return;
    const result = await editPeripheralDialog(
      `Peripheral “${name}”`,
      peripheral,
      (candidate) => candidate !== name && this.peripherals.has(candidate),
    );
    if (!result) return;
    this.history.hold(); // renaming touches every register: one undo step
    try {
      this.peripherals.delete(name);
      this.peripherals.set(result.name, {
        ...peripheral,
        name: result.name,
        base: result.base,
        description: result.description,
      });
      for (const card of this.members(name)) {
        const model = card.model;
        // "UART0.CTRL" follows a rename of UART0
        if (result.name !== name && model.name.startsWith(`${name}.`))
          model.setName(result.name + model.name.slice(name.length));
        model.setPeripheral(result.name, model.offset);
        card.rebuild(); // the address badge depends on the base
      }
      this.relayout();
      this.history.touch();
    } finally {
      this.history.release();
    }
  }

  /** The "Peripheral" submenu of a value. */
  private peripheralMenu(card: ValueCard): MenuItem[] {
    const model = card.model;
    const hex = (value: bigint) => `0x${value.toString(16).toUpperCase()}`;
    const items: MenuItem[] = [
      {
        label: "New peripheral from this value…",
        action: () => void this.newPeripheral(card),
      },
    ];
    const others = this.usedPeripherals().filter(
      (peripheral) => peripheral.name !== model.block,
    );
    if (others.length)
      items.push({
        label: model.block ? "Move to another peripheral" : "Add to peripheral",
        submenu: others.map((peripheral) => ({
          label: peripheral.name,
          shortcut: peripheral.base === null ? undefined : hex(peripheral.base),
          action: () => this.moveToPeripheral(card, peripheral.name),
        })),
      });
    if (model.block)
      items.push(
        "sep",
        {
          label: "Change offset…",
          action: () => void this.editOffset(card),
        },
        {
          label: `Take out of ${model.block}`,
          action: () => {
            model.setPeripheral("", null);
            this.relayout();
          },
        },
      );
    return items;
  }

  private async newPeripheral(card: ValueCard) {
    const model = card.model;
    const dot = model.name.indexOf(".");
    const suggestion = freeName(
      dot > 0 ? model.name.slice(0, dot) : "PERIPH",
      (name) => this.peripherals.has(name),
    );
    const result = await editPeripheralDialog(
      "New peripheral",
      {
        name: suggestion,
        base: null,
        description: "",
        offset: model.offset ?? 0n,
      },
      (name) => this.peripherals.has(name),
    );
    if (!result) return;
    this.peripherals.set(result.name, {
      name: result.name,
      base: result.base,
      description: result.description,
      collapsed: false,
    });
    model.setPeripheral(result.name, result.offset ?? null);
    this.relayout();
    play("group");
  }

  /** Adds a value to another peripheral, after its last register. */
  private moveToPeripheral(card: ValueCard, name: string) {
    const members = this.members(name);
    const offset = nextOffset(members.map((member) => member.model));
    this.cards.splice(this.cards.indexOf(card), 1);
    this.cards.splice(
      this.cards.indexOf(members[members.length - 1]) + 1,
      0,
      card,
    );
    card.model.setPeripheral(name, offset);
    this.relayout();
    toast(`Moved to ${name} at offset 0x${offset.toString(16).toUpperCase()}`);
  }

  private async editOffset(card: ValueCard) {
    const model = card.model;
    if (!model.block) return;
    const offset = await askOffset(model.name, model.block, model.offset);
    if (offset === undefined) return;
    model.setPeripheral(model.block, offset);
  }

  private groupSelection() {
    const card = this.cards.find((candidate) => candidate.selection);
    if (card) card.createGroupFromSelection();
    else toast("Select some bits first (drag across them)");
  }

  private clearSelections() {
    for (const card of this.cards) card.clearSelection();
  }

  // ================================================================ files
  private updateTitle() {
    const dirtyMark = this.dirty ? " •" : "";
    this.titleFile.textContent = `${this.fileName}${dirtyMark}`;
    P.setTitle(`${this.fileName}${dirtyMark} — Bit Viewer`);
  }

  /** Resolves true when it is fine to discard the current workspace. */
  private async maybeSave(): Promise<boolean> {
    this.history.flush();
    if (!this.dirty || !this.cards.length) return true;
    const answer = await ask(
      "Unsaved changes",
      `Save changes to “${this.fileName}”?`,
      [
        { id: "cancel", label: "Cancel" },
        { id: "discard", label: "Don't save", className: "outline" },
        { id: "save", label: "Save", className: "primary" },
      ],
    );
    if (answer === "save") return this.save();
    return answer === "discard";
  }

  private clearCards() {
    for (const card of [...this.cards]) this.drop(card);
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
    const files = P.isTauri ? appSettings.get("recent_files") : [];
    const folder = (path: string) => {
      const directory = path.slice(
        0,
        Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")),
      );
      return directory.length > 38 ? `…${directory.slice(-37)}` : directory;
    };
    return {
      label: "Open recent",
      icon: FolderClock,
      disabled: !files.length,
      submenu: [
        ...files.map(
          (path): MenuItem => ({
            label: P.basename(path),
            shortcut: folder(path),
            action: () => this.openRecent(path),
          }),
        ),
        "sep",
        {
          label: "Clear list",
          action: () => appSettings.set("recent_files", []),
        },
      ],
    };
  }

  private async openRecent(path: string) {
    if (!(await this.maybeSave())) return;
    if (!(await this.loadPath(path))) appSettings.removeRecent(path);
  }

  private installFileDrop() {
    const overlay = html(
      "div",
      { class: "drop-overlay" },
      html(
        "div",
        { class: "drop-card" },
        icon(FolderOpen, 28),
        html("b", {}, "Drop to open the workspace"),
      ),
    );
    document.body.append(overlay);
    void P.onFileDrop(
      (over) => overlay.classList.toggle("show", over),
      async (openedFile) => {
        // an SVD adds values to the workspace; anything else replaces it
        if (looksLikeSvd(openedFile)) return this.importSvd(openedFile);
        if (!(await this.maybeSave())) return;
        await this.loadText(openedFile.text, openedFile.path, openedFile.name);
      },
      (name, error) => this.fail("Could not open file", error, name),
    );
  }

  private async openFile() {
    if (!(await this.maybeSave())) return;
    try {
      const openedFile = await P.pickAndRead(
        appSettings.get("last_dir") || (await P.defaultDir()),
      );
      if (openedFile)
        await this.loadText(openedFile.text, openedFile.path, openedFile.name);
    } catch (error) {
      this.fail("Could not open file", error);
    }
  }

  /** Reads a CMSIS-SVD file (picked, or `file` when dropped) and adds the
   *  registers the user chooses as values, or saves them as templates. */
  private async importSvd(file?: P.OpenedFile) {
    let opened = file ?? null;
    if (!opened) {
      try {
        opened = await P.pickAndRead(
          appSettings.get("last_dir") || (await P.defaultDir()),
          P.SVD_OPEN,
        );
      } catch (error) {
        this.fail("Could not open the SVD file", error);
        return;
      }
    }
    if (!opened) return;
    let device: ReturnType<typeof parseSvd>;
    try {
      device = parseSvd(opened.text);
    } catch (error) {
      this.fail("Could not read the SVD file", error, opened.name);
      return;
    }
    if (opened.path) this.rememberDir(opened.path);
    const choice = await pickSvdRegisters(device, opened.name);
    if (!choice) return;
    if (choice.action === "templates") {
      const templates = choice.registers.map((register) =>
        registerTemplate(register, device.name),
      );
      const names = new Set(
        templates.map((template) => template.name.toLowerCase()),
      );
      const kept = appSettings
        .get("templates")
        .filter((template) => !names.has(template.name.toLowerCase()));
      const replaced = appSettings.get("templates").length - kept.length;
      appSettings.set("templates", [...kept, ...templates]);
      toast(
        `Saved ${templates.length} template${templates.length === 1 ? "" : "s"}${replaced ? ` (${replaced} replaced)` : ""}`,
        "ok",
      );
      return;
    }
    await this.addSvdValues(choice.registers, device);
  }

  /** Adds SVD registers as values, each in a peripheral block of its own
   *  peripheral (an existing one with the same name and base is reused). */
  private async addSvdValues(registers: SvdRegister[], device: SvdDevice) {
    const deviceName = device.name;
    if (registers.length > 50) {
      const answer = await ask(
        "Add many values?",
        `This adds ${registers.length} values to the workspace. Large workspaces get slower to scroll and edit.`,
        [
          { id: "cancel", label: "Cancel" },
          {
            id: "yes",
            label: `Add ${registers.length} values`,
            className: "primary",
          },
        ],
      );
      if (answer !== "yes") return;
    }
    let firstCard: ValueCard | null = null;
    const blocks = new Map<string, string>(); // SVD peripheral → workspace peripheral
    this.history.hold(); // one undo step for the whole import
    try {
      for (const register of registers) {
        const source = device.peripherals.find(
          (peripheral) => peripheral.name === register.peripheral,
        )!;
        let block = blocks.get(source.name);
        if (!block) {
          const existing = this.peripherals.get(source.name);
          block =
            existing && existing.base === source.baseAddress
              ? source.name
              : freeName(source.name, (name) => this.peripherals.has(name));
          if (block !== source.name || !existing)
            this.peripherals.set(block, {
              name: block,
              base: source.baseAddress,
              description: source.description,
              collapsed: false,
            });
          blocks.set(source.name, block);
        }
        const model = new ValueModel({
          width: register.size,
          value: register.resetValue,
          name: register.path,
          view: appSettings.get("default_view"),
          defaultRowBase: appSettings.get("default_base"),
        });
        model.applyTemplate(registerTemplate(register, deviceName));
        model.setPeripheral(block, register.address - source.baseAddress);
        model.setDescription(register.description);
        const members = this.members(block);
        const index = members.length
          ? this.cards.indexOf(members[members.length - 1]) + 1
          : undefined;
        const card = this.addValue(model.width, model, index, false);
        firstCard ??= card;
      }
    } finally {
      this.history.release();
    }
    play("add");
    firstCard?.root.scrollIntoView({
      block: "start",
      behavior: "smooth",
    });
    toast(
      `Added ${registers.length} value${registers.length === 1 ? "" : "s"} from ${deviceName}`,
      "ok",
    );
  }

  private async loadPath(path: string, quiet = false): Promise<boolean> {
    try {
      return await this.loadText(
        await P.readText(path),
        path,
        P.basename(path),
        quiet,
      );
    } catch (error) {
      if (!quiet) this.fail("Could not open file", error, path);
      return false;
    }
  }

  private async loadText(
    text: string,
    path: string | null,
    name: string,
    quiet = false,
  ): Promise<boolean> {
    let values: unknown[];
    let peripherals: unknown;
    let fileVersion: number;
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || data.app !== "bitviewer") {
        throw new ModelError("This is not a Bit Viewer workspace file");
      }
      fileVersion = Number(data.version ?? 1);
      if (!Number.isInteger(fileVersion) || fileVersion < 1)
        throw new ModelError(`Unknown file format version ${data.version}`);
      values = data.values ?? [];
      if (!Array.isArray(values))
        throw new ModelError("The file's values aren't a list");
      // validate everything before replacing the workspace
      for (const serialized of values) valueFromJSON(serialized);
      peripheralsFromJSON(data.peripherals);
      peripherals = data.peripherals;
    } catch (error) {
      if (!quiet) this.fail("Could not open file", error, name);
      return false;
    }
    if (fileVersion > FILE_VERSION && !quiet) {
      const answer = await ask(
        "Saved by a newer version",
        `“${name}” was saved by a newer version of Bit Viewer (file format ${fileVersion}; this version reads format ${FILE_VERSION}). ` +
          "Anything this version doesn't understand is left out, and is lost if you save over the file. Update Bit Viewer to keep it.",
        [
          { id: "cancel", label: "Cancel" },
          { id: "open", label: "Open anyway", className: "primary" },
        ],
      );
      if (answer !== "open") return false;
    }
    this.loadValues(values, path, name, peripherals);
    if (path) {
      this.rememberDir(path);
      appSettings.addRecent(path);
    }
    void saveSessionNow(this.sessionData());
    if (!quiet) toast(`Opened ${name}`, "ok");
    return true;
  }

  /** Replaces the workspace and starts a fresh undo history. */
  private loadValues(
    values: unknown[],
    path: string | null,
    name: string,
    peripherals?: unknown,
  ) {
    const models = values.map((serialized) => valueFromJSON(serialized));
    const blocks = peripheralsFromJSON(peripherals);
    this.clearCards();
    this.peripherals = blocks;
    for (const model of models)
      this.addValue(model.width, model, undefined, false);
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
    const directory = appSettings.get("last_dir") || (await P.defaultDir());
    const start =
      this.path ??
      (directory
        ? P.joinPath(directory, "workspace.bitview")
        : "workspace.bitview");
    let path = await P.pickSavePath(start);
    if (!path) return false;
    if (!/\.(bitview|json)$/i.test(path)) path += ".bitview";
    return this.write(path);
  }

  private async write(path: string): Promise<boolean> {
    this.history.flush();
    const data = {
      app: "bitviewer",
      version: FILE_VERSION,
      ...this.workspaceJSON(),
    };
    try {
      await P.writeText(path, JSON.stringify(data, null, 2));
    } catch (error) {
      this.fail("Could not save", error, path);
      return false;
    }
    this.path = P.isTauri ? path : null;
    this.fileName = P.basename(path);
    this.rememberDir(path);
    if (P.isTauri) appSettings.addRecent(path);
    this.markSaved();
    void saveSessionNow(this.sessionData());
    toast(`Saved ${this.fileName}`, "ok");
    return true;
  }

  private rememberDir(path: string) {
    const separatorIndex = Math.max(
      path.lastIndexOf("\\"),
      path.lastIndexOf("/"),
    );
    if (separatorIndex > 0)
      appSettings.set("last_dir", path.slice(0, separatorIndex));
  }

  private fail(title: string, error: unknown, where = "") {
    const message = error instanceof Error ? error.message : String(error);
    ask(
      title,
      where ? `${where}\n\n${message}` : message,
      [{ id: "ok", label: "OK", className: "primary" }],
      "ok",
    );
  }

  // ================================================================ input
  private installInput() {
    window.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        this.wheelAcc += -event.deltaY;
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

    const track = (event: Event) => {
      const card = this.cards.find((candidate) =>
        candidate.root.contains(event.target as Node),
      );
      if (card) this.activeCard = card;
    };
    document.addEventListener("pointerdown", track, true);
    // Record any pending undo step before the next edit starts, so that a bit
    // click followed instantly by typing (or the reverse) stays two steps.
    // Capture-phase listeners run before the field's or strip's own handlers.
    document.addEventListener("input", () => this.history.flush(), true);
    document.addEventListener("pointerdown", () => this.history.flush(), true);
    document.addEventListener("focusin", track);

    document.addEventListener("keydown", (event) => {
      if (modalOpen() || menusOpen() || paletteOpen() || tourRunning()) return;
      // Esc inside a field reverts that field instead of clearing the selection
      if (event.key === "Escape" && isTextField(document.activeElement)) return;
      this.commands.handleKey(event);
    });

    // Clicking anywhere that isn't part of selecting drops the selection.
    document.addEventListener("pointerdown", (event) => {
      if (!this.cards.some((card) => card.selection)) return;
      const target = event.target as Element;
      if (target.closest(".bit, .row-label, .menu, .backdrop, [data-keep-sel]"))
        return;
      // clicks on a scrollbar land on the scrolling element itself
      if (
        target instanceof HTMLElement &&
        (event.offsetX >= target.clientWidth ||
          event.offsetY >= target.clientHeight)
      )
        return;
      this.clearSelections();
    });

    document.addEventListener("contextmenu", (event) => {
      // keep the native menu for text fields, suppress the browser one elsewhere
      if (!isTextField(event.target)) event.preventDefault();
    });
  }
}
