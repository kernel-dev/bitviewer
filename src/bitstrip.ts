// One row of bit cells. Click flips a bit; dragging (also across rows) selects
// a contiguous range; Shift+click extends the selection. A compare strip is
// toned down and marks bits that differ from its parent row.
//
// `flex` strips (the "line" view) stretch their cells to fill the width and
// wrap onto 2 or 4 lines when the cells would get too narrow.
import type { Group, ValueModel } from "./model";
import { S } from "./settings";
import { play } from "./sound";
import { h, setTip } from "./ui";

export interface StripHost {
  model: ValueModel;
  sel: [number, number] | null;
  beginDrag(bit: number): void;
  updateDrag(bit: number): void;
  extendSelection(bit: number): void;
  clearSelection(): void;
  /** Flips a bit of the value (the host may ask first for protected fields). */
  flipBit(bit: number): void;
  /** Keyboard cursor position (a bit index), or null. */
  cursor: number | null;
  setCursor(bit: number): void;
  /** Alt+drag "paint": start / set one bit / end (one undo step). */
  paintStart(): void;
  paintBit(bit: number, on: boolean): void;
  paintEnd(): void;
  /** DOM id for a bit cell (for aria-activedescendant). */
  bitId(bit: number): string;
  bitTip(bit: number, lo: number, compare: boolean): string;
  openRowMenu(lo: number, compare: boolean, bit: number | null, at: { x: number; y: number }): void;
  root: HTMLElement;
}

const MIN_CELL = 17;
const GAP = 3;
const FLEX_NIB = 7;
const FLEX_BYTE = 13;
const FIXED_NIB = 10;

export class BitStrip {
  el: HTMLElement;
  private cells = new Map<number, HTMLElement>();
  private perLine = 0;

  /** Bits per visual line (for moving the keyboard cursor up/down). */
  get lineBits(): number {
    return this.flex ? this.perLine : this.host.model.rowWidth;
  }
  private ro?: ResizeObserver;
  private lines: HTMLElement[] = [];

