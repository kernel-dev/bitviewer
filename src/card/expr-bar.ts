// A card's expression bar: type an expression, press Enter, and the result
// becomes the value (or the selected bits).
import { Check, SquareFunction, X } from "lucide";
import { type ExprField, exprField, type Lookup } from "../ui/expr-field";
import { button, html, icon } from "../ui/kit";

export function expressionBar(options: {
  width: () => number;
  lookup: Lookup;
  target: () => string; // "value" or "bits [7:0]"
  apply: (value: bigint) => void;
  close: () => void;
  text: string;
  onText: (text: string) => void;
}): { element: HTMLElement; refresh: () => void } {
  // Everything the change callback touches must exist before the field is
  // created, because the field evaluates (and calls back) right away.
  const label = html("span", { class: "expr-target muted small" });
  let field: ExprField | null = null;
  const run = () => {
    const result = field?.result();
    if (result) options.apply(result.value);
  };
  const applyBtn = button({
    icon: Check,
    label: "Apply",
    className: "primary sm",
    tip: "Apply (Enter)",
    onClick: run,
  });
  field = exprField({
    width: options.width,
    lookup: options.lookup,
    value: options.text,
    placeholder:
      "e.g. 0x1F << 3 | bit(31)  ·  names: x (this value), fields, other values, {Name with spaces}",
    onEnter: run,
    onChange: (result) => {
      applyBtn.disabled = !result;
      if (field) options.onText(field.input.value);
      label.textContent = `→ ${options.target()}`;
    },
  });
  const input = field.input;
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      options.close();
    }
  });
  const bar = html(
    "div",
    { class: "expr-bar", "data-keep-sel": "" },
    html(
      "span",
      { class: "expr-icon", tip: "Expression" },
      icon(SquareFunction, 16),
    ),
    field.element,
    label,
    applyBtn,
    button({
      icon: X,
      className: "ghost sm",
      tip: "Close (Esc)",
      onClick: () => options.close(),
    }),
  );
  requestAnimationFrame(() => input.focus());
  return { element: bar, refresh: field.refresh };
}
