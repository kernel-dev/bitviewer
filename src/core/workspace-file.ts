// Workspace files (.bitview): `{ app: "bitviewer", version, values, peripherals }`.
// Reading checks everything first, so a broken file never half-replaces the
// open workspace.

import { ModelError, valueFromJSON } from "./model";
import { peripheralsFromJSON } from "./workspace";

/** The format version this app writes. Newer files open after a warning. */
export const FILE_VERSION = 1;

export interface WorkspaceFile {
  version: number;
  values: unknown[];
  peripherals: unknown;
}

/** Reads and validates a workspace file. Throws (ModelError, or SyntaxError
 *  for text that isn't JSON) when it can't be opened. */
export function parseWorkspaceFile(text: string): WorkspaceFile {
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || data.app !== "bitviewer")
    throw new ModelError("This is not a Bit Viewer workspace file");
  const version = Number(data.version ?? 1);
  if (!Number.isInteger(version) || version < 1)
    throw new ModelError(`Unknown file format version ${data.version}`);
  const values = data.values ?? [];
  if (!Array.isArray(values))
    throw new ModelError("The file's values aren't a list");
  for (const serialized of values) valueFromJSON(serialized);
  peripheralsFromJSON(data.peripherals);
  return { version, values, peripherals: data.peripherals };
}

/** The text of a workspace file. */
export function workspaceFileText(workspace: {
  values: unknown[];
  peripherals: unknown[];
}): string {
  return JSON.stringify(
    { app: "bitviewer", version: FILE_VERSION, ...workspace },
    null,
    2,
  );
}
