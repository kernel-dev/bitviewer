// One row of bit cells. Click flips a bit; dragging (also across rows) selects
// a contiguous range; Shift+click extends the selection. A compare strip is
// toned down and marks bits that differ from its parent row.
//
// `flex` strips (the "line" view) stretch their cells to fill the width and
// wrap onto 2 or 4 lines when the cells would get too narrow.

import type { Group, ValueModel } from "../core/model";
import { appSettings } from "../platform/settings";
import { html, setTip } from "../ui/kit";
import { play } from "../ui/sound";

export interface StripHost {
  model: ValueModel;
  selection: [number, number] | null;
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

  paintBit(bit: number, isOn: boolean): void;
  paintEnd(): void;

  /** DOM id for a bit cell (for aria-activedescendant). */
  bitId(bit: number): string;

  bitTip(bit: number, lo: number, compare: boolean): string;

  openRowMenu(
    lo: number,
    compare: boolean,
    bit: number | null,
    position: { x: number; y: number },
  ): void;

  root: HTMLElement;
}

const MIN_CELL = 17;
const GAP = 3;
const FLEX_NIB = 7;
const FLEX_BYTE = 13;
const FIXED_NIB = 10;

/** The width of the line-view strip measured last: the best guess for a new one. */
let lastFlexWidth = 0;

type BarSegment = { group: Group; startX: number; endX: number };

export class BitStrip {
  element: HTMLElement;
  private cells = new Map<number, HTMLElement>();
  private perLine = 0;
  private sizer = html("div", { class: "strip-sizer", "aria-hidden": "true" });
  /** Available width as last reported by the resize observer (0 = not laid out). */
  private width = 0;
  /** The width changed how many bits fit on a line: rebuild in the next frame. */
  private rebuildDue = false;

  /** Bits per visual line (for moving the keyboard cursor up/down). */
  get lineBits(): number {
    return this.flex ? this.perLine : this.host.model.rowWidth;
  }

  private resizeObserver?: ResizeObserver;
  private lines: HTMLElement[] = [];

  // Resizes are handled once per frame for all strips together: first any
  // rebuilds, then every measurement for the field bars, then every bar is
  // drawn. Measuring between writes would make the browser lay out the whole
  // page again for each strip, which is very slow with thousands of strips.
  private static due = new Set<BitStrip>();
  private static frameRequested = false;

  private static schedule(strip: BitStrip) {
    BitStrip.due.add(strip);
    if (BitStrip.frameRequested) return;
    BitStrip.frameRequested = true;

    requestAnimationFrame(() => {
      BitStrip.frameRequested = false;
      const strips = [...BitStrip.due].filter(
        (candidate) => candidate.element.isConnected,
      );
      BitStrip.due.clear();

      for (const candidate of strips)
        if (candidate.rebuildDue) {
          candidate.rebuildDue = false;
          candidate.build(candidate.lineLength(candidate.width));
        }

      const plans = strips.map((candidate) => candidate.measureBars());

      strips.forEach((candidate, index) => {
        candidate.drawBars(plans[index]);
      });
    });
  }

