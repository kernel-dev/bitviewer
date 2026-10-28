// Undo / redo over whole-workspace snapshots. Restoring one rebuilds what
// changed, so every kind of change (bits, fields, compare rows, widths,
// adding or moving values) is covered without per-action undo code.
//
// Snapshots share everything that didn't change (see workspace-snapshot.ts),
// so a step costs about what it changed. History is also kept within a
// memory budget, so steps that change every value of a huge workspace can't
// pile up.

import { valueTextMade } from "../core/model";
import {
  sameSnapshot,
  snapshotCost,
  type WorkspaceSnapshot,
} from "../core/workspace-snapshot";

const LIMIT = 200; // undo steps kept
const BUDGET = 256 * 1024 * 1024; // roughly, bytes of history kept besides the current state
const TYPING_MERGE_MS = 1500; // keystrokes in one field within this window are one step

/** A past or future state, with roughly what it holds beyond its neighbour. */
interface Step {
  snapshot: WorkspaceSnapshot;
  cost: number;
}

export class History {
  private past: Step[] = [];
  private future: Step[] = [];
  private current: WorkspaceSnapshot | null = null;
  /** Value text made up to the current snapshot (see valueTextMade). */
  private textMark = 0;
  private timer = 0;
  private holds = 0;
  private restoring = false;
  private lastInput: Element | null = null;
  private lastTime = 0;
  /** The text field the pending change came from (null = not typing). */
  private pendingSrc: HTMLInputElement | null = null;

  constructor(
    private take: (previous: WorkspaceSnapshot | null) => WorkspaceSnapshot,
    private apply: (snapshot: WorkspaceSnapshot) => void,
    private changed: () => void,
    private budget = BUDGET,
  ) {}

  /** Forget all history; the current state becomes the baseline. */
  reset() {
    clearTimeout(this.timer);
    this.timer = 0;
    this.past = [];
    this.future = [];
    this.current = this.take(null);
    this.textMark = valueTextMade();
    this.lastInput = null;
    this.changed();
  }

  get snapshot(): WorkspaceSnapshot | null {
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
    if (!previous || !this.current) return false;
    this.future.push({ snapshot: this.current, cost: previous.cost });
    this.restore(previous.snapshot);
    return true;
  }

  redo(): boolean {
    this.flush();
    const next = this.future.pop();
    if (!next || !this.current) return false;
    this.past.push({ snapshot: this.current, cost: next.cost });
    this.restore(next.snapshot);
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
    const snapshot = this.take(this.current);
    const made = valueTextMade();
    const newText = made - this.textMark;
    this.textMark = made;
    if (sameSnapshot(snapshot, this.current)) return;

    const typing = this.pendingSrc;
    const now = performance.now();
    const merge =
      typing !== null &&
      typing === this.lastInput &&
      now - this.lastTime < TYPING_MERGE_MS;

    if (!merge && this.current) {
      // what the old state holds beyond the new one is what the new one changed
      this.past.push({
        snapshot: this.current,
        cost: snapshotCost(snapshot, this.current, newText),
      });
      this.trim();
    }

    this.current = snapshot;
    this.future = [];
    this.lastInput = typing;
    this.lastTime = now;
    this.changed();
  }

  /** Drops the oldest steps past the step limit or the memory budget. The
   *  newest step is always kept, so the last change can be undone. */
  private trim() {
    let total = this.past.reduce((sum, step) => sum + step.cost, 0);

    while (
      this.past.length > 1 &&
      (this.past.length > LIMIT || total > this.budget)
    ) {
      total -= this.past.shift()!.cost;
    }
  }

  private restore(snapshot: WorkspaceSnapshot) {
    this.current = snapshot;
    this.restoring = true;

    try {
      this.apply(snapshot);
    } finally {
      this.restoring = false;
      this.lastInput = null;
      this.textMark = valueTextMade();
    }

    this.changed();
  }
}
