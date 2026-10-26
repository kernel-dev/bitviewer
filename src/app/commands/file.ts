// File menu: new, open, save, import SVD, quit.

import { Cpu, FilePlus, FolderOpen, LogOut, Save, SaveAll } from "lucide";
import * as P from "../../platform/native";
import type { App } from "../app";
import { importSvd } from "../workspace/svd-import";
import type { Command } from "./registry";

export function fileCommands(app: App): Command[] {
  const file = app.document;
  return [
    {
      id: "file.new",
      group: "File",
      label: "New workspace",
      icon: FilePlus,
      keys: ["Ctrl+N"],
      run: () => file.newWorkspace(),
    },
    {
      id: "file.open",
      group: "File",
      label: "Open…",
      icon: FolderOpen,
      keys: ["Ctrl+O"],
      run: () => file.openFile(),
    },
    {
      id: "file.save",
      group: "File",
      label: "Save",
      icon: Save,
      keys: ["Ctrl+S"],
      run: () => file.save(),
    },
    {
      id: "file.saveAs",
      group: "File",
      label: "Save as…",
      icon: SaveAll,
      keys: ["Ctrl+Shift+S"],
      run: () => file.saveAs(),
    },
    {
      id: "file.importSvd",
      group: "File",
      label: "Import CMSIS-SVD…",
      icon: Cpu,
      keywords:
        "svd cmsis register description peripheral arm stm32 nrf import",
      run: () => importSvd(app),
    },
    {
      id: "file.quit",
      group: "File",
      label: "Quit",
      icon: LogOut,
      run: () => P.closeWindow(),
    },
  ];
}
