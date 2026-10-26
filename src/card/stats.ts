// The readout chips under a card: unsigned, signed, set bits, floats (editable)
// and optional extras. Which chips show is a global setting.
import { Plus } from "lucide";
import { ParseError, popcount, toSigned } from "../core/format/integers";
import {
  bcdDecode,
  bytesAsText,
  countLeadingZeros,
  countTrailingZeros,
  decodeFloat,
  encodeFloat,
  FLOAT_NAMES,
  type FloatKind,
  floatBreakdown,
  floatKinds,
  formatFloatKind,
  grayToBinary,
  onesComplement,
  parseFloatText,
} from "../core/format/interpretations";
import type { ValueModel } from "../core/model";
import { appSettings } from "../platform/settings";
import {
  button,
  html,
  type MenuItem,
  openMenu,
  setTip,
  toast,
} from "../ui/kit";
import { play } from "../ui/sound";

interface ChipDef {
  id: string;
  label: string; // shown in the "+" menu
  short: (width: number) => string; // shown on the chip
  tip: (width: number) => string;
  value: (value: bigint, width: number) => string;
}

export const CHIPS: ChipDef[] = [
  {
    id: "u",
    label: "Unsigned",
    short: (width) => `u${width}`,
    tip: (width) => `Unsigned ${width}-bit integer`,
    value: (value) => value.toString(),
  },
  {
    id: "s",
    label: "Signed",
    short: (width) => `s${width}`,
    tip: (width) => `Signed ${width}-bit integer (two's complement)`,
    value: (value, width) => toSigned(value, width).toString(),
  },
  {
    id: "pop",
    label: "Set bits",
    short: () => "set bits",
    tip: () => "Number of bits set to 1",
    value: (value) => String(popcount(value)),
  },
  {
    id: "float",
    label: "Floats (16 / 32 / 64-bit)",
    short: () => "float",
    tip: () => "",
    value: () => "",
  },
  {
    id: "text",
    label: "Text (UTF-8 / ASCII)",
    short: () => "text",
    tip: () =>
      "The bytes as text, most significant first; · marks non-printable bytes",
    value: (value, width) => {
      const text = bytesAsText(value, width);
      return text ? `“${text}”` : "(empty)";
    },
  },
  {
    id: "bcd",
    label: "BCD",
    short: () => "BCD",
    tip: () => "Binary-coded decimal: each nibble is one decimal digit",
    value: (value, width) => bcdDecode(value, width) ?? "not BCD",
  },
  {
    id: "gray",
    label: "Gray code → binary",
    short: () => "gray⁻¹",
    tip: () => "The value read as a Gray code, converted to plain binary",
    value: (value) => grayToBinary(value).toString(),
  },
  {
    id: "ones",
    label: "One's complement",
    short: () => "1's comp",
    tip: () => "Signed value in one's complement",
    value: (value, width) => onesComplement(value, width).toString(),
  },
  {
    id: "clz",
    label: "Leading zeros",
    short: () => "lead 0s",
    tip: () => "Number of leading zero bits",
    value: (value, width) => String(countLeadingZeros(value, width)),
  },
  {
    id: "ctz",
    label: "Trailing zeros",
    short: () => "trail 0s",
    tip: () => "Number of trailing zero bits",
    value: (value, width) => String(countTrailingZeros(value, width)),
  },
  {
    id: "parity",
    label: "Parity",
    short: () => "parity",
    tip: () => "Even or odd number of set bits",
    value: (value) => (popcount(value) % 2 ? "odd" : "even"),
  },
  {
    id: "msb",
    label: "Highest set bit",
    short: () => "top bit",
    tip: () => "Index of the highest bit that is 1",
    value: (value) =>
      value === 0n ? "none" : String(value.toString(2).length - 1),
  },
];

export class StatsBar {
  readonly element: HTMLElement;
  private valueElements = new Map<string, HTMLElement>();
  private floats = new Map<
    FloatKind,
    { valueElement: HTMLElement; detail: HTMLElement }
  >();
  private editing: FloatKind | null = null;

