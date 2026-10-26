// Undo / redo over whole-workspace snapshots (JSON strings). Snapshots are
// small, and restoring one rebuilds the workspace, so every kind of change —
// bits, fields, compare rows, widths, adding or moving values — is covered
// without per-action undo code.

const LIMIT = 200; // undo steps kept
const TYPING_MERGE_MS = 1500; // keystrokes in one field within this window are one step

export class History {
  private past: string[] = [];
  private future: string[] = [];
  private current = "";
  private timer = 0;
  private holds = 0;
  private restoring = false;
  private lastInput: Element | null = null;
  private lastTime = 0;
  /** The text field the pending change came from (null = not typing). */
  private pendingSrc: HTMLInputElement | null = null;

  constructor(
    private take: () => string,
    private apply: (snapshot: string) => void,
    private changed: () => void,
  ) {}

  /** Forget all history; the current state becomes the baseline. */
  reset() {
    clearTimeout(this.timer);
    this.timer = 0;
    this.past = [];
    this.future = [];
    this.current = this.take();
    this.lastInput = null;
    this.changed();
  }

  get snapshot(): string {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0 || this.timer !== 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Call after any change; the step is recorded once the current event finishes. */
  touch() {
    if (this.restoring) return;
    // Where the change came from is decided now, not when it's recorded. (The
    // app also flushes before each new input/pointer event, so a pending step
    // never absorbs the start of a different kind of edit.)
    const active = document.activeElement;
    const source = active instanceof HTMLInputElement ? active : null;
    if (this.timer) return;
    this.pendingSrc = source;

    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.capture();
    }, 0);
  }

  /** Group everything until `release()` into one step (e.g. a paint stroke). */
  hold() {
    this.holds++;
  }

  release() {
    if (this.holds > 0 && --this.holds === 0) this.touch();
  }

  undo(): boolean {
    this.flush();
    const previous = this.past.pop();
    if (previous === undefined) return false;
    this.future.push(this.current);
    this.restore(previous);
    return true;
  }

  redo(): boolean {
    this.flush();
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(this.current);
    this.restore(next);
    return true;
  }

  /** Record a pending change right away. */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
      this.capture();
    }
  }

  private capture() {
    if (this.holds) return;
    const snapshot = this.take();
    if (snapshot === this.current) return;
    const typing = this.pendingSrc;
    const now = performance.now();
    const merge =
      typing !== null &&
      typing === this.lastInput &&
      now - this.lastTime < TYPING_MERGE_MS;

    if (!merge) {
      this.past.push(this.current);
      if (this.past.length > LIMIT) this.past.shift();
    }

    this.current = snapshot;
    this.future = [];
    this.lastInput = typing;
    this.lastTime = now;
    this.changed();
  }

  private restore(snapshot: string) {
    this.current = snapshot;
    this.restoring = true;

    try {
      this.apply(snapshot);
    } finally {
      this.restoring = false;
      this.lastInput = null;
    }

    this.changed();
  }
}
