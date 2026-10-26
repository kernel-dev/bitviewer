// Persisted app settings. They live in `settings.json` in the app's config
// folder (localStorage in the browser). Older versions kept them in the
// webview's localStorage; those are migrated on first start.
import type { SavedExportTemplate } from "../core/export/codegen";
import { BASE_ORDER, type Base } from "../core/format/integers";
import type { View } from "../core/model";
import { type Template, validTemplate } from "../core/templates";
import { isTauri, readAppFile, writeAppFile } from "./native";

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3.0;
export const ZOOM_STEP = 0.1;
const MAX_RECENT = 10;

export interface Settings {
  zoom: number;
  theme: "dark" | "light" | "contrast";
  msb_left: boolean; // bit order inside a row: MSB on the left
  show_readouts: boolean; // per-row hex/dec/oct readout
  show_interp: boolean; // signed / float interpretation chips
  default_base: Base; // base for rows of newly added values
  default_view: View; // row layout of newly added values
  sounds: boolean; // interface sounds (off unless the user turns them on)
  sound_volume: number; // 0 … 1
  last_dir: string; // folder of the last opened / saved workspace
  last_width: number; // last custom width picked
  recent_files: string[]; // most recent first
  readout_chips: string[]; // which readout chips show under each value (stats.ts CHIPS ids)
  templates: Template[]; // the user's own field layout templates
  export_templates: SavedExportTemplate[]; // the user's own code export templates
  export_last: string; // id of the export template used last
  compact: boolean; // tighter spacing everywhere
  accent: string; // "#rrggbb", or "" for the theme's red
  tour_done: boolean; // the first-run tour was finished or skipped
  check_updates: boolean; // look for a newer version at start-up
  last_seen_version: string; // app version whose changes were last shown ("" = never)
}

const DEFAULTS: Settings = {
  zoom: 1.0,
  theme: "dark",
  msb_left: true,
  show_readouts: true,
  show_interp: true,
  default_base: 16,
  default_view: "line",
  sounds: false,
  sound_volume: 0.5,
  last_dir: "",
  last_width: 16,
  recent_files: [],
  readout_chips: ["u", "s", "pop", "float"],
  templates: [],
  export_templates: [],
  export_last: "c",
  compact: false,
  accent: "",
  tour_done: false,
  check_updates: true,
  last_seen_version: "",
};

const FILE = "settings.json";
const LEGACY_KEY = "bitviewer.settings";
type Listener = (key: keyof Settings) => void;

export function clampZoom(zoom: number): number {
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) * 100) / 100;
}

function isSavedExport(value: unknown): value is SavedExportTemplate {
  const candidate = value as Record<string, unknown> | null;
  return (
    !!candidate &&
    typeof candidate === "object" &&
    typeof candidate.name === "string" &&
    candidate.name.trim() !== "" &&
    typeof candidate.extension === "string" &&
    typeof candidate.source === "string"
  );
}

/** Copies valid entries of `raw` over `into`, ignoring unknown or mistyped keys. */
function merge(target: Settings, raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const value = record[key];
    const defaultValue = DEFAULTS[key];
    if (value === undefined) continue;
    if (key === "templates") {
      if (Array.isArray(value))
        target.templates = value
          .map(validTemplate)
          .filter((template): template is Template => template !== null);
    } else if (key === "export_templates") {
      if (Array.isArray(value))
        target.export_templates = value.filter(isSavedExport);
    } else if (Array.isArray(defaultValue)) {
      if (
        Array.isArray(value) &&
        value.every((entry) => typeof entry === "string")
      )
        (target as any)[key] = value;
    } else if (typeof value === typeof defaultValue)
      (target as any)[key] = value;
  }
}

function sanitize(settings: Settings) {
  settings.zoom = clampZoom(settings.zoom);
  if (!["dark", "light", "contrast"].includes(settings.theme))
    settings.theme = "dark";
  if (!BASE_ORDER.includes(settings.default_base)) settings.default_base = 16;
  if (!["line", "byte", "nibble"].includes(settings.default_view))
    settings.default_view = "line";
  settings.sound_volume = Math.min(1, Math.max(0, settings.sound_volume));
  if (settings.accent && !/^#[0-9a-f]{6}$/i.test(settings.accent))
    settings.accent = "";
  settings.recent_files = settings.recent_files.slice(0, MAX_RECENT);
}

class Store {
  private settings: Settings = structuredClone(DEFAULTS);
  private listeners: Listener[] = [];
  private writeTimer = 0;
  private pending: Promise<void> | null = null;

  constructor() {
    // Synchronous best guess so anything reading settings before load() works.
    try {
      merge(
        this.settings,
        JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "{}"),
      );
    } catch {
      /* unreadable storage: keep defaults */
    }
    sanitize(this.settings);
  }

  /** Loads settings.json. Call once before the app starts. */
  async load(): Promise<void> {
    try {
      const text = await readAppFile("config", FILE);
      if (text) {
        const loaded = structuredClone(DEFAULTS);
        merge(loaded, JSON.parse(text));
        sanitize(loaded);
        this.settings = loaded;
      } else if (isTauri) {
        await this.write(); // first start with a settings file: migrate localStorage
      }
    } catch {
      /* unreadable file: keep what we have; the next change rewrites it */
    }
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.settings[key];
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (key === "zoom") value = clampZoom(value as number) as Settings[K];
    if (this.settings[key] === value) return;
    this.settings[key] = value;
    this.scheduleWrite();
    for (const listener of [...this.listeners]) listener(key);
  }

  onChange(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(
        (registered) => registered !== listener,
      );
    };
  }

  /** Puts `path` at the top of the recent-files list. */
  addRecent(path: string) {
    const samePath = (candidate: string) =>
      candidate.toLowerCase() === path.toLowerCase();
    this.set(
      "recent_files",
      [
        path,
        ...this.settings.recent_files.filter((path) => !samePath(path)),
      ].slice(0, MAX_RECENT),
    );
  }

  removeRecent(path: string) {
    this.set(
      "recent_files",
      this.settings.recent_files.filter((recentPath) => recentPath !== path),
    );
  }

  /** Writes any pending change now (call before the window closes). */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = 0;
      await this.write();
    }
    await this.pending;
  }

  private scheduleWrite() {
    clearTimeout(this.writeTimer);
    this.writeTimer = window.setTimeout(() => {
      this.writeTimer = 0;
      this.write();
    }, 250);
  }

  private async write(): Promise<void> {
    const text = JSON.stringify(this.settings, null, 2);
    this.pending = writeAppFile("config", FILE, text).catch(() => {
      /* disk full / no permission: the setting still applies for this run */
    });
    try {
      localStorage.setItem(LEGACY_KEY, text); // keeps the browser preview in sync too
    } catch {
      /* ignore */
    }
    await this.pending;
  }
}

export const appSettings = new Store();
