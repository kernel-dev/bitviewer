// Which bits of a card are selected, and how drags, Shift+clicks, Shift+arrows
// and row label clicks change that. The card repaints; this only keeps track.

export class BitSelection {
  /** The selected bits [lo, hi], or null. */
  range: [number, number] | null = null;
  /** The bit a drag or Shift+arrow selection started from. */
  private anchor: number | null = null;
  /** The row whose label was clicked last, for Shift+click on another label. */
  private rowAnchor: number | null = null;

  set(fromBit: number, toBit: number) {
    this.range = [Math.min(fromBit, toBit), Math.max(fromBit, toBit)];
  }

  /** Forgets the selection. Returns whether there was one. */
  clear(): boolean {
    this.anchor = null;
    this.rowAnchor = null;
    if (!this.range) return false;
    this.range = null;
    return true;
  }

  /** A drag starts at `bit`. */
  begin(bit: number) {
    this.anchor = bit;
    this.rowAnchor = null;
  }

  /** The drag reached `bit`. Returns false when no drag is going on. */
  drag(bit: number): boolean {
    if (this.anchor === null) return false;
    this.set(this.anchor, bit);
    return true;
  }

  /** Shift+click: from the selection's start (or `bit`) to `bit`. */
  extend(bit: number) {
    if (this.anchor === null) this.anchor = this.range ? this.range[0] : bit;
    this.set(this.anchor, bit);
  }

  /** Shift+arrow: the keyboard cursor moved from `current` to `next`. */
  extendFromCursor(current: number, next: number) {
    if (this.anchor === null)
      this.anchor = this.range
        ? this.range[0] === current
          ? this.range[1]
          : this.range[0]
        : current;

    this.set(this.anchor, next);
  }

  /** A click on the label of the row starting at `lo`; with Shift, selects
   *  every row from the label clicked before. `top` gives a row's top bit. */
  selectRows(lo: number, shift: boolean, top: (rowStart: number) => number) {
    if (shift && this.rowAnchor !== null) {
      const anchorRow = this.rowAnchor;
      this.set(Math.min(anchorRow, lo), top(Math.max(anchorRow, lo)));
    } else {
      this.rowAnchor = lo;
      this.anchor = null;
      this.set(lo, top(lo));
    }
  }
}
