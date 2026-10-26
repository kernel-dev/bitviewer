// View settings that act on the whole window: theme, compact mode, accent,
// zoom, sounds and the base of every row.

import { BASE_NAMES, type Base } from "../core/format/integers";
import { appSettings, ZOOM_STEP } from "../platform/settings";
import { applyAccent } from "../ui/accent";
import { toast } from "../ui/kit";
import { play } from "../ui/sound";
import type { Workspace } from "./workspace/workspace";

/** Applies the theme, compact mode and accent colour from the settings. */
export function applyTheme() {
  document.documentElement.dataset.theme = appSettings.get("theme");
  document.body.classList.toggle("compact", appSettings.get("compact"));
  applyAccent(
    appSettings.get("accent"),
    appSettings.get("theme") === "contrast",
  );
}

/** Ctrl+T switches dark ↔ light; high contrast is chosen in Settings. */
export function toggleTheme() {
  appSettings.set(
    "theme",
    appSettings.get("theme") === "dark" ? "light" : "dark",
  );
}

export function toggleSounds() {
  const enabled = !appSettings.get("sounds");
  appSettings.set("sounds", enabled);
  if (enabled) play("bitOn");
  toast(enabled ? "Sounds on" : "Sounds off");
}

export function zoomBy(steps: number) {
  appSettings.set("zoom", appSettings.get("zoom") + steps * ZOOM_STEP);
}

/** Switches every row of every value to `base`, and makes it the default. */
export function applyGlobalBase(workspace: Workspace, base: Base) {
  for (const card of workspace.cards) card.model.setAllRowBases(base);
  appSettings.set("default_base", base);
  toast(`All rows now use ${BASE_NAMES[base]}`);
}
