// Persisted app settings. They live in `settings.json` in the app's config
// folder (localStorage in the browser). Older versions kept them in the
// webview's localStorage; those are migrated on first start.
import type { View } from "./model";
import { BASE_ORDER, type Base } from "./numfmt";
import { isTauri, readAppFile, writeAppFile } from "./platform";

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3.0;
export const ZOOM_STEP = 0.1;
const MAX_RECENT = 10;

export interface Settings {
  zoom: number;
  theme: "dark" | "light";
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
};

const FILE = "settings.json";
const LEGACY_KEY = "bitviewer.settings";
type Listener = (key: keyof Settings) => void;

export function clampZoom(z: number): number {
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100;
}

/** Copies valid entries of `raw` over `into`, ignoring unknown or mistyped keys. */
function merge(into: Settings, raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = r[k];
    const d = DEFAULTS[k];
    if (v === undefined) continue;
    if (Array.isArray(d)) {
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) (into as any)[k] = v;
    } else if (typeof v === typeof d) (into as any)[k] = v;
  }
}

function sanitize(v: Settings) {
  v.zoom = clampZoom(v.zoom);
  if (!["dark", "light"].includes(v.theme)) v.theme = "dark";
  if (!BASE_ORDER.includes(v.default_base)) v.default_base = 16;
  if (!["line", "byte", "nibble"].includes(v.default_view)) v.default_view = "line";
  v.sound_volume = Math.min(1, Math.max(0, v.sound_volume));
  v.recent_files = v.recent_files.slice(0, MAX_RECENT);
}

class Store {
  private v: Settings = structuredClone(DEFAULTS);
  private listeners: Listener[] = [];
  private writeTimer = 0;
  private pending: Promise<void> | null = null;

  constructor() {
    // Synchronous best guess so anything reading settings before load() works.
    try {
      merge(this.v, JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "{}"));
    } catch {
      /* unreadable storage: keep defaults */
    }
    sanitize(this.v);
  }

  /** Loads settings.json. Call once before the app starts. */
  async load(): Promise<void> {
    try {
      const text = await readAppFile("config", FILE);
      if (text) {
        const v = structuredClone(DEFAULTS);
        merge(v, JSON.parse(text));
        sanitize(v);
        this.v = v;
      } else if (isTauri) {
        await this.write(); // first start with a settings file: migrate localStorage
      }
    } catch {
      /* unreadable file: keep what we have; the next change rewrites it */
    }
  }

  get<K extends keyof Settings>(k: K): Settings[K] {
    return this.v[k];
  }

  set<K extends keyof Settings>(k: K, value: Settings[K]): void {
    if (k === "zoom") value = clampZoom(value as number) as Settings[K];
    if (this.v[k] === value) return;
    this.v[k] = value;
    this.scheduleWrite();
    for (const l of [...this.listeners]) l(k);
  }

  onChange(l: Listener): () => void {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  /** Puts `path` at the top of the recent-files list. */
  addRecent(path: string) {
    const same = (p: string) => p.toLowerCase() === path.toLowerCase();
    this.set("recent_files", [path, ...this.v.recent_files.filter((p) => !same(p))].slice(0, MAX_RECENT));
  }

  removeRecent(path: string) {
    this.set(
      "recent_files",
      this.v.recent_files.filter((p) => p !== path),
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
    const text = JSON.stringify(this.v, null, 2);
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

export const S = new Store();
