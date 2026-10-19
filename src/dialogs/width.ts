// Dialog asking for a bit width (1–512) with presets.
import { Ruler } from "lucide";
import { MAX_WIDTH, MIN_WIDTH } from "../model";
import { button, h, modal, segmented } from "../ui";

const PRESETS = [8, 16, 32, 64, 128, 256, 512];

/** Resolves to the chosen width, or null when cancelled. */
export function pickWidth(title: string, current: number, okLabel: string): Promise<number | null> {
  return modal<number | null>({
    title,
    icon: Ruler,
    cancelValue: null,
    build: (body, close) => {
      const input = h("input", {
        class: "field mono width-input",
        type: "number",
        min: MIN_WIDTH,
        max: MAX_WIDTH,
        step: 1,
        value: String(current),
        spellcheck: false,
      });
      const err = h("div", { class: "width-error" });
      const seg = segmented(
        PRESETS.map((p) => ({ value: p, label: String(p) })),
        {
          value: PRESETS.includes(current) ? current : undefined,
          onPick: (p) => {
            input.value = String(p);
            validate();
            input.focus();
          },
          cls: "width-presets",
        },
      );
      const ok = button({ label: okLabel, cls: "primary", onClick: () => submit() });
      const parse = () => (/^\s*\d+\s*$/.test(input.value) ? Number(input.value) : Number.NaN);
      const validate = () => {
        const n = parse();
        const valid = Number.isInteger(n) && n >= MIN_WIDTH && n <= MAX_WIDTH;
        ok.disabled = !valid;
        input.classList.toggle("invalid", !valid && input.value !== "");
        err.textContent = valid || input.value === "" ? "" : `Enter a whole number from ${MIN_WIDTH} to ${MAX_WIDTH}`;
        seg.set(PRESETS.includes(n) ? n : (undefined as unknown as number));
        return valid;
      };
      const submit = () => {
        if (validate()) close(parse());
      };
      input.addEventListener("input", validate);
      input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
      body.append(
        h("label", { class: "modal-label" }, `Number of bits (${MIN_WIDTH}–${MAX_WIDTH})`),
        h("div", { class: "width-row" }, input, h("span", { class: "muted" }, "bits")),
        err,
        h("div", { class: "modal-label presets-label" }, "Presets"),
        seg.el,
      );
      validate();
      return [button({ label: "Cancel", onClick: () => close(null) }), ok];
    },
  });
}
