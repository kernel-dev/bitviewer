// An input that evaluates an integer expression as you type and previews the
// result for a given bit width.
import { ExprError, evalInt, parseExpr } from "../core/expr";
import { formatInt, maxValue, ParseError } from "../core/format/integers";
import { html } from "./kit";

export type Lookup = (name: string) => bigint | undefined;

export interface ExprResult {
  value: bigint; // masked to the width
  note: string; // e.g. "truncated to 32 bits"
}

/** Evaluates `src` and fits the result into `width` bits. Throws ExprError. */
export function evaluateFor(
  source: string,
  width: number,
  lookup: Lookup,
): ExprResult {
  const raw = evalInt(parseExpr(source), lookup);
  const mask = maxValue(width);
  const value = raw & mask;
  let note = "";
  if (raw < 0n)
    note =
      raw >= -(1n << BigInt(width - 1))
        ? "negative: stored as two's complement"
        : `wrapped to ${width} bits`;
  else if (raw > mask) note = `truncated to ${width} bits`;
  return { value, note };
}

export interface ExprField {
  element: HTMLElement;
  input: HTMLInputElement;
  /** Current result, or null while the text is empty or invalid. */
  result(): ExprResult | null;
  refresh(): void;
}

export function exprField(options: {
  width: () => number;
  lookup: Lookup;
  placeholder?: string;
  value?: string;
  onEnter?: () => void;
  onChange?: (result: ExprResult | null) => void;
}): ExprField {
  const input = html("input", {
    class: "field mono expr-input",
    placeholder: options.placeholder ?? "e.g. 0x1F << 3 | bit(31)",
    value: options.value ?? "",
    spellcheck: false,
    autocomplete: "off",
  });
  const preview = html("div", { class: "expr-preview mono" });
  let current: ExprResult | null = null;

  const refresh = () => {
    const source = input.value.trim();
    current = null;
    input.classList.remove("invalid");
    if (!source) {
      preview.replaceChildren(
        html("span", { class: "muted" }, "Result appears here"),
      );
    } else {
      try {
        current = evaluateFor(source, options.width(), options.lookup);
        const width = options.width();
        preview.replaceChildren(
          html("span", { class: "expr-eq" }, "= "),
          formatInt(current.value, 16, width, { prefix: true, group: true }),
          html("span", { class: "muted" }, ` · ${current.value.toString()}`),
          current.note
            ? html("span", { class: "expr-note" }, ` · ${current.note}`)
            : "",
        );
      } catch (error) {
        if (
          !(
            error instanceof ExprError ||
            error instanceof ParseError ||
            error instanceof RangeError ||
            error instanceof SyntaxError
          )
        ) {
          throw error;
        }
        input.classList.add("invalid");
        preview.replaceChildren(
          html("span", { class: "expr-error" }, error.message),
        );
      }
    }
    options.onChange?.(current);
  };

  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && current) {
      event.preventDefault();
      options.onEnter?.();
    }
  });
  refresh();
  return {
    element: html("div", { class: "expr-field" }, input, preview),
    input,
    result: () => current,
    refresh,
  };
}
