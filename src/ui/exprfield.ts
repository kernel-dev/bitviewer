// An input that evaluates an integer expression as you type and previews the
// result for a given bit width.
import { ExprError, evalInt, parseExpr } from "../core/expr";
import { formatInt, maxValue, ParseError } from "../core/numfmt";
import { h } from "./kit";

export type Lookup = (name: string) => bigint | undefined;

export interface ExprResult {
  value: bigint; // masked to the width
  note: string; // e.g. "truncated to 32 bits"
}

/** Evaluates `src` and fits the result into `width` bits. Throws ExprError. */
export function evaluateFor(src: string, width: number, lookup: Lookup): ExprResult {
  const raw = evalInt(parseExpr(src), lookup);
  const mask = maxValue(width);
  const value = raw & mask;
  let note = "";
  if (raw < 0n)
    note = raw >= -(1n << BigInt(width - 1)) ? "negative: stored as two's complement" : `wrapped to ${width} bits`;
  else if (raw > mask) note = `truncated to ${width} bits`;
  return { value, note };
}

export interface ExprField {
  el: HTMLElement;
  input: HTMLInputElement;
  /** Current result, or null while the text is empty or invalid. */
  result(): ExprResult | null;
  refresh(): void;
}

export function exprField(opts: {
  width: () => number;
  lookup: Lookup;
  placeholder?: string;
  value?: string;
  onEnter?: () => void;
  onChange?: (r: ExprResult | null) => void;
}): ExprField {
  const input = h("input", {
    class: "field mono expr-input",
    placeholder: opts.placeholder ?? "e.g. 0x1F << 3 | bit(31)",
    value: opts.value ?? "",
    spellcheck: false,
    autocomplete: "off",
  });
  const preview = h("div", { class: "expr-preview mono" });
  let current: ExprResult | null = null;

  const refresh = () => {
    const src = input.value.trim();
    current = null;
    input.classList.remove("invalid");
    if (!src) {
      preview.replaceChildren(h("span", { class: "muted" }, "Result appears here"));
    } else {
      try {
        current = evaluateFor(src, opts.width(), opts.lookup);
        const w = opts.width();
        preview.replaceChildren(
          h("span", { class: "expr-eq" }, "= "),
          formatInt(current.value, 16, w, { prefix: true, group: true }),
          h("span", { class: "muted" }, ` · ${current.value.toString()}`),
          current.note ? h("span", { class: "expr-note" }, ` · ${current.note}`) : "",
        );
      } catch (e) {
        if (
          !(e instanceof ExprError || e instanceof ParseError || e instanceof RangeError || e instanceof SyntaxError)
        ) {
          throw e;
        }
        input.classList.add("invalid");
        preview.replaceChildren(h("span", { class: "expr-error" }, e.message));
      }
    }
    opts.onChange?.(current);
  };

  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && current) {
      e.preventDefault();
      opts.onEnter?.();
    }
  });
  refresh();
  return { el: h("div", { class: "expr-field" }, input, preview), input, result: () => current, refresh };
}
