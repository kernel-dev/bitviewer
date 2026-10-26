// View menu: zoom, theme, spacing, sounds and settings.

import {
  Maximize,
  Minimize,
  Moon,
  RotateCcw,
  Settings as SettingsIcon,
  Sun,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide";
import { openSettings } from "../../dialogs/settings";
import { appSettings } from "../../platform/settings";
import { toggleSounds, toggleTheme, zoomBy } from "../view";
import type { Command } from "./registry";

export function viewCommands(): Command[] {
  const dark = () => appSettings.get("theme") === "dark";
  return [
    {
      id: "view.zoomIn",
      group: "View",
      label: "Zoom in",
      icon: ZoomIn,
      keys: ["Ctrl+=", "Ctrl++"],
      run: () => zoomBy(1),
    },
    {
      id: "view.zoomOut",
      group: "View",
      label: "Zoom out",
      icon: ZoomOut,
      keys: ["Ctrl+-"],
      run: () => zoomBy(-1),
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
      run: () => toggleTheme(),
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
      run: () => toggleSounds(),
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
  ];
}
