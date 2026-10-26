// Every user-facing action is a command in the registry (registry.ts). Menus,
// shortcuts, the command palette and the help dialog are built from it.

import type { App } from "../app";
import { editCommands } from "./edit";
import { fileCommands } from "./file";
import { helpCommands } from "./help";
import { valueCommands } from "./value";
import { viewCommands } from "./view";

export function registerCommands(app: App) {
  app.commands.add(
    ...fileCommands(app),
    ...editCommands(app),
    ...viewCommands(),
    ...helpCommands(app),
    ...valueCommands(app),
  );
}
