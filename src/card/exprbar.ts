// A card's expression bar: type an expression, press Enter, and the result
// becomes the value (or the selected bits).
import { Check, SquareFunction, X } from "lucide";
import { type ExprField, exprField, type Lookup } from "../ui/exprfield";
import { button, h, icon } from "../ui/kit";

export function expressionBar(opts: {
  width: () => number;
  lookup: Lookup;
  target: () => string; // "value" or "bits [7:0]"
  apply: (v: bigint) => void;
  close: () => void;
  text: string;
  onText: (s: string) => void;
}): HTMLElement {
  // Everything the change callback touches must exist before the field is
  // created, because the field evaluates (and calls back) right away.
  const label = h("span", { class: "expr-target muted small" });
  let field: ExprField | null = null;
  const run = () => {
    const r = field?.result();
    if (r) opts.apply(r.value);
  };
  const applyBtn = button({ icon: Check, label: "Apply", cls: "primary sm", tip: "Apply (Enter)", onClick: run });
  field = exprField({
    width: opts.width,
    lookup: opts.lookup,
    value: opts.text,
    placeholder: "e.g. 0x1F << 3 | bit(31)  ·  names: x (this value), fields, other values, {Name with spaces}",
    onEnter: run,
    onChange: (r) => {
      applyBtn.disabled = !r;
      if (field) opts.onText(field.input.value);
      label.textContent = `→ ${opts.target()}`;
    },
  });
  const input = field.input;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      opts.close();
    }
  });
  const bar = h(
    "div",
    { class: "expr-bar", "data-keep-sel": "" },
    h("span", { class: "expr-icon", tip: "Expression" }, icon(SquareFunction, 16)),
    field.el,
    label,
    applyBtn,
    button({ icon: X, cls: "ghost sm", tip: "Close (Esc)", onClick: () => opts.close() }),
  );
  requestAnimationFrame(() => input.focus());
  return bar;
}