  constructor(
    private host: StripHost,
    readonly lo: number,
    readonly compare = false,
    readonly flex = false,
  ) {
    this.el = h("div", { class: `strip${flex ? " flex" : ""}${compare ? " cmp" : ""}` });
    this.el.addEventListener("pointerdown", (e) => this.onDown(e));
    this.el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      host.openRowMenu(lo, compare, this.bitOf(e.target), { x: e.clientX, y: e.clientY });
    });
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.el);
  }

  /** Bits in this row (the top byte/nibble row can be short). */
  get n(): number {
    return this.host.model.rowWidthAt(this.lo);
  }

  destroy() {
    this.ro?.disconnect();
  }

  // ------------------------------------------------------------ geometry
  /** Gap between two neighbouring bit positions: wider at nibble and byte boundaries. */
  private gapBetween(a: number, b: number): number {
    const k = Math.max(a, b);
    if (k % 8 === 0) return this.flex ? FLEX_BYTE : FIXED_NIB;
    if (k % 4 === 0) return this.flex ? FLEX_NIB : FIXED_NIB;
    return GAP;
  }

  /** Horizontal space taken by gaps on a full line of `k` positions. */
  private fixedSpace(k: number): number {
    let s = 0;
    for (let j = 1; j < k; j++) s += this.gapBetween(j - 1, j);
    return s;
  }

  /** Bits per line to try, widest first: everything on one line, then 256, 128 … 8. */
  private lineOptions(): number[] {
    const n = this.n;
    if (!this.flex || n <= 8) return [n];
    const opts = [n];
    for (let p = 256; p >= 8; p /= 2) if (p < n) opts.push(p);
    return opts;
  }

  private layout() {
    const avail = this.el.clientWidth;
    if (!avail) return;
    const opts = this.lineOptions();
    const per = opts.find((k) => (avail - this.fixedSpace(k)) / k >= MIN_CELL) ?? opts[opts.length - 1];
    if (per !== this.perLine) this.build(per);
    else this.placeBars();
  }

  /** Builds the cells. Each line covers `slots` bit positions aligned to a
   *  multiple of `slots`; positions above the top bit become invisible padding
   *  so columns line up between lines (and a short top byte/nibble row lines
   *  up with the full rows below it). */
  private build(perLine: number) {
    this.perLine = perLine;
    this.cells.clear();
    this.el.replaceChildren();
    this.lines = [];
    const n = this.n;
    const top = this.lo + n - 1;
    const msb = S.get("msb_left");
    const slots = this.flex ? perLine : this.host.model.rowWidth;
    const hasGroups = this.host.model.groups.length > 0;
    this.el.style.setProperty("--min-w", `${this.fixedSpace(slots) + slots * MIN_CELL}px`);
    const keys = [...Array(Math.ceil(n / slots)).keys()];
    if (msb) keys.reverse();
    for (const key of keys) {
      const line = h("div", { class: `bit-line${hasGroups ? " has-bars" : ""}` });
      this.lines.push(line);
      this.el.append(line);
      const start = this.lo + key * slots;
      const positions = [...Array(slots).keys()].map((i) => start + i);
      if (msb) positions.reverse();
      positions.forEach((b, j) => {
        const style = `margin-left:${j ? this.gapBetween(positions[j - 1], b) : 0}px`;
        const idx = this.compare ? null : h("span", { class: "idx" }, b <= top ? String(b) : "");
        if (b > top) {
          line.append(h("div", { class: "bit pad", style }, idx, h("div", { class: "cell" })));
          return;
        }
        const cell = h(
          "div",
          {
            class: "bit",
            dataset: { bit: String(b) },
            style,
            role: "checkbox",
            id: this.compare ? undefined : this.host.bitId(b),
          },
          idx,
          h("div", { class: "cell" }),
        );
        setTip(cell, () => this.host.bitTip(b, this.lo, this.compare));
        this.cells.set(b, cell);
        line.append(cell);
      });
    }
    for (const l of this.lines) l.append(h("div", { class: "bars" }));
    this.update();
    requestAnimationFrame(() => this.placeBars());
  }

  /** Group bars under the cells, one segment per run of bits on a line. */
  private placeBars() {
    const m = this.host.model;
    for (const line of this.lines) {
      const bars = line.querySelector<HTMLElement>(".bars")!;
      bars.replaceChildren();
      if (!m.groups.length) continue;
      type Seg = { g: Group; x0: number; x1: number };
      let seg: Seg | null = null;
      const segs: Seg[] = [];
      for (const cell of line.querySelectorAll<HTMLElement>(".bit:not(.pad)")) {
        const g = m.groupAt(Number(cell.dataset.bit));
        const x0 = cell.offsetLeft;
        const x1 = x0 + cell.offsetWidth;
        if (g && seg && seg.g === g) seg.x1 = x1;
        else if (g) segs.push((seg = { g, x0, x1 }));
        else seg = null;
      }
      for (const s of segs) {
        bars.append(
          h(
            "div",
            {
              class: "gbar",
              style: `left:${s.x0}px;width:${s.x1 - s.x0}px;--g:${s.g.color}`,
              tip: `${s.g.name} ${s.g.label()}`,
            },
            h("span", {}, s.g.name),
          ),
        );
      }
    }
  }

  // ------------------------------------------------------------ state
  update() {
    const m = this.host.model;
    const sel = this.compare ? null : this.host.sel;
    const parentRow = m.rowValue(this.lo);
    for (const [b, el] of this.cells) {
      const on = this.compare ? m.compareBit(this.lo, b) : m.bit(b);
      const cell = el.lastElementChild as HTMLElement;
      cell.textContent = on ? "1" : "0";
      el.classList.toggle("on", !!on);
      const g = m.groupAt(b);
      el.classList.toggle("grouped", !!g);
      el.classList.toggle("locked", !!g?.protected);
      if (g) el.style.setProperty("--g", g.color);
      el.classList.toggle("sel", !!sel && sel[0] <= b && b <= sel[1]);
      el.classList.toggle("cursor", !this.compare && this.host.cursor === b);
      el.setAttribute("aria-checked", on ? "true" : "false");
      el.setAttribute("aria-label", `${this.compare ? "Compare bit" : "Bit"} ${b}${g ? `, field ${g.name}` : ""}`);
      if (this.compare) el.classList.toggle("diff", on !== Number((parentRow >> BigInt(b - this.lo)) & 1n));
    }
  }

  // ------------------------------------------------------------ pointer
  private bitOf(t: EventTarget | null): number | null {
    const cell = t instanceof Element ? t.closest<HTMLElement>(".bit") : null;
    return cell && this.el.contains(cell) ? Number(cell.dataset.bit) : null;
  }

  /** Alt+drag: every bit the pointer passes over becomes `on`. */
  private paint(first: number, on: boolean) {
    const host = this.host;
    host.paintStart();
    host.paintBit(first, on);
    document.body.classList.add("painting");
    const move = (ev: PointerEvent) => {
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".strip:not(.cmp) .bit");
      if (under && host.root.contains(under) && under.dataset.bit) host.paintBit(Number(under.dataset.bit), on);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.body.classList.remove("painting");
      host.paintEnd();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const b = this.bitOf(e.target);
    if (b === null) return;
    e.preventDefault();
    const host = this.host;
    if (!this.compare && e.altKey) {
      this.paint(b, !e.shiftKey);
      return;
    }
    if (!this.compare) host.setCursor(b);
    if (!this.compare && e.shiftKey) {
      host.extendSelection(b);
      return;
    }
    if (!this.compare) host.beginDrag(b);
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (this.compare) return;
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".strip:not(.cmp) .bit");
      const target = under && host.root.contains(under) ? Number(under.dataset.bit) : null;
      if (!dragging) {
        if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 5 && target === b) return;
        dragging = true;
        document.body.classList.add("dragging");
      }
      if (target !== null) host.updateDrag(target);
    };
    const up = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging");
      if (dragging) return;
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      if (this.bitOf(under) !== b) return;
      if (this.compare) {
        host.model.flipCompareBit(this.lo, b);
        play(host.model.compareBit(this.lo, b) ? "bitOn" : "bitOff");
      } else {
        host.clearSelection();
        host.flipBit(b);
      }
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }
}
