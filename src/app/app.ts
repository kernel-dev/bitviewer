// The main window. App builds it and connects the parts:
//
//   workspace/   the values on screen, peripherals, drag to reorder, SVD import
//   document.ts  the open file: save, open, unsaved changes, auto-saved session
//   commands/    every action (menus, shortcuts and the palette use them)
//   chrome/      title bar, toolbar and status bar
//   input.ts     window-wide keyboard and mouse handling
//   view.ts      theme, zoom and other view settings
//
// Undo (history.ts) works on snapshots of the whole workspace.

import type { ValueCard } from "../card/card";
import { VERSION } from "../dialogs/help";
import { showWhatsNew } from "../dialogs/whats-new";
import * as P from "../platform/native";
import { saveSessionNow, saveSessionSoon } from "../platform/session";
import { appSettings } from "../platform/settings";
import { html, modalOpen } from "../ui/kit";
import { Statusbar } from "./chrome/statusbar";
import { Titlebar } from "./chrome/titlebar";
import { Toolbar } from "./chrome/toolbar";
import { registerCommands } from "./commands";
import { CommandRegistry } from "./commands/registry";
import { WorkspaceDocument } from "./document";
import { History } from "./history";
import { installInput } from "./input";
import { SearchBar } from "./search";
import { startTour } from "./tour";
import { checkForUpdates } from "./updates";
import { applyTheme } from "./view";
import { PeripheralController } from "./workspace/peripherals";
import { Workspace } from "./workspace/workspace";

export class App {
  readonly commands = new CommandRegistry();

  readonly history = new History(
    (previous) => this.workspace.snapshot(previous),
    (snapshot) => this.workspace.restore(snapshot),
    () => this.onHistoryChange(),
  );

  readonly search = new SearchBar(
    () => this.workspace.cards,
    () => this.workspace.buildNearView(),
  );

  readonly workspace = new Workspace(this);
  readonly peripherals = new PeripheralController(this);
  readonly document = new WorkspaceDocument(this);
  titlebar!: Titlebar;
  private toolbar!: Toolbar;
  private statusbar!: Statusbar;

  constructor(private root: HTMLElement) {}

  /** The values in the workspace, in order. */
  get cards(): ValueCard[] {
    return this.workspace.cards;
  }

  async start() {
    registerCommands(this);
    applyTheme();
    await P.setZoom(appSettings.get("zoom"));
    this.titlebar = new Titlebar(this);
    this.toolbar = new Toolbar(this);
    this.statusbar = new Statusbar();
    this.root.replaceChildren(
      this.titlebar.element,
      html(
        "div",
        { class: "topbars" },
        this.toolbar.element,
        this.search.element,
      ),
      this.workspace.element,
      this.statusbar.element,
    );
    installInput(this);
    this.document.installFileDrop();
    appSettings.onChange((key) => this.onSetting(key));
    await P.guardClose(
      () => this.document.prepareToQuit(),
      () => void saveSessionNow(this.document.sessionData()),
    );
    await P.onResized(() => this.titlebar.syncMaxButton());
    this.titlebar.syncMaxButton();

    await P.onOpenFile(async (path) => {
      if (await this.document.maybeSave()) await this.document.loadPath(path);
    });

    const initial = await P.initialFile();
    if (
      !(initial && (await this.document.loadPath(initial))) &&
      !(await this.document.restoreSession())
    )
      this.document.startFresh();

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
        () => void checkForUpdates(false, () => this.document.prepareToQuit()),
        2300,
      );
  }

  async runTour() {
    if (modalOpen()) return;
    await startTour();
    appSettings.set("tour_done", true);
  }

  private onHistoryChange() {
    this.toolbar.syncHistory(this.history.canUndo, this.history.canRedo);
    this.document.updateTitle();
    saveSessionSoon(() => this.document.sessionData());
  }

  private onSetting(key: string) {
    if (key === "theme" || key === "compact" || key === "accent") {
      applyTheme();
      this.toolbar.syncTheme();
    } else if (key === "zoom") {
      P.setZoom(appSettings.get("zoom"));
      this.statusbar.updateZoom();
    } else if (
      ["msb_left", "show_readouts", "show_interp", "readout_chips"].includes(
        key,
      )
    ) {
      for (const card of this.workspace.cards) card.rebuildWhenShown();
    }
  }
}
