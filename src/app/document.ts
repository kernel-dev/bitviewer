// The open workspace as a document: its file name and path, whether it has
// unsaved changes, opening, saving, recent files, dropped files, and the
// auto-saved session that brings everything back after a restart.

import { FolderClock, FolderOpen } from "lucide";
import {
  FILE_VERSION,
  parseWorkspaceFile,
  workspaceFileText,
} from "../core/workspace-file";
import * as P from "../platform/native";
import { loadSession, type Session, saveSessionNow } from "../platform/session";
import { appSettings } from "../platform/settings";
import { ask, html, icon, type MenuItem, toast } from "../ui/kit";
import type { App } from "./app";
import { importSvd } from "./workspace/svd-import";

const UNTITLED = "Untitled";

/** A dropped file that is a CMSIS-SVD description rather than a workspace. */
const looksLikeSvd = (file: { name: string; text: string }) =>
  /\.(svd|xml)$/i.test(file.name) || file.text.trimStart().startsWith("<");

/** Shows an error message: what failed, where, and why. */
export function showError(title: string, error: unknown, where = "") {
  const message = error instanceof Error ? error.message : String(error);
  ask(
    title,
    where ? `${where}\n\n${message}` : message,
    [{ id: "ok", label: "OK", className: "primary" }],
    "ok",
  );
}

/** Remembers the folder of `path` for the next open / save dialog. */
export function rememberDir(path: string) {
  const separatorIndex = Math.max(
    path.lastIndexOf("\\"),
    path.lastIndexOf("/"),
  );

  if (separatorIndex > 0)
    appSettings.set("last_dir", path.slice(0, separatorIndex));
}

export class WorkspaceDocument {
  private path: string | null = null;
  private fileName = UNTITLED;
  /** Snapshot of the workspace as last saved/opened; null = never saved. */
  private savedSnapshot: string | null = null;

  constructor(private app: App) {}

  get dirty(): boolean {
    return this.app.history.snapshot !== this.savedSnapshot;
  }

  /** Marks the current state as the saved one. */
  private markSaved() {
    this.app.history.flush();
    this.savedSnapshot = this.app.history.snapshot;
    this.updateTitle();
  }

  updateTitle() {
    const dirtyMark = this.dirty ? " •" : "";
    this.app.titlebar.setFile(`${this.fileName}${dirtyMark}`);
    P.setTitle(`${this.fileName}${dirtyMark} — Bit Viewer`);
  }

  /** Resolves true when it is fine to discard the current workspace. */
  async maybeSave(): Promise<boolean> {
    this.app.history.flush();
    if (!this.dirty || !this.app.workspace.cards.length) return true;
    const answer = await ask(
      "Unsaved changes",
      `Save changes to “${this.fileName}”?`,
      [
        { id: "cancel", label: "Cancel" },
        { id: "discard", label: "Don't save", className: "outline" },
        { id: "save", label: "Save", className: "primary" },
      ],
    );
    if (answer === "save") return this.save();
    return answer === "discard";
  }

  // ================================================================ new / open
  /** A new untitled workspace with one 32-bit value. */
  startFresh() {
    this.app.workspace.clear();
    this.path = null;
    this.fileName = UNTITLED;
    this.app.workspace.addValue(32, undefined, undefined, false);
    this.app.history.reset();
    this.markSaved();
  }

  async newWorkspace() {
    if (!(await this.maybeSave())) return;
    this.startFresh();
    void saveSessionNow(this.sessionData());
  }

  async openFile() {
    if (!(await this.maybeSave())) return;
    try {
      const openedFile = await P.pickAndRead(
        appSettings.get("last_dir") || (await P.defaultDir()),
      );

      if (openedFile)
        await this.loadText(openedFile.text, openedFile.path, openedFile.name);
    } catch (error) {
      showError("Could not open file", error);
    }
  }

  /** File › Open recent. */
  recentMenu(): MenuItem {
    const files = P.isTauri ? appSettings.get("recent_files") : [];

    const folder = (path: string) => {
      const directory = path.slice(
        0,
        Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")),
      );
      return directory.length > 38 ? `…${directory.slice(-37)}` : directory;
    };

    return {
      label: "Open recent",
      icon: FolderClock,
      disabled: !files.length,
      submenu: [
        ...files.map(
          (path): MenuItem => ({
            label: P.basename(path),
            shortcut: folder(path),
            action: () => this.openRecent(path),
          }),
        ),
        "sep",
        {
          label: "Clear list",
          action: () => appSettings.set("recent_files", []),
        },
      ],
    };
  }

  private async openRecent(path: string) {
    if (!(await this.maybeSave())) return;
    if (!(await this.loadPath(path))) appSettings.removeRecent(path);
  }