  /** `write` sets the whole value (the card asks first for protected fields). */
  constructor(
    private model: ValueModel,
    private write: (value: bigint) => Promise<boolean>,
  ) {
    this.element = html("div", { class: "stats" });
    this.build();
  }

  build() {
    const width = this.model.width;
    const enabledChips = new Set(appSettings.get("readout_chips"));
    this.valueElements.clear();
    this.floats.clear();
    this.element.replaceChildren();
    for (const chip of CHIPS) {
      if (!enabledChips.has(chip.id)) continue;
      if (chip.id === "float") {
        for (const kind of floatKinds(width))
          this.element.append(this.floatChip(kind));
        continue;
      }
      const valueElement = html("span", { class: "stat-val mono" });
      this.valueElements.set(chip.id, valueElement);
      this.element.append(
        html(
          "div",
          { class: `stat stat-${chip.id}`, tip: chip.tip(width) },
          html("span", { class: "stat-label" }, chip.short(width)),
          valueElement,
        ),
      );
    }
    const addButton = button({
      icon: Plus,
      className: "ghost sm stat-add",
      tip: "Choose readouts",
      size: 14,
    });
    addButton.addEventListener("click", () =>
      openMenu(this.chooser(), addButton),
    );
    this.element.append(addButton);
    this.element.hidden = !appSettings.get("show_interp");
    this.update();
  }

  private chooser(): MenuItem[] {
    const enabledChips = new Set(appSettings.get("readout_chips"));
    return CHIPS.map((chip) => ({
      label: chip.label,
      checked: enabledChips.has(chip.id),
      keepOpen: true,
      action: () => {
        const now = new Set(appSettings.get("readout_chips"));
        if (now.has(chip.id)) now.delete(chip.id);
        else now.add(chip.id);
        appSettings.set(
          "readout_chips",
          CHIPS.map((chip) => chip.id).filter((id) => now.has(id)),
        );
      },
    }));
  }

  private floatChip(kind: FloatKind): HTMLElement {
    const valueButton = html("button", {
      type: "button",
      class: "stat-val mono stat-edit",
      tip: "Click to type a number",
    });
    const detail = html("span", { class: "stat-detail mono" });
    valueButton.addEventListener("click", () =>
      this.editFloat(kind, valueButton),
    );
    this.floats.set(kind, { valueElement: valueButton, detail });
    const chip = html(
      "div",
      { class: "stat stat-float" },
      html("span", { class: "stat-label" }, FLOAT_NAMES[kind]),
      valueButton,
      detail,
    );
    setTip(
      chip,
      () =>
        `IEEE-754 ${FLOAT_NAMES[kind]}: ${floatBreakdown(decodeFloat(this.model.value, kind))}`,
    );
    return chip;
  }

  private editFloat(kind: FloatKind, valueElement: HTMLElement) {
    if (this.editing) return;
    this.editing = kind;
    const input = html("input", {
      class: "field mono stat-input",
      value: formatFloatKind(decodeFloat(this.model.value, kind), kind),
      spellcheck: false,
    });
    const done = (commit: boolean) => {
      if (this.editing !== kind) return;
      this.editing = null;
      if (commit) {
        try {
          const parsed = parseFloatText(input.value);
          void this.write(encodeFloat(parsed, kind)).then((written) => {
            if (written) play("bitOn");
          });
        } catch (error) {
          if (!(error instanceof ParseError)) throw error;
          play("error");
          toast(error.message, "error");
        }
      }
      input.replaceWith(valueElement);
      this.update();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") done(true);
      else if (event.key === "Escape") {
        event.stopPropagation();
        done(false);
      }
    });
    input.addEventListener("blur", () => done(true));
    valueElement.replaceWith(input);
    input.focus();
    input.select();
  }

  update() {
    if (this.element.hidden) return;
    const { value, width } = this.model;
    for (const chip of CHIPS) {
      const chipValueElement = this.valueElements.get(chip.id);
      if (chipValueElement)
        chipValueElement.textContent = chip.value(value, width);
    }
    for (const [kind, { valueElement, detail }] of this.floats) {
      const floatValue = decodeFloat(value, kind);
      valueElement.textContent = formatFloatKind(floatValue, kind);
      detail.textContent = floatBreakdown(floatValue);
    }
  }
}
