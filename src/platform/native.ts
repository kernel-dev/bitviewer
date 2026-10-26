// Thin bridge to Tauri. Every function also works in a plain browser
// (npm run dev) so the UI can be developed without the native shell.

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const FILTERS = [
  { name: "Bit Viewer workspace", extensions: ["bitview", "json"] },
  { name: "All files", extensions: ["*"] },
];

/** What the open dialog asks for. */
export interface OpenOptions {
  title: string;
  filters: { name: string; extensions: string[] }[];
  /** File types for the browser's file picker, e.g. ".svd,.xml". */
  accept: string;
}

const WORKSPACE_OPEN: OpenOptions = {
  title: "Open workspace",
  filters: FILTERS,
  accept: ".bitview,.json",
};

export const SVD_OPEN: OpenOptions = {
  title: "Import CMSIS-SVD",
  filters: [
    { name: "CMSIS-SVD register description", extensions: ["svd", "xml"] },
    { name: "All files", extensions: ["*"] },
  ],
  accept: ".svd,.xml",
};

async function loadCoreApi() {
  return import("@tauri-apps/api/core");
}
async function currentWindow() {
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

export function joinPath(directory: string, name: string): string {
  if (/[\\/]$/.test(directory)) return directory + name;
  const separator =
    directory.includes("\\") || !directory.includes("/") ? "\\" : "/";
  return `${directory}${separator}${name}`;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function pickAndRead(
  startDir?: string,
  options: OpenOptions = WORKSPACE_OPEN,
): Promise<OpenedFile | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      title: options.title,
      filters: options.filters,
      defaultPath: startDir,
      multiple: false,
    });
    if (typeof path !== "string") return null;
    return { path, name: basename(path), text: await readText(path) };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = options.accept;
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(
        file ? { path: null, name: file.name, text: await file.text() } : null,
      );
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function readText(path: string): Promise<string> {
  const { invoke } = await loadCoreApi();
  return invoke<string>("read_text", { path });
}

/** Asks for a path (Tauri) and returns it, or null when cancelled. */
export async function pickSavePath(
  defaultPath: string,
): Promise<string | null> {
  if (!isTauri) return defaultPath;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ title: "Save workspace", defaultPath, filters: FILTERS });
}

export async function writeText(path: string, text: string): Promise<void> {
  if (isTauri) {
    const { invoke } = await loadCoreApi();
    await invoke("write_text", { path, contents: text });
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  anchor.download = basename(path);
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

/** File passed on the command line (`BitViewer.exe workspace.bitview.json`). */
export async function initialFile(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await loadCoreApi();
  return invoke<string | null>("initial_file");
}

export async function setZoom(zoom: number): Promise<void> {
  if (isTauri) {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(zoom);
  } else {
    (document.documentElement.style as any).zoom = String(zoom);
  }
}

export async function setTitle(title: string): Promise<void> {
  document.title = title;
  if (isTauri) await (await currentWindow()).setTitle(title);
}

export async function minimize() {
  if (isTauri) await (await currentWindow()).minimize();
}
export async function toggleMaximize() {
  if (isTauri) await (await currentWindow()).toggleMaximize();
}
export async function isMaximized(): Promise<boolean> {
  return isTauri ? (await currentWindow()).isMaximized() : false;
}
export async function onResized(callback: () => void) {
  if (isTauri) await (await currentWindow()).onResized(callback);
}
/** Close button / Alt+F4. `canClose` decides; returning false keeps the window open.
 *  In the browser preview a page can't wait for a dialog, so `onUnload` runs
 *  instead (the session auto-save keeps the work). */
export async function guardClose(
  canClose: () => Promise<boolean>,
  onUnload: () => void,
) {
  if (!isTauri) {
    window.addEventListener("pagehide", onUnload);
    return;
  }
  const appWindow = await currentWindow();
  await appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    if (await canClose()) await appWindow.destroy();
  });
}
export async function closeWindow() {
  if (isTauri) await (await currentWindow()).close();
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

// ------------------------------------------------------------------ app files
// Small files in the app's own folders: "config" for settings, "data" for the
// session / autosave. In the browser they live in localStorage instead.
export type AppDir = "config" | "data";

export async function readAppFile(
  appDirectory: AppDir,
  name: string,
): Promise<string | null> {
  if (!isTauri)
    return localStorage.getItem(`bitviewer.app.${appDirectory}.${name}`);
  const { invoke } = await loadCoreApi();
  return invoke<string | null>("read_app_file", {
    directory: appDirectory,
    name,
  });
}

export async function writeAppFile(
  appDirectory: AppDir,
  name: string,
  contents: string,
): Promise<void> {
  if (!isTauri) {
    localStorage.setItem(`bitviewer.app.${appDirectory}.${name}`, contents);
    return;
  }
  const { invoke } = await loadCoreApi();
  await invoke("write_app_file", { directory: appDirectory, name, contents });
}

export async function deleteAppFile(
  appDirectory: AppDir,
  name: string,
): Promise<void> {
  if (!isTauri) {
    localStorage.removeItem(`bitviewer.app.${appDirectory}.${name}`);
    return;
  }
  const { invoke } = await loadCoreApi();
  await invoke("delete_app_file", { directory: appDirectory, name });
}

/** A workspace handed over by a second launch (double-clicking another file). */
export async function onOpenFile(callback: (path: string) => void) {
  if (!isTauri) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string>("open-file", (event) => callback(event.payload));
}

// ------------------------------------------------------------------ file drops
/** Calls `hover(true/false)` while files are dragged over the window and
 *  `drop(file)` with the first dropped file, or `failed` when it can't be read
 *  (a folder, a file that is too large, no permission…). */
export async function onFileDrop(
  hover: (over: boolean) => void,
  drop: (file: OpenedFile) => void,
  failed: (name: string, error: unknown) => void,
) {
  if (isTauri) {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().onDragDropEvent(async (event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") hover(true);
      else if (payload.type === "leave") hover(false);
      else if (payload.type === "drop") {
        hover(false);
        const path = payload.paths[0];
        if (!path) return;
        let text: string;
        try {
          text = await readText(path);
        } catch (error) {
          failed(basename(path), error);
          return;
        }
        drop({ path, name: basename(path), text });
      }
    });
    return;
  }
  window.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
      hover(true);
    }
  });
  window.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget) hover(false);
  });
  window.addEventListener("drop", async (event) => {
    event.preventDefault();
    hover(false);
    const file = event.dataTransfer?.files[0];
    if (!file) return;
    try {
      drop({ path: null, name: file.name, text: await file.text() });
    } catch (error) {
      failed(file.name, error);
    }
  });
}
