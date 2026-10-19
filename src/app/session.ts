// Auto-save of the open workspace to the app's data folder, so a crash or an
// unexpected restart brings everything back, including unsaved changes.
import { deleteAppFile, readAppFile, writeAppFile } from "./platform";

const FILE = "session.json";
const DELAY_MS = 1000;

export interface Session {
  version: 1;
  path: string | null; // workspace file, if it was saved or opened
  fileName: string;
  dirty: boolean; // unsaved changes at the time of writing
  values: unknown[] | null; // workspace contents; null = reopen `path` from disk
  savedAt: number;
}

export async function loadSession(): Promise<Session | null> {
  try {
    const text = await readAppFile("data", FILE);
    if (!text) return null;
    const s = JSON.parse(text);
    if (s?.version !== 1) return null;
    return {
      version: 1,
      path: typeof s.path === "string" ? s.path : null,
      fileName: typeof s.fileName === "string" ? s.fileName : "Untitled",
      dirty: s.dirty === true,
      values: Array.isArray(s.values) ? s.values : null,
      savedAt: Number(s.savedAt) || 0,
    };
  } catch {
    return null; // a damaged session file just means starting fresh
  }
}

let timer = 0;
let latest: (() => Session) | null = null;

/** Writes the session a moment after the last change. */
export function saveSessionSoon(get: () => Session) {
  latest = get;
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    void writeSession(get());
  }, DELAY_MS);
}

/** Writes now (on save, open, close). A pending delayed write is replaced. */
export async function saveSessionNow(s?: Session): Promise<void> {
  clearTimeout(timer);
  timer = 0;
  const data = s ?? latest?.();
  if (data) await writeSession(data);
}

export async function clearSession(): Promise<void> {
  clearTimeout(timer);
  timer = 0;
  await deleteAppFile("data", FILE).catch(() => {});
}

async function writeSession(s: Session) {
  try {
    await writeAppFile("data", FILE, JSON.stringify(s));
  } catch {
    /* best effort: auto-save must never interrupt work */
  }
}