  constructor(
    private host: StripHost,
    readonly lo: number,
    readonly compare = false,
    readonly flex = false,
  ) {
    this.element = html("div", {
      class: `strip${flex ? " flex" : ""}${compare ? " cmp" : ""}`,
    });
    this.element.addEventListener("pointerdown", (event) => this.onDown(event));

    this.element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      host.openRowMenu(lo, compare, this.bitOf(event.target), {
        x: event.clientX,
        y: event.clientY,
      });
    });

    // Watch a zero-height sizer rather than the strip: it only changes with the
    // available width. The observer just records the width (reading it from
    // the DOM would force a layout); changes to the bits wait for the next
    // frame, since changing heights inside the observer makes the browser
    // report a ResizeObserver loop.
    this.element.append(this.sizer);

    this.resizeObserver = new ResizeObserver((entries) => {
      const width = Math.round(
        entries[entries.length - 1]?.contentRect.width ?? 0,
      );
      if (!width) return; // not laid out, e.g. a card far out of view
      this.width = width;
      if (flex) lastFlexWidth = width;
      if (this.lineLength(width) !== this.perLine) this.rebuildDue = true;
      BitStrip.schedule(this);
    });

    this.resizeObserver.observe(this.sizer);
    // Build right away, so the card has its full height at once (and the bits
    // never flash empty): byte and nibble rows don't depend on the width, and
    // in line view the last strip's width is a good guess.
    const guess = flex ? lastFlexWidth : 1;
    if (guess) this.build(this.lineLength(guess));
  }

  /** Bits in this row (the top byte/nibble row can be short). */
  get n(): number {
    return this.host.model.rowWidthAt(this.lo);
  }

  destroy() {
    this.resizeObserver?.disconnect();
  }

  // ------------------------------------------------------------ geometry
  /** Gap between two neighbouring bit positions: wider at nibble and byte boundaries. */
  private gapBetween(firstBit: number, secondBit: number): number {
    const larger = Math.max(firstBit, secondBit);
    if (larger % 8 === 0) return this.flex ? FLEX_BYTE : FIXED_NIB;
    if (larger % 4 === 0) return this.flex ? FLEX_NIB : FIXED_NIB;
    return GAP;
  }

  /** Horizontal space taken by gaps on a full line of `k` positions. */
  private fixedSpace(bitsPerRow: number): number {
    let total = 0;
    for (let j = 1; j < bitsPerRow; j++) total += this.gapBetween(j - 1, j);
    return total;
  }

  /** Bits per line to try, widest first: everything on one line, then 256, 128 … 8. */
  private lineOptions(): number[] {
    const bitCount = this.n;
    if (!this.flex || bitCount <= 8) return [bitCount];
    const options = [bitCount];

    for (let bitsPerRow = 256; bitsPerRow >= 8; bitsPerRow /= 2)
      if (bitsPerRow < bitCount) options.push(bitsPerRow);

    return options;
  }

  /** How many bits go on a line when `avail` pixels are available. */
  private lineLength(avail: number): number {
    const options = this.lineOptions();
    return (
      options.find(
        (candidate) =>
          (avail - this.fixedSpace(candidate)) / candidate >= MIN_CELL,
      ) ?? options[options.length - 1]
    );
  }

  /** Builds the cells. Each line covers `slots` bit positions aligned to a
   *  multiple of `slots`; positions above the top bit become invisible padding
   *  so columns line up between lines (and a short top byte/nibble row lines
   *  up with the full rows below it). */
  private build(perLine: number) {
    this.perLine = perLine;
    this.cells.clear();
    this.element.replaceChildren(this.sizer);
    this.lines = [];
    const bitCount = this.n;
    const top = this.lo + bitCount - 1;
    const msbLeft = appSettings.get("msb_left");
    const slots = this.flex ? perLine : this.host.model.rowWidth;
    const hasGroups = this.host.model.groups.length > 0;
    this.element.style.setProperty(
      "--min-w",
      `${this.fixedSpace(slots) + slots * MIN_CELL}px`,
    );
    const keys = [...Array(Math.ceil(bitCount / slots)).keys()];
    if (msbLeft) keys.reverse();

    for (const key of keys) {
      const line = html("div", {
        class: `bit-line${hasGroups ? " has-bars" : ""}`,
      });
      this.lines.push(line);
      this.element.append(line);
      const start = this.lo + key * slots;
      const positions = [...Array(slots).keys()].map(
        (offset) => start + offset,
      );
      if (msbLeft) positions.reverse();

      positions.forEach((bit, slot) => {
        const style = `margin-left:${slot ? this.gapBetween(positions[slot - 1], bit) : 0}px`;
        const indexElement = this.compare
          ? null
          : html("span", { class: "idx" }, bit <= top ? String(bit) : "");

        if (bit > top) {
          line.append(
            html(
              "div",
              { class: "bit pad", style },
              indexElement,
              html("div", { class: "cell" }),
            ),
          );
          return;
        }

        const cell = html(
          "div",
          {
            class: "bit",
            dataset: { bit: String(bit) },
            style,
            role: "checkbox",
            id: this.compare ? undefined : this.host.bitId(bit),
          },
          indexElement,
          html("div", { class: "cell" }),
        );
        setTip(cell, () => this.host.bitTip(bit, this.lo, this.compare));
        this.cells.set(bit, cell);
        line.append(cell);
      });
    }

    for (const line of this.lines) line.append(html("div", { class: "bars" }));
    this.update();
    // the field bars are placed once the strip has been laid out (see schedule)
  }

  /** Where the field bars go: one segment per run of a field's bits on each
   *  line. Only reads the layout. */
  private measureBars(): BarSegment[][] {
    const model = this.host.model;
    return this.lines.map((line) => {
      const segments: BarSegment[] = [];
      if (!model.groups.length) return segments;
      let currentSegment: BarSegment | null = null;

      for (const cell of line.querySelectorAll<HTMLElement>(".bit:not(.pad)")) {
        const group = model.groupAt(Number(cell.dataset.bit));
        const startX = cell.offsetLeft;
        const endX = startX + cell.offsetWidth;

        if (group && currentSegment && currentSegment.group === group)
          currentSegment.endX = endX;
        else if (group)
          segments.push((currentSegment = { group, startX, endX }));
        else currentSegment = null;
      }

      return segments;
    });
  }

  /** Draws the field bars measured by measureBars(). Only writes. */
  private drawBars(plan: BarSegment[][]) {
    const hasGroups = this.host.model.groups.length > 0;
    this.lines.forEach((line, index) => {
      line.classList.toggle("has-bars", hasGroups);
      line.querySelector<HTMLElement>(".bars")!.replaceChildren(
        ...(plan[index] ?? []).map((segment) =>
          html(
            "div",
            {
              class: "gbar",
              style: `left:${segment.startX}px;width:${segment.endX - segment.startX}px;--g:${segment.group.color}`,
              tip: `${segment.group.name} ${segment.group.label()}`,
            },
            html("span", {}, segment.group.name),
          ),
        ),
      );
    });
  }

  // ------------------------------------------------------------ state
  update() {
    const model = this.host.model;
    const selection = this.compare ? null : this.host.selection;
    const parentRow = model.rowValue(this.lo);

    for (const [bit, cellElement] of this.cells) {
      const bitValue = this.compare
        ? model.compareBit(this.lo, bit)
        : model.bit(bit);
      const cell = cellElement.lastElementChild as HTMLElement;
      cell.textContent = bitValue ? "1" : "0";
      cellElement.classList.toggle("on", !!bitValue);
      const group = model.groupAt(bit);
      cellElement.classList.toggle("grouped", !!group);
      cellElement.classList.toggle("locked", !!group?.protected);
      if (group) cellElement.style.setProperty("--g", group.color);
      cellElement.classList.toggle(
        "sel",
        !!selection && selection[0] <= bit && bit <= selection[1],
      );
      cellElement.classList.toggle(
        "cursor",
        !this.compare && this.host.cursor === bit,
      );
      cellElement.setAttribute("aria-checked", bitValue ? "true" : "false");
      cellElement.setAttribute(
        "aria-label",
        `${this.compare ? "Compare bit" : "Bit"} ${bit}${group ? `, field ${group.name}` : ""}`,
      );

      if (this.compare)
        cellElement.classList.toggle(
          "diff",
          bitValue !== Number((parentRow >> BigInt(bit - this.lo)) & 1n),
        );
    }
  }

  // ------------------------------------------------------------ pointer
  private bitOf(target: EventTarget | null): number | null {
    const cell =
      target instanceof Element ? target.closest<HTMLElement>(".bit") : null;
    return cell && this.element.contains(cell)
      ? Number(cell.dataset.bit)
      : null;
  }

  /** Alt+drag: every bit the pointer passes over becomes `on`. */
  private paint(first: number, isOn: boolean) {
    const host = this.host;
    host.paintStart();
    host.paintBit(first, isOn);
    document.body.classList.add("painting");

    const move = (event: PointerEvent) => {
      const under = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>(".strip:not(.cmp) .bit");

      if (under && host.root.contains(under) && under.dataset.bit)
        host.paintBit(Number(under.dataset.bit), isOn);
    };

    // The stroke must always end: until paintEnd() the undo history is on
    // hold. A cancelled pointer (pen, touch, Alt+Tab mid-stroke) or the window
    // losing focus may never deliver a pointerup.
    const finish = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      document.body.classList.remove("painting");
      host.paintEnd();
    };

    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  }

  private onDown(event: PointerEvent) {
    if (event.button !== 0) return;
    const bit = this.bitOf(event.target);
    if (bit === null) return;
    event.preventDefault();
    const host = this.host;

    if (!this.compare && event.altKey) {
      this.paint(bit, !event.shiftKey);
      return;
    }

    if (!this.compare) host.setCursor(bit);

    if (!this.compare && event.shiftKey) {
      host.extendSelection(bit);
      return;
    }

    if (!this.compare) host.beginDrag(bit);
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    const move = (moveEvent: PointerEvent) => {
      if (this.compare) return;
      const under = document
        .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest<HTMLElement>(".strip:not(.cmp) .bit");
      const target =
        under && host.root.contains(under) ? Number(under.dataset.bit) : null;

      if (!dragging) {
        if (
          Math.abs(moveEvent.clientX - startX) +
            Math.abs(moveEvent.clientY - startY) <
            5 &&
          target === bit
        )
          return;

        dragging = true;
        document.body.classList.add("dragging");
      }

      if (target !== null) host.updateDrag(target);
    };

    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      document.body.classList.remove("dragging");
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      stop();
      if (dragging) return;
      const under = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
      if (this.bitOf(under) !== bit) return;

      if (this.compare) {
        host.model.flipCompareBit(this.lo, bit);
        play(host.model.compareBit(this.lo, bit) ? "bitOn" : "bitOff");
      } else {
        host.clearSelection();
        host.flipBit(bit);
      }
    };

    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  }
}
