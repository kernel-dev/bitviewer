// Small pieces shared by the parts of a card.

import {
  BASE_NAMES,
  BASE_ORDER,
  type Base,
  formatInt,
} from "../core/format/integers";
import { copyText } from "../platform/native";
import { html, type Segmented, segmented, toast } from "../ui/kit";
import { play } from "../ui/sound";

/** A BIN / OCT / DEC / HEX picker. */
export function baseSeg(
  base: Base,
  onPick: (base: Base) => void,
  className = "sm",
): Segmented<Base> {
  return segmented(
    BASE_ORDER.map((base) => ({ value: base, label: BASE_NAMES[base] })),
    { value: base, onPick, className },
  );
}

/** The muted "hex · dec · oct" text beside a row. */
export function readout(): HTMLElement {
  return html("span", { class: "readout mono" });
}

/** "21.5 °C" → "21.5" when the unit is "°C". */
export function stripUnit(text: string, unit: string): string {
  const trimmed = text.trim();
  return unit && trimmed.endsWith(unit)
    ? trimmed.slice(0, -unit.length).trim()
    : trimmed;
}

/** Runs a removal and plays its sound. */
export function removed(action: () => void) {
  action();
  play("remove");
}

/** Copies text to the clipboard and says so. */
export function copyToClipboard(text: string) {
  copyText(text).then(
    () => {
      play("copy");
      toast(`Copied ${text}`, "ok");
    },
    () => toast("Could not access the clipboard", "error"),
  );
}

/** Copies a number as written in `base`, with its prefix. */
export function copyValue(value: bigint, base: Base, width: number) {
  copyToClipboard(formatInt(value, base, width, { prefix: true }));
}
