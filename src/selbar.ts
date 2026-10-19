// Selection readout in a card's toolbar: the selected range plus an editable
// value for just those bits, in a base of your choice.
import type { ValueModel } from "./model";
import { BASE_NAMES, type Base } from "./numfmt";
import { h, NumberInput, segmented } from "./ui";

const BASES: Base[] = [16, 10, 2];

export class SelectionBar {
  readonly el: HTMLElement;
  private input: NumberInput | null = null;
  private key = "";
  private base: Base = 16;

  constructor(private model: ValueModel) {
    // clicking in here must not count as "clicking elsewhere" and drop the selection
    this.el = h("div", { class: "sel-bar", "data-keep-sel": "" });
  }

  update(sel: [number, number] | null) {
    if (!sel) {
      if (this.key !== "") {
        this.key = "";
        this.input = null;
      }
      this.el.classList.remove("active");
      this.el.replaceChildren(h("span", { class: "sel-hint mono" }, "drag across bits to select"));
      return;
    }
    const [lo, hi] = sel;
    const w = hi - lo + 1;
    const key = `${lo}:${hi}:${this.base}`;
    if (key !== this.key) {
      this.key = key;
      this.input = new NumberInput(w, this.base, (v) => this.model.setBitsValue(lo, w, v), { cls: "sel-edit" });
      this.input.el.style.setProperty(
        "--chars",
        String(Math.min(Math.max(this.base === 2 ? w : Math.ceil(w / 3), 3), 24)),
      );
      const seg = segmented(
        BASES.map((b) => ({ value: b, label: BASE_NAMES[b] })),
        {
          value: this.base,
          onPick: (b) => {
            this.base = b;
            this.update(sel);
          },
          cls: "xs",
        },
      );
      this.el.replaceChildren(
        h("span", { class: "sel-range mono" }, `${w > 1 ? `[${hi}:${lo}]` : `[${lo}]`} · ${w} bit${w > 1 ? "s" : ""}`),
        seg.el,
        this.input.el,
      );
    }
    this.el.classList.add("active");
    this.input?.setValue(this.model.bitsValue(lo, w));
  }
}
