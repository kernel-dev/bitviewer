// Dialog asking for a bit width (1–512) with presets.
import { Ruler } from "lucide";
import { MAX_WIDTH, MIN_WIDTH } from "../core/model";
import { button, html, modal, segmented } from "../ui/kit";

const PRESETS = [8, 16, 32, 64, 128, 256, 512];

/** Resolves to the chosen width, or null when cancelled. */
export function pickWidth(
  title: string,
  current: number,
  okLabel: string,
): Promise<number | null> {
  return modal<number | null>({
    title,
    icon: Ruler,
    cancelValue: null,
    build: (body, close) => {
      const input = html("input", {
        class: "field mono width-input",
        type: "number",
        min: MIN_WIDTH,
        max: MAX_WIDTH,
        step: 1,
        value: String(current),
        spellcheck: false,
      });
      const errorElement = html("div", { class: "width-error" });

      const presetControl = segmented(
        PRESETS.map((preset) => ({ value: preset, label: String(preset) })),
        {
          value: PRESETS.includes(current) ? current : undefined,
          onPick: (preset) => {
            input.value = String(preset);
            validate();
            input.focus();
          },
          className: "width-presets",
        },
      );

      const confirmButton = button({
        label: okLabel,
        className: "primary",
        onClick: () => submit(),
      });
      const parse = () =>
        /^\s*\d+\s*$/.test(input.value) ? Number(input.value) : Number.NaN;

      const validate = () => {
        const parsedWidth = parse();
        const valid =
          Number.isInteger(parsedWidth) &&
          parsedWidth >= MIN_WIDTH &&
          parsedWidth <= MAX_WIDTH;
        confirmButton.disabled = !valid;
        input.classList.toggle("invalid", !valid && input.value !== "");
        errorElement.textContent =
          valid || input.value === ""
            ? ""
            : `Enter a whole number from ${MIN_WIDTH} to ${MAX_WIDTH}`;
        presetControl.set(
          PRESETS.includes(parsedWidth)
            ? parsedWidth
            : (undefined as unknown as number),
        );
        return valid;
      };

      const submit = () => {
        if (validate()) close(parse());
      };

      input.addEventListener("input", validate);
      input.addEventListener(
        "keydown",
        (event) => event.key === "Enter" && submit(),
      );
      body.append(
        html(
          "label",
          { class: "modal-label" },
          `Number of bits (${MIN_WIDTH}–${MAX_WIDTH})`,
        ),
        html(
          "div",
          { class: "width-row" },
          input,
          html("span", { class: "muted" }, "bits"),
        ),
        errorElement,
        html("div", { class: "modal-label presets-label" }, "Presets"),
        presetControl.element,
      );
      validate();
      return [
        button({ label: "Cancel", onClick: () => close(null) }),
        confirmButton,
      ];
    },
  });
}
