// Thin bridge to Tauri. Every function also works in a plain browser
// (npm run dev) so the UI can be developed without the native shell.

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const FILTERS = [
  { name: "Bit Viewer workspace", extensions: ["bitview.json", "json"] },
  { name: "All files", extensions: ["*"] },
];

async function core() {
  return import("@tauri-apps/api/core");
}
async function win() {
  return (await import("@tauri-apps/api/window")).getCurrentWindow();
}

export interface OpenedFile {
  path: string | null; // null in the browser
  name: string;
  text: string;
}

/** Folder the file dialogs start in when nothing was opened or saved yet.
 *  Without it a bare file name resolves against the app's working folder,
 *  which under `tauri dev` is src-tauri — saving there restarts the dev app. */
export async function defaultDir(): Promise<string | undefined> {
  if (!isTauri) return undefined;
  try {
    const { documentDir } = await import("@tauri-apps/api/path");
    return await documentDir();
  } catch {
    return undefined;
  }
}

export function joinPath(dir: string, name: string): string {
  if (/[\\/]$/.test(dir)) return dir + name;
  const sep = dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
  return `${dir}${sep}${name}`;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function pickAndRead(startDir?: string): Promise<OpenedFile | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ title: "Open workspace", filters: FILTERS, defaultPath: startDir, multiple: false });
    if (typeof path !== "string") return null;
    return { path, name: basename(path), text: await readText(path) };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { path: null, name: f.name, text: await f.text() } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function readText(path: string): Promise<string> {
  const { invoke } = await core();
  return invoke<string>("read_text", { path });
}

/** Asks for a path (Tauri) and returns it, or null when cancelled. */
export async function pickSavePath(defaultPath: string): Promise<string | null> {
  if (!isTauri) return defaultPath;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ title: "Save workspace", defaultPath, filters: FILTERS });
}

export async function writeText(path: string, text: string): Promise<void> {
  if (isTauri) {
    const { invoke } = await core();
    await invoke("write_text", { path, contents: text });
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = basename(path);
  a.click();
  URL.revokeObjectURL(a.href);
}

/** File passed on the command line (`BitViewer.exe workspace.bitview.json`). */
export async function initialFile(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await core();
  return invoke<string | null>("initial_file");
}

export async function setZoom(z: number): Promise<void> {
  if (isTauri) {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(z);
  } else {
    (document.documentElement.style as any).zoom = String(z);
  }
}

export async function setTitle(title: string): Promise<void> {
  document.title = title;
  if (isTauri) await (await win()).setTitle(title);
}

export async function minimize() {
  if (isTauri) await (await win()).minimize();
}
export async function toggleMaximize() {
  if (isTauri) await (await win()).toggleMaximize();
}
export async function isMaximized(): Promise<boolean> {
  return isTauri ? (await win()).isMaximized() : false;
}
export async function onResized(cb: () => void) {
  if (isTauri) await (await win()).onResized(cb);
}
/** Close button / Alt+F4. `canClose` decides; returning false keeps the window open. */
export async function guardClose(canClose: () => Promise<boolean>) {
  if (!isTauri) {
    window.addEventListener("beforeunload", (e) => e.preventDefault());
    return;
  }
  const w = await win();
  await w.onCloseRequested(async (event) => {
    event.preventDefault();
    if (await canClose()) await w.destroy();
  });
}
export async function closeWindow() {
  if (isTauri) await (await win()).close();
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
