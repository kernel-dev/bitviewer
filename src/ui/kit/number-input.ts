// A text field for an integer in a given base and width.

import {
  type Base,
  formatInt,
  ParseError,
  parseValue,
} from "../../core/format/integers";
import { play } from "../sound";
import { html } from "./dom";
import { hideTip, setTip, showTip } from "./tooltip";

/** Validated integer field. Commits live while typing; invalid input is
 *  marked red with the reason as tooltip; Esc / blur restores the value. */
export class NumberInput {
  element: HTMLInputElement;
  private value = 0n;
  private tipText: string;
  private error: string | null = null;

  constructor(
    private width: number,
    public base: Base,
    private onCommit: (value: bigint) => void,
    private opts: {
      allowNegative?: boolean;
      group?: boolean;
      className?: string;
    } = {},
  ) {
    this.tipText =
      "Type a value in the selected base.\nPrefixes 0x / 0b / 0o override it (in HEX, 0b… is read as hex).\n" +
      "Spaces and _ are ignored." +
      (opts.allowNegative ? "\nA leading - stores the two's complement." : "");

    this.element = html("input", {
      class: `field mono ${opts.className ?? ""}`,
      spellcheck: false,
      autocomplete: "off",
    });

    setTip(this.element, () =>
      this.error ? `⚠ ${this.error}\n\n${this.tipText}` : this.tipText,
    );

    this.element.addEventListener("input", () => this.onEdited());
    this.element.addEventListener("blur", () => this.render());

    this.element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.render();
        this.element.blur();
      } else if (event.key === "Enter") {
        this.element.blur();
      }
    });
  }

  setFormat(width: number, base: Base) {
    if (width !== this.width || base !== this.base) {
      this.width = width;
      this.base = base;
      this.render();
    }
  }

  /** While the user types, the text already equals the committed value, so
   *  leave it alone. Any other change (bit flip, operation) re-renders. */
  setValue(value: bigint) {
    const changed = value !== this.value;
    this.value = value;
    if (changed || document.activeElement !== this.element) this.render();
  }

  private render() {
    this.element.value = formatInt(this.value, this.base, this.width, {
      group: this.opts.group,
    });
    this.mark(null);
  }

  private onEdited() {
    let value: bigint;

    try {
      value = parseValue(
        this.element.value,
        this.base,
        this.width,
        this.opts.allowNegative,
      );
    } catch (error) {
      if (error instanceof ParseError)
        this.mark(error.incomplete ? null : error.message);

      return;
    }

    this.mark(null);
    this.value = value;
    this.onCommit(value);
  }

  private mark(error: string | null) {
    if (error && !this.error) play("error");

    this.error = error;
    this.element.classList.toggle("invalid", !!error);

    if (error && document.activeElement === this.element)
      showTip(this.element, error);
    else if (!error && document.activeElement === this.element) hideTip();
  }
}
