// "New value from expression…": compute a value from other values.
import { SquareFunction } from "lucide";
import { MAX_WIDTH, MIN_WIDTH } from "../core/model";
import { exprField, type Lookup } from "../ui/expr-field";
import { button, html, modal, segmented } from "../ui/kit";

export interface NewValue {
  name: string;
  width: number;
  value: bigint;
}

export function newValueFromExpression(
  lookup: Lookup,
  defaultWidth: number,
): Promise<NewValue | null> {
  return modal<NewValue | null>({
    title: "New value from expression",
    icon: SquareFunction,
    wide: true,
    cancelValue: null,
    build: (body, close) => {
      let width = defaultWidth;
      const confirmButton = button({
        label: "Add value",
        className: "primary",
        onClick: () => submit(),
      });
      const name = html("input", {
        class: "field",
        placeholder: "Name (optional)",
        spellcheck: false,
      });
      const field = exprField({
        width: () => width,
        lookup,
        placeholder: "e.g. {Value 1} ^ {Value 2}   ·   CTRL | bit(31)",
        onEnter: () => submit(),
        onChange: (result) => {
          confirmButton.disabled = !result;
        },
      });
      const widthIn = html("input", {
        class: "field mono width-input",
        type: "number",
        min: MIN_WIDTH,
        max: MAX_WIDTH,
        value: String(width),
      });
      const presets = segmented(
        [8, 16, 32, 64, 128].map((bits) => ({
          value: bits,
          label: String(bits),
        })),
        {
          value: width,
          onPick: (bits) => {
            widthIn.value = String(bits);
            setWidth(bits);
          },
          className: "sm width-presets",
        },
      );
      const setWidth = (newWidth: number) => {
        if (
          Number.isInteger(newWidth) &&
          newWidth >= MIN_WIDTH &&
          newWidth <= MAX_WIDTH
        ) {
          width = newWidth;
          widthIn.classList.remove("invalid");
          field.refresh();
        } else {
          widthIn.classList.add("invalid");
          confirmButton.disabled = true;
        }
      };
      widthIn.addEventListener("input", () => setWidth(Number(widthIn.value)));
      const submit = () => {
        const result = field.result();
        if (result && !widthIn.classList.contains("invalid"))
          close({ name: name.value.trim(), width, value: result.value });
      };
      body.append(
        html(
          "label",
          { class: "modal-label" },
          "Expression — use other values by name; {braces} for names with spaces",
        ),
        field.element,
        html("div", { class: "modal-label" }, "Width"),
        html(
          "div",
          { class: "width-row" },
          widthIn,
          html("span", { class: "muted" }, "bits"),
          presets.element,
        ),
        html("div", { class: "modal-label" }, "Name"),
        name,
      );
      field.refresh();
      requestAnimationFrame(() => field.input.focus());
      return [
        button({ label: "Cancel", onClick: () => close(null) }),
        confirmButton,
      ];
    },
  });
}
