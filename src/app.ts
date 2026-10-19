// Main window: custom title bar, menus, toolbar, workspace, status bar,
// keyboard shortcuts, zoom and save/load.
import {
  CircleQuestionMark, FilePlus, FolderOpen, Info, Keyboard, LogOut, Maximize, Minimize, Minus, Moon, Plus,
  RotateCcw, Ruler, Save, SaveAll, Volume2, VolumeX, Settings as SettingsIcon, SlidersHorizontal, Square, Sun, X, ZoomIn, ZoomOut,
} from "lucide";
import { ValueCard } from "./card";
import { MAX_WIDTH, MIN_WIDTH, ModelError, ValueModel } from "./model";
import { Base, BASE_NAMES, BASE_ORDER } from "./numfmt";
import * as P from "./platform";
import { S, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from "./settings";
import { play } from "./sound";
import { ask, button, h, icon, MenuItem, menusOpen, modal, modalOpen, openMenu, segmented, toast, toggleSwitch } from "./ui";

const FILE_VERSION = 1;
const VERSION = "2.0.0";

export function logoSvg(size: number): SVGElement {
  // 4×4 grid of bits, the same mark as the app icon
  const on = [1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1];
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.classList.add("logo");
  const bg = document.createElementNS(ns, "rect");
  Object.entries({ x: 1, y: 1, width: 62, height: 62, rx: 14, class: "logo-bg" }).forEach(([k, v]) => bg.setAttribute(k, String(v)));
  svg.append(bg);
  on.forEach((v, i) => {
    const r = document.createElementNS(ns, "rect");
    const x = 9 + (i % 4) * 12;
    const y = 9 + Math.floor(i / 4) * 12;
    Object.entries({ x, y, width: 10, height: 10, rx: 2.5, class: v ? "logo-on" : "logo-off" })
      .forEach(([k, val]) => r.setAttribute(k, String(val)));
    svg.append(r);
  });
  return svg;
}

export class App {
  private cards: ValueCard[] = [];
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
    this.applyTheme();
    await P.setZoom(S.get("zoom"));
    this.root.replaceChildren(this.buildTitlebar(), this.buildToolbar(), this.buildWorkspace(), this.buildStatusbar());
    this.installShortcuts();
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

  // ================================================================ chrome
  private buildTitlebar(): HTMLElement {
    const menus: [string, () => MenuItem[]][] = [
      ["File", () => [
        { label: "New workspace", icon: FilePlus, shortcut: "Ctrl+N", action: () => this.newWorkspace() },
        { label: "Open…", icon: FolderOpen, shortcut: "Ctrl+O", action: () => this.openFile() },
        "sep",
        { label: "Save", icon: Save, shortcut: "Ctrl+S", action: () => this.save() },
        { label: "Save as…", icon: SaveAll, shortcut: "Ctrl+Shift+S", action: () => this.saveAs() },
        "sep",
        { label: "Quit", icon: LogOut, action: () => P.closeWindow() },
      ]],
      ["Edit", () => [
        { label: "Add 32-bit value", icon: Plus, shortcut: "Ctrl+1", action: () => this.addValue(32) },
        { label: "Add 64-bit value", icon: Plus, shortcut: "Ctrl+2", action: () => this.addValue(64) },
        { label: "Add value with custom width…", icon: Ruler, shortcut: "Ctrl+3", action: () => this.addCustom() },
        "sep",
        { label: "Group selection", shortcut: "Ctrl+G", action: () => this.groupSelection() },
        { label: "Clear selection", shortcut: "Esc", action: () => this.clearSelections() },
      ]],
      ["View", () => [
        { label: "Zoom in", icon: ZoomIn, shortcut: "Ctrl+=", action: () => this.zoomBy(1) },
        { label: "Zoom out", icon: ZoomOut, shortcut: "Ctrl+-", action: () => this.zoomBy(-1) },
        { label: "Reset zoom", icon: RotateCcw, shortcut: "Ctrl+0", action: () => S.set("zoom", 1) },
        "sep",
        { label: S.get("theme") === "dark" ? "Light theme" : "Dark theme", icon: S.get("theme") === "dark" ? Sun : Moon,
          shortcut: "Ctrl+T", action: () => this.toggleTheme() },
        { label: S.get("sounds") ? "Turn sounds off" : "Turn sounds on", icon: S.get("sounds") ? VolumeX : Volume2,
          action: () => this.toggleSounds() },
        "sep",
        { label: "Settings…", icon: SettingsIcon, shortcut: "Ctrl+,", action: () => this.openSettings() },
      ]],
      ["Help", () => [
        { label: "Controls", icon: Keyboard, shortcut: "F1", action: () => this.showControls() },
        { label: "About Bit Viewer", icon: Info, action: () => this.showAbout() },
      ]],
    ];
    const menuBar = h("nav", { class: "menubar" });
    for (const [name, items] of menus) {
      const b = h("button", { type: "button", class: "menubar-item", "data-keep-sel": "" }, name);
      b.addEventListener("click", () => openMenu(items(), b));
      b.addEventListener("pointerenter", () => {
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
      ? h("div", { class: "win-controls" },
        h("button", { type: "button", class: "win-btn", tip: "Minimize", onClick: () => P.minimize() }, icon(Minus, 15)),
        this.maxBtn,
        h("button", { type: "button", class: "win-btn close", tip: "Close", onClick: () => P.closeWindow() }, icon(X, 16)))
      : null;
    const drag = h("div", { class: "drag", "data-tauri-drag-region": "" },
      h("span", { class: "title-text", "data-tauri-drag-region": "" }, "Bit Viewer"), this.titleFile);
    return h("div", { class: "titlebar" },
      h("div", { class: "brand", "data-tauri-drag-region": "" }, logoSvg(20)),
      menuBar, drag, controls);
  }

  private async syncMaxButton() {
    if (!P.isTauri) return;
    const max = await P.isMaximized();
    this.maxBtn.replaceChildren(icon(max ? Minimize : Maximize, 13));
    this.maxBtn.dataset.max = max ? "1" : "";
  }

  private buildToolbar(): HTMLElement {
    const allRows = segmented(BASE_ORDER.map((b) => ({ value: b, label: BASE_NAMES[b], tip: `Switch every row of every value to ${BASE_NAMES[b]}` })),
      { checkable: false, onPick: (b) => this.applyGlobalBase(b) });
    this.themeBtn = button({ cls: "ghost", tip: "Toggle light / dark theme (Ctrl+T)", onClick: () => this.toggleTheme() });
    this.syncThemeButton();
    return h("div", { class: "toolbar" },
      button({ icon: Plus, label: "32-bit", cls: "primary", tip: "Add a 32-bit value (Ctrl+1)", onClick: () => this.addValue(32) }),
      button({ icon: Plus, label: "64-bit", cls: "primary", tip: "Add a 64-bit value (Ctrl+2)", onClick: () => this.addValue(64) }),
      button({ icon: Ruler, label: "Custom", cls: "outline", tip: `Add a value with any width, ${MIN_WIDTH}–${MAX_WIDTH} bits (Ctrl+3)`, onClick: () => this.addCustom() }),
      h("div", { class: "tb-sep" }),
      button({ icon: FolderOpen, label: "Open", cls: "ghost", tip: "Open a workspace (Ctrl+O)", onClick: () => this.openFile() }),
      button({ icon: Save, label: "Save", cls: "ghost", tip: "Save the workspace (Ctrl+S)", onClick: () => this.save() }),
      h("div", { class: "tb-sep" }),
      h("span", { class: "tb-label" }, "All rows"),
      allRows.el,
      h("div", { class: "spacer" }),
      this.themeBtn,
      button({ icon: SlidersHorizontal, label: "Settings", cls: "ghost", tip: "Settings (Ctrl+,)", onClick: () => this.openSettings() }));
  }

  private syncThemeButton() {
    const dark = S.get("theme") === "dark";
    this.themeBtn.replaceChildren(icon(dark ? Sun : Moon, 16), h("span", {}, dark ? "Light" : "Dark"));
  }

  private buildWorkspace(): HTMLElement {
    this.empty = h("div", { class: "empty" },
      logoSvg(56),
      h("h3", {}, "No values yet"),
      h("p", { class: "muted" }, "Add a value to start inspecting bits."),
      h("div", { class: "empty-actions" },
        button({ icon: Plus, label: "32-bit value", cls: "primary", onClick: () => this.addValue(32) }),
        button({ icon: Plus, label: "64-bit value", cls: "outline", onClick: () => this.addValue(64) }),
        button({ icon: Ruler, label: "Custom width", cls: "outline", onClick: () => this.addCustom() })));
    this.workspace = h("main", { class: "workspace" }, this.empty);
    return this.workspace;
  }

  private buildStatusbar(): HTMLElement {
    this.zoomLabel = h("button", { type: "button", class: "zoom-label", tip: "Reset zoom (Ctrl+0)", onClick: () => S.set("zoom", 1) });
    this.updateZoomLabel();
    return h("footer", { class: "statusbar" },
      h("span", { class: "status-hint" }, "Click a bit to flip · drag to select · right-click for row actions · F1 for help"),
      h("div", { class: "spacer" }),
      h("div", { class: "zoom" },
        button({ icon: Minus, cls: "ghost xs", tip: "Zoom out (Ctrl+-)", onClick: () => this.zoomBy(-1), size: 13 }),
        this.zoomLabel,
        button({ icon: Plus, cls: "ghost xs", tip: "Zoom in (Ctrl+=)", onClick: () => this.zoomBy(1), size: 13 })));
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

  private openSettings() {
    modal<void>({
      title: "Settings",
      icon: SlidersHorizontal,
      wide: true,
      cancelValue: undefined,
      build: (body, close) => {
        const section = (name: string, ...rows: HTMLElement[]) =>
          h("section", { class: "set-section" }, h("h4", {}, name), h("div", { class: "set-card" }, ...rows));
        const row = (label: string, control: HTMLElement, hint = "") =>
          h("div", { class: "set-row" }, h("div", {}, h("div", { class: "set-label" }, label),
            hint ? h("div", { class: "set-hint" }, hint) : null), control);

        const theme = segmented([{ value: "dark" as const, label: "Dark", icon: Moon }, { value: "light" as const, label: "Light", icon: Sun }],
          { value: S.get("theme"), onPick: (v) => S.set("theme", v) });
        const zoomVal = h("span", { class: "mono zoom-val" }, `${Math.round(S.get("zoom") * 100)}%`);
        const slider = h("input", { type: "range", class: "slider", min: ZOOM_MIN * 100, max: ZOOM_MAX * 100, step: 10, value: Math.round(S.get("zoom") * 100) });
        const paint = () => slider.style.setProperty("--p", `${((+slider.value - ZOOM_MIN * 100) / ((ZOOM_MAX - ZOOM_MIN) * 100)) * 100}%`);
        paint();
        slider.addEventListener("input", () => {
          zoomVal.textContent = `${slider.value}%`;
          paint();
        });
        slider.addEventListener("change", () => S.set("zoom", +slider.value / 100));

        const order = segmented([{ value: true, label: "MSB left  7…0" }, { value: false, label: "LSB left  0…7" }],
          { value: S.get("msb_left"), onPick: (v) => S.set("msb_left", v) });
        const view = segmented([{ value: "line" as const, label: "Line" }, { value: "byte" as const, label: "Bytes" }, { value: "nibble" as const, label: "Nibbles" }],
          { value: S.get("default_view"), onPick: (v) => S.set("default_view", v) });
        const base = segmented(BASE_ORDER.map((b) => ({ value: b, label: BASE_NAMES[b] })),
          { value: S.get("default_base"), onPick: (v) => S.set("default_base", v) });

        const volVal = h("span", { class: "mono zoom-val" }, `${Math.round(S.get("sound_volume") * 100)}%`);
        const volume = h("input", { type: "range", class: "slider", min: 0, max: 100, step: 5, value: Math.round(S.get("sound_volume") * 100) });
        const paintVol = () => {
          volume.style.setProperty("--p", `${volume.value}%`);
          volume.disabled = !S.get("sounds");
        };
        paintVol();
        volume.addEventListener("input", () => {
          volVal.textContent = `${volume.value}%`;
          S.set("sound_volume", +volume.value / 100);
          paintVol();
        });
        volume.addEventListener("change", () => play("bitOn"));
        const soundSwitch = toggleSwitch(S.get("sounds"), (v) => {
          S.set("sounds", v);
          paintVol();
          if (v) play("bitOn");
        });
        body.append(
          section("Appearance",
            row("Theme", theme.el),
            row("Zoom", h("div", { class: "zoom-ctl" }, slider, zoomVal), "Ctrl + mouse wheel anywhere · Ctrl+0 resets")),
          section("Bits",
            row("Bit order in a row", order.el),
            row("Layout for new values", view.el, "Line puts every bit on one line across the window"),
            row("Row base for new values", base.el)),
          section("Sounds",
            row("Interface sounds", soundSwitch, "Short sounds for flipping bits, selecting, fields, operations and errors"),
            row("Volume", h("div", { class: "zoom-ctl" }, volume, volVal,
              button({ icon: Volume2, cls: "ghost sm", tip: "Play a test sound", onClick: () => play("group", true) })))),
          section("Readouts",
            row("Per-row readouts", toggleSwitch(S.get("show_readouts"), (v) => S.set("show_readouts", v)), "hex · dec · oct next to each byte / nibble row"),
            row("Interpretations", toggleSwitch(S.get("show_interp"), (v) => S.set("show_interp", v)), "unsigned, signed, set bits and IEEE-754 float")),
        );
        return [button({ label: "Done", cls: "primary", onClick: () => close() })];
      },
    });
  }

  // ================================================================ values
  addValue(width: number, model?: ValueModel, index?: number, reveal = true): ValueCard {
    if (!model) {
      const names = new Set(this.cards.map((c) => c.model.name));
      let n = this.cards.length + 1;
      while (names.has(`Value ${n}`)) n++;
      model = new ValueModel({ width, name: `Value ${n}`, view: S.get("default_view"), defaultRowBase: S.get("default_base") });
    }
    const card = new ValueCard(model, {
      remove: (c) => this.removeValue(c),
      move: (c, d) => this.moveValue(c, d),
      duplicate: (c) => this.duplicateValue(c),
      resize: (c) => this.resizeValue(c),
    });
    model.subscribe(() => this.setDirty(true));
    index ??= this.cards.length;
    this.cards.splice(index, 0, card);
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
      const r = await ask("Remove value", `Remove “${m.name}” together with its fields and compare rows?`,
        [{ id: "cancel", label: "Cancel" }, { id: "yes", label: "Remove", cls: "danger-btn" }]);
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

  /** Asks for a bit width. Resolves to null when cancelled. */
  private pickWidth(title: string, current: number, okLabel: string): Promise<number | null> {
    const presets = [8, 16, 32, 64, 128, 256, 512];
    return modal<number | null>({
      title,
      icon: Ruler,
      cancelValue: null,
      build: (body, close) => {
        const input = h("input", { class: "field mono width-input", type: "number", min: MIN_WIDTH, max: MAX_WIDTH,
          step: 1, value: String(current), spellcheck: false });
        const err = h("div", { class: "width-error" });
        const seg = segmented(presets.map((p) => ({ value: p, label: String(p) })), {
          value: presets.includes(current) ? current : undefined,
          onPick: (p) => {
            input.value = String(p);
            validate();
            input.focus();
          },
          cls: "width-presets",
        });
        const ok = button({ label: okLabel, cls: "primary", onClick: () => submit() });
        const parse = () => (/^\s*\d+\s*$/.test(input.value) ? Number(input.value) : NaN);
        const validate = () => {
          const n = parse();
          const valid = Number.isInteger(n) && n >= MIN_WIDTH && n <= MAX_WIDTH;
          ok.disabled = !valid;
          input.classList.toggle("invalid", !valid && input.value !== "");
          err.textContent = valid || input.value === "" ? "" : `Enter a whole number from ${MIN_WIDTH} to ${MAX_WIDTH}`;
          seg.set(presets.includes(n) ? n : (undefined as unknown as number));
          return valid;
        };
        const submit = () => {
          if (validate()) {
            localStorage.setItem("bitviewer.lastWidth", String(parse()));
            close(parse());
          }
        };
        input.addEventListener("input", validate);
        input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
        body.append(
          h("label", { class: "modal-label" }, `Number of bits (${MIN_WIDTH}–${MAX_WIDTH})`),
          h("div", { class: "width-row" }, input, h("span", { class: "muted" }, "bits")),
          err,
          h("div", { class: "modal-label presets-label" }, "Presets"),
          seg.el);
        validate();
        return [button({ label: "Cancel", onClick: () => close(null) }), ok];
      },
    });
  }

  private async addCustom() {
    const last = Number(localStorage.getItem("bitviewer.lastWidth")) || 16;
    const width = await this.pickWidth("Add value", last, "Add value");
    if (width !== null) this.addValue(width);
  }

  private async resizeValue(card: ValueCard) {
    const m = card.model;
    const width = await this.pickWidth(`Change width of “${m.name}”`, m.width, "Change width");
    if (width === null || width === m.width) return;
    const lost = m.lostOnResize(width);
    if (lost.groups.length) {
      // named fields are only ever removed by the user, never by a resize
      const names = lost.groups.map((g) => `“${g.name}” ${g.label()}`).join(", ");
      await ask("Fields don't fit", `${names} ${lost.groups.length > 1 ? "don't" : "doesn't"} fit in ${width} bits. ` +
        `Remove ${lost.groups.length > 1 ? "those fields" : "that field"} first, or use at least ${m.minWidthForGroups} bits.`,
        [{ id: "ok", label: "OK", cls: "primary" }], "ok");
      return;
    }
    if (lost.compares || width < m.width) {
      const parts = [`bits above ${width - 1} are cleared`];
      if (lost.compares) parts.push(`${lost.compares} compare row${lost.compares > 1 ? "s" : ""} no longer fit and will be removed`);
      const r = await ask("Change width", `Shrinking to ${width} bits: ${parts.join(", and ")}.`,
        [{ id: "cancel", label: "Cancel" }, { id: "yes", label: "Change width", cls: "danger-btn" }]);
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
      if (!data || typeof data !== "object" || data.app !== "bitviewer") throw new ModelError("This is not a Bit Viewer workspace file");
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

  // ================================================================ shortcuts
  private installShortcuts() {
    window.addEventListener("wheel", (e) => {
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
    }, { passive: false });

    document.addEventListener("keydown", (e) => {
      if (modalOpen() || menusOpen()) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const run = (f: () => void) => {
        e.preventDefault();
        f();
      };
      if (mod && !e.altKey) {
        if (k === "1") return run(() => this.addValue(32));
        if (k === "2") return run(() => this.addValue(64));
        if (k === "3") return run(() => this.addCustom());
        if (k === "g") return run(() => this.groupSelection());
        if (k === "=" || k === "+") return run(() => this.zoomBy(1));
        if (k === "-") return run(() => this.zoomBy(-1));
        if (k === "0") return run(() => S.set("zoom", 1));
        if (k === "t") return run(() => this.toggleTheme());
        if (k === ",") return run(() => this.openSettings());
        if (k === "n") return run(() => this.newWorkspace());
        if (k === "o") return run(() => this.openFile());
        if (k === "s") return run(() => (e.shiftKey ? this.saveAs() : this.save()));
        if (k === "r" || k === "p" || k === "f") return run(() => undefined); // no browser reload/print/find
      }
      if (e.key === "F1") return run(() => this.showControls());
      if (e.key === "F5") return run(() => undefined);
      if (e.key === "Escape" && !(document.activeElement instanceof HTMLInputElement)) this.clearSelections();
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

  // ================================================================ help
  private showControls() {
    const kbd = (...keys: string[]) => h("span", { class: "keys" }, ...keys.map((k) => h("kbd", {}, k)));
    const sc: [string, HTMLElement][] = [
      ["Add 32 / 64-bit value", h("span", {}, kbd("Ctrl", "1"), " / ", kbd("Ctrl", "2"))],
      ["Add value with custom width", kbd("Ctrl", "3")],
      ["Group selection", kbd("Ctrl", "G")],
      ["Clear selection", kbd("Esc")],
      ["Zoom", h("span", {}, kbd("Ctrl", "wheel"), " ", kbd("Ctrl", "="), " ", kbd("Ctrl", "-"), " ", kbd("Ctrl", "0"))],
      ["Toggle theme", kbd("Ctrl", "T")],
      ["Settings", kbd("Ctrl", ",")],
      ["New / Open", h("span", {}, kbd("Ctrl", "N"), " ", kbd("Ctrl", "O"))],
      ["Save / Save as", h("span", {}, kbd("Ctrl", "S"), " ", kbd("Ctrl", "Shift", "S"))],
    ];
    modal<void>({
      title: "Controls",
      icon: CircleQuestionMark,
      wide: true,
      cancelValue: undefined,
      build: (body, close) => {
        body.append(
          h("div", { class: "help" },
            h("h4", {}, "Bits"),
            h("p", {}, "Click a bit to flip it · drag across bits (also across rows) to select · Shift+click to extend · click a row label to select the row, Shift+click another to select consecutive rows · right-click a bit for row actions."),
            h("h4", {}, "Values"),
            h("p", {}, "Type into any field in its selected base. Prefixes 0x / 0b / 0o override the base (in HEX, 0b… is read as hex). Spaces and _ are ignored. The whole-value field accepts negative decimals (stored as two's complement). Invalid input turns red; Esc reverts."),
            h("h4", {}, "Fields & compare rows"),
            h("p", {}, "Select bits, then “Group selection” or Ctrl+G. Fields may span rows but cannot overlap. Compare rows hold an independent value, inherit the parent's fields, and outline bits that differ."),
            h("h4", {}, "Shortcuts"),
            h("div", { class: "shortcuts" }, ...sc.flatMap(([a, b]) => [h("span", {}, a), b]))));
        return [button({ label: "Got it", cls: "primary", onClick: () => close() })];
      },
    });
  }

  private showAbout() {
    modal<void>({
      title: "About",
      icon: Info,
      cancelValue: undefined,
      build: (body, close) => {
        body.append(h("div", { class: "about" }, logoSvg(64),
          h("div", {}, h("h3", {}, "Bit Viewer"), h("p", { class: "muted" }, `Version ${VERSION}`),
            h("p", {}, "Inspect and edit 32/64-bit values bit by bit."))));
        return [button({ label: "Close", cls: "primary", onClick: () => close() })];
      },
    });
  }
}
