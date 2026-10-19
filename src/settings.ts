// Persisted app settings (stored in the webview's localStorage).
import type { View } from "./model";
import { BASE_ORDER, type Base } from "./numfmt";

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3.0;
export const ZOOM_STEP = 0.1;

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
};

const KEY = "bitviewer.settings";
type Listener = (key: keyof Settings) => void;

export function clampZoom(z: number): number {
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100;
}

class Store {
  private v: Settings = { ...DEFAULTS };
  private listeners: Listener[] = [];

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
        if (raw[k] !== undefined && typeof raw[k] === typeof DEFAULTS[k]) (this.v as any)[k] = raw[k];
      }
    } catch {
      /* unreadable storage: keep defaults */
    }
    this.v.zoom = clampZoom(this.v.zoom);
    if (!["dark", "light"].includes(this.v.theme)) this.v.theme = "dark";
    if (!BASE_ORDER.includes(this.v.default_base)) this.v.default_base = 16;
    if (!["line", "byte", "nibble"].includes(this.v.default_view)) this.v.default_view = "line";
    this.v.sound_volume = Math.min(1, Math.max(0, this.v.sound_volume));
  }

  get<K extends keyof Settings>(k: K): Settings[K] {
    return this.v[k];
  }

  set<K extends keyof Settings>(k: K, value: Settings[K]): void {
    if (k === "zoom") value = clampZoom(value as number) as Settings[K];
    if (this.v[k] === value) return;
    this.v[k] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.v));
    } catch {
      /* storage unavailable: setting lasts for this session */
    }
    for (const l of [...this.listeners]) l(k);
  }

  onChange(l: Listener): () => void {
    this.listeners.push(l);
    return () => (this.listeners = this.listeners.filter((x) => x !== l));
  }
}

export const S = new Store();
