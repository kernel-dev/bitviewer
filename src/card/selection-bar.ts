// Selection readout in a card's toolbar: the selected range plus an editable
// value for just those bits, in a base of your choice.

import { BASE_NAMES, type Base } from "../core/format/integers";
import type { ValueModel } from "../core/model";
import { html, NumberInput, segmented } from "../ui/kit";

const BASES: Base[] = [16, 10, 2];

export class SelectionBar {
  private el: HTMLElement | null = null;
  private input: NumberInput | null = null;
  private key = "";
  private base: Base = 16;

  /** `write` sets the selected bits (the card asks first for protected fields). */
  constructor(
    private model: ValueModel,
    private write: (
      lo: number,
      width: number,
      value: bigint,
      input: HTMLElement,
    ) => void,
  ) {}

  /** Made when the card is first built, so a large workspace doesn't hold
   *  one for every value. */
  get element(): HTMLElement {
    // clicking in here must not count as "clicking elsewhere" and drop the selection
    this.el ??= html("div", { class: "sel-bar", "data-keep-sel": "" });
    return this.el;
  }

  /** Lets go of the last selection's elements (the card was emptied). The
   *  chosen base stays. */
  release() {
    // out of the old toolbar too: through its parent it would keep all of it
    this.el?.remove();
    this.el = null;
    this.input = null;
    this.key = "";
  }

  update(selection: [number, number] | null) {
    if (!selection) {
      if (this.key !== "") {
        this.key = "";
        this.input = null;
      }

      this.element.classList.remove("active");
      this.element.replaceChildren(
        html("span", { class: "sel-hint mono" }, "drag across bits to select"),
      );
      return;
    }

    const [lo, hi] = selection;
    const width = hi - lo + 1;
    const key = `${lo}:${hi}:${this.base}`;
    if (key !== this.key) {
      this.key = key;
      const input: NumberInput = new NumberInput(
        width,
        this.base,
        (value) => this.write(lo, width, value, input.element),
        {
          className: "sel-edit",
        },
      );
      this.input = input;
      this.input.element.style.setProperty(
        "--chars",
        String(
          Math.min(
            Math.max(this.base === 2 ? width : Math.ceil(width / 3), 3),
            24,
          ),
        ),
      );

      const baseControl = segmented(
        BASES.map((base) => ({ value: base, label: BASE_NAMES[base] })),
        {
          value: this.base,
          onPick: (base) => {
            this.base = base;
            this.update(selection);
          },
          className: "xs",
        },
      );

      this.element.replaceChildren(
        html(
          "span",
          { class: "sel-range mono" },
          `${width > 1 ? `[${hi}:${lo}]` : `[${lo}]`} · ${width} bit${width > 1 ? "s" : ""}`,
        ),
        baseControl.element,
        this.input.element,
      );
    }

    this.element.classList.add("active");
    this.input?.setValue(this.model.bitsValue(lo, width));
  }
}
