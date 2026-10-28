// Auto-save of the open workspace to the app's data folder, so a crash or an
// unexpected restart brings everything back, including unsaved changes.
import { deleteAppFile, readAppFile, writeAppFile } from "./native";

const FILE = "session.json";
const DELAY_MS = 1000;

/** The session as read back. */
export interface Session {
  version: 1;
  path: string | null; // workspace file, if it was saved or opened
  fileName: string;
  dirty: boolean; // unsaved changes at the time of writing
  values: unknown[] | null; // workspace contents; null = reopen `path` from disk
  peripherals?: unknown[] | null; // peripheral blocks of those values
  savedAt: number;
}

/** The session to write. The values come as their JSON texts, the same
 *  strings undo holds, so writing one makes no copy of each value. */
export interface SessionState {
  path: string | null;
  fileName: string;
  dirty: boolean;
  /** null when `path` holds everything (saved, no changes since). */
  valueTexts: readonly string[] | null;
  /** The peripherals as JSON text. */
  peripheralsText: string;
}

export async function loadSession(): Promise<Session | null> {
  try {
    const text = await readAppFile("data", FILE);
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (parsed?.version !== 1) return null;
    return {
      version: 1,
      path: typeof parsed.path === "string" ? parsed.path : null,
      fileName:
        typeof parsed.fileName === "string" ? parsed.fileName : "Untitled",
      dirty: parsed.dirty === true,
      values: Array.isArray(parsed.values) ? parsed.values : null,
      peripherals: Array.isArray(parsed.peripherals)
        ? parsed.peripherals
        : null,
      savedAt: Number(parsed.savedAt) || 0,
    };
  } catch {
    return null; // a damaged session file just means starting fresh
  }
}

/** The session file's text, put together from the ready-made value texts. */
export function sessionText(state: SessionState, savedAt = Date.now()): string {
  const head = JSON.stringify({
    version: 1,
    path: state.path,
    fileName: state.fileName,
    dirty: state.dirty,
    savedAt,
  });
  const values = state.valueTexts ? `[${state.valueTexts.join(",")}]` : "null";
  const peripherals = state.valueTexts ? state.peripheralsText : "null";
  return `${head.slice(0, -1)},"values":${values},"peripherals":${peripherals}}`;
}

let timer = 0;
let latest: (() => SessionState) | null = null;

/** Writes the session a moment after the last change. */
export function saveSessionSoon(get: () => SessionState) {
  latest = get;
  clearTimeout(timer);

  timer = window.setTimeout(() => {
    timer = 0;
    void writeSession(get());
  }, DELAY_MS);
}

/** Writes now (on save, open, close). A pending delayed write is replaced. */
export async function saveSessionNow(state?: SessionState): Promise<void> {
  clearTimeout(timer);
  timer = 0;
  const data = state ?? latest?.();
  if (data) await writeSession(data);
}

export async function clearSession(): Promise<void> {
  clearTimeout(timer);
  timer = 0;
  await deleteAppFile("data", FILE).catch(() => {});
}

async function writeSession(state: SessionState) {
  try {
    await writeAppFile("data", FILE, sessionText(state));
  } catch {
    /* best effort: auto-save must never interrupt work */
  }
}