  /** Dropping a file on the window opens it (an SVD file is imported instead). */
  installFileDrop() {
    const overlay = html(
      "div",
      { class: "drop-overlay" },
      html(
        "div",
        { class: "drop-card" },
        icon(FolderOpen, 28),
        html("b", {}, "Drop to open the workspace"),
      ),
    );
    document.body.append(overlay);

    void P.onFileDrop(
      (over) => overlay.classList.toggle("show", over),
      async (openedFile) => {
        // an SVD adds values to the workspace; anything else replaces it
        if (looksLikeSvd(openedFile)) return importSvd(this.app, openedFile);
        if (!(await this.maybeSave())) return;
        await this.loadText(openedFile.text, openedFile.path, openedFile.name);
      },
      (name, error) => showError("Could not open file", error, name),
    );
  }

  /** Opens a workspace file. `quiet`: no messages (for the session restore). */
  async loadPath(path: string, quiet = false): Promise<boolean> {
    try {
      return await this.loadText(
        await P.readText(path),
        path,
        P.basename(path),
        quiet,
      );
    } catch (error) {
      if (!quiet) showError("Could not open file", error, path);
      return false;
    }
  }

  /** Opens a workspace from its text. Resolves false when it wasn't opened. */
  async loadText(
    text: string,
    path: string | null,
    name: string,
    quiet = false,
  ): Promise<boolean> {
    let file: ReturnType<typeof parseWorkspaceFile>;

    try {
      file = parseWorkspaceFile(text);
    } catch (error) {
      if (!quiet) showError("Could not open file", error, name);
      return false;
    }

    if (file.version > FILE_VERSION && !quiet) {
      const answer = await ask(
        "Saved by a newer version",
        `“${name}” was saved by a newer version of Bit Viewer (file format ${file.version}; this version reads format ${FILE_VERSION}). ` +
          "Anything this version doesn't understand is left out, and is lost if you save over the file. Update Bit Viewer to keep it.",
        [
          { id: "cancel", label: "Cancel" },
          { id: "open", label: "Open anyway", className: "primary" },
        ],
      );
      if (answer !== "open") return false;
    }

    this.loadValues(file.values, path, name, file.peripherals);

    if (path) {
      rememberDir(path);
      appSettings.addRecent(path);
    }

    void saveSessionNow(this.sessionData());
    if (!quiet) toast(`Opened ${name}`, "ok");
    return true;
  }

  /** Replaces the workspace and starts a fresh undo history. */
  private loadValues(
    values: unknown[],
    path: string | null,
    name: string,
    peripherals?: unknown,
  ) {
    this.app.workspace.replace(values, peripherals);
    this.path = path;
    this.fileName = name;
    this.app.history.reset();
    this.markSaved();
    this.app.workspace.element.scrollTop = 0;
  }

  // ================================================================ save
  async save(): Promise<boolean> {
    if (!this.path) return this.saveAs();
    return this.write(this.path);
  }

  async saveAs(): Promise<boolean> {
    const directory = appSettings.get("last_dir") || (await P.defaultDir());
    const start =
      this.path ??
      (directory
        ? P.joinPath(directory, "workspace.bitview")
        : "workspace.bitview");
    let path = await P.pickSavePath(start);
    if (!path) return false;
    if (!/\.(bitview|json)$/i.test(path)) path += ".bitview";
    return this.write(path);
  }

  private async write(path: string): Promise<boolean> {
    this.app.history.flush();

    try {
      await P.writeText(path, workspaceFileText(this.app.workspace.toJSON()));
    } catch (error) {
      showError("Could not save", error, path);
      return false;
    }

    this.path = P.isTauri ? path : null;
    this.fileName = P.basename(path);
    rememberDir(path);
    if (P.isTauri) appSettings.addRecent(path);
    this.markSaved();
    void saveSessionNow(this.sessionData());
    toast(`Saved ${this.fileName}`, "ok");
    return true;
  }

  // ================================================================ session
  /** What the auto-saved session holds. */
  sessionData(): Session {
    return {
      version: 1,
      path: this.path,
      fileName: this.fileName,
      dirty: this.dirty,
      ...this.app.workspace.toJSON(),
      savedAt: Date.now(),
    };
  }

  /** Reopens what was open last time. Returns false when there was nothing to restore. */
  async restoreSession(): Promise<boolean> {
    const session = await loadSession();
    if (!session) return false;

    if (
      !session.dirty &&
      session.path &&
      (await this.loadPath(session.path, true))
    )
      return true;

    if (!session.values) return false;

    try {
      this.loadValues(
        session.values,
        session.path,
        session.fileName,
        session.peripherals,
      );
    } catch {
      return false;
    }

    if (session.dirty) {
      this.savedSnapshot = null; // contents differ from any file on disk
      this.updateTitle();
      toast("Restored unsaved changes from your last session", "ok");
    }

    return true;
  }

  /** Before the app closes (or restarts to install an update): asks about
   *  unsaved changes, then leaves the session and settings on disk. */
  async prepareToQuit(): Promise<boolean> {
    const dirtyBefore = this.dirty;
    if (!(await this.maybeSave())) return false;
    // "Don't save" means the changes are discarded, so don't bring them back next time
    const discarded = dirtyBefore && this.dirty;
    await saveSessionNow({
      ...this.sessionData(),
      dirty: false,
      values: discarded ? null : this.sessionData().values,
    });
    await appSettings.flush();
    return true;
  }
}
