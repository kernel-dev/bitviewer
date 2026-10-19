// "New value from expression…": compute a value from other values.
import { SquareFunction } from "lucide";
import { exprField, type Lookup } from "../exprfield";
import { MAX_WIDTH, MIN_WIDTH } from "../model";
import { button, h, modal, segmented } from "../ui";

export interface NewValue {
  name: string;
  width: number;
  value: bigint;
}

export function newValueFromExpression(lookup: Lookup, defaultWidth: number): Promise<NewValue | null> {
  return modal<NewValue | null>({
    title: "New value from expression",
    icon: SquareFunction,
    wide: true,
    cancelValue: null,
    build: (body, close) => {
      let width = defaultWidth;
      const ok = button({ label: "Add value", cls: "primary", onClick: () => submit() });
      const name = h("input", { class: "field", placeholder: "Name (optional)", spellcheck: false });
      const field = exprField({
        width: () => width,
        lookup,
        placeholder: "e.g. {Value 1} ^ {Value 2}   ·   CTRL | bit(31)",
        onEnter: () => submit(),
        onChange: (r) => {
          ok.disabled = !r;
        },
      });
      const widthIn = h("input", {
        class: "field mono width-input",
        type: "number",
        min: MIN_WIDTH,
        max: MAX_WIDTH,
        value: String(width),
      });
      const presets = segmented(
        [8, 16, 32, 64, 128].map((p) => ({ value: p, label: String(p) })),
        {
          value: width,
          onPick: (p) => {
            widthIn.value = String(p);
            setWidth(p);
          },
          cls: "sm width-presets",
        },
      );
      const setWidth = (w: number) => {
        if (Number.isInteger(w) && w >= MIN_WIDTH && w <= MAX_WIDTH) {
          width = w;
          widthIn.classList.remove("invalid");
          field.refresh();
        } else {
          widthIn.classList.add("invalid");
          ok.disabled = true;
        }
      };
      widthIn.addEventListener("input", () => setWidth(Number(widthIn.value)));
      const submit = () => {
        const r = field.result();
        if (r && !widthIn.classList.contains("invalid")) close({ name: name.value.trim(), width, value: r.value });
      };
      body.append(
        h("label", { class: "modal-label" }, "Expression — use other values by name; {braces} for names with spaces"),
        field.el,
        h("div", { class: "modal-label" }, "Width"),
        h("div", { class: "width-row" }, widthIn, h("span", { class: "muted" }, "bits"), presets.el),
        h("div", { class: "modal-label" }, "Name"),
        name,
      );
      field.refresh();
      requestAnimationFrame(() => field.input.focus());
      return [button({ label: "Cancel", onClick: () => close(null) }), ok];
    },
  });
}
