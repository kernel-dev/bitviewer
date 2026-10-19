// The readout chips under a card: unsigned, signed, set bits, floats (editable)
// and optional extras. Which chips show is a global setting.
import { Plus } from "lucide";
import {
  bcdDecode,
  bytesAsText,
  clz,
  ctz,
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
} from "./formats";
import type { ValueModel } from "./model";
import { ParseError, popcount, toSigned } from "./numfmt";
import { S } from "./settings";
import { play } from "./sound";
import { button, h, type MenuItem, openMenu, setTip, toast } from "./ui";

interface ChipDef {
  id: string;
  label: string; // shown in the "+" menu
  short: (w: number) => string; // shown on the chip
  tip: (w: number) => string;
  value: (v: bigint, w: number) => string;
}

export const CHIPS: ChipDef[] = [
  {
    id: "u",
    label: "Unsigned",
    short: (w) => `u${w}`,
    tip: (w) => `Unsigned ${w}-bit integer`,
    value: (v) => v.toString(),
  },
  {
    id: "s",
    label: "Signed",
    short: (w) => `s${w}`,
    tip: (w) => `Signed ${w}-bit integer (two's complement)`,
    value: (v, w) => toSigned(v, w).toString(),
  },
  {
    id: "pop",
    label: "Set bits",
    short: () => "set bits",
    tip: () => "Number of bits set to 1",
    value: (v) => String(popcount(v)),
  },
  { id: "float", label: "Floats (16 / 32 / 64-bit)", short: () => "float", tip: () => "", value: () => "" },
  {
    id: "text",
    label: "Text (UTF-8 / ASCII)",
    short: () => "text",
    tip: () => "The bytes as text, most significant first; · marks non-printable bytes",
    value: (v, w) => {
      const t = bytesAsText(v, w);
      return t ? `“${t}”` : "(empty)";
    },
  },
  {
    id: "bcd",
    label: "BCD",
    short: () => "BCD",
    tip: () => "Binary-coded decimal: each nibble is one decimal digit",
    value: (v, w) => bcdDecode(v, w) ?? "not BCD",
  },
  {
    id: "gray",
    label: "Gray code → binary",
    short: () => "gray⁻¹",
    tip: () => "The value read as a Gray code, converted to plain binary",
    value: (v) => grayToBinary(v).toString(),
  },
  {
    id: "ones",
    label: "One's complement",
    short: () => "1's comp",
    tip: () => "Signed value in one's complement",
    value: (v, w) => onesComplement(v, w).toString(),
  },
  {
    id: "clz",
    label: "Leading zeros",
    short: () => "lead 0s",
    tip: () => "Number of leading zero bits",
    value: (v, w) => String(clz(v, w)),
  },
  {
    id: "ctz",
    label: "Trailing zeros",
    short: () => "trail 0s",
    tip: () => "Number of trailing zero bits",
    value: (v, w) => String(ctz(v, w)),
  },
  {
    id: "parity",
    label: "Parity",
    short: () => "parity",
    tip: () => "Even or odd number of set bits",
    value: (v) => (popcount(v) % 2 ? "odd" : "even"),
  },
  {
    id: "msb",
    label: "Highest set bit",
    short: () => "top bit",
    tip: () => "Index of the highest bit that is 1",
    value: (v) => (v === 0n ? "none" : String(v.toString(2).length - 1)),
  },
];

export class StatsBar {
  readonly el: HTMLElement;
  private vals = new Map<string, HTMLElement>();
  private floats = new Map<FloatKind, { val: HTMLElement; detail: HTMLElement }>();
  private editing: FloatKind | null = null;

  constructor(private model: ValueModel) {
    this.el = h("div", { class: "stats" });
    this.build();
  }

  build() {
    const w = this.model.width;
    const on = new Set(S.get("readout_chips"));
    this.vals.clear();
    this.floats.clear();
    this.el.replaceChildren();
    for (const c of CHIPS) {
      if (!on.has(c.id)) continue;
      if (c.id === "float") {
        for (const kind of floatKinds(w)) this.el.append(this.floatChip(kind));
        continue;
      }
      const val = h("span", { class: "stat-val mono" });
      this.vals.set(c.id, val);
      this.el.append(
        h("div", { class: `stat stat-${c.id}`, tip: c.tip(w) }, h("span", { class: "stat-label" }, c.short(w)), val),
      );
    }
    const add = button({ icon: Plus, cls: "ghost sm stat-add", tip: "Choose readouts", size: 14 });
    add.addEventListener("click", () => openMenu(this.chooser(), add));
    this.el.append(add);
    this.el.hidden = !S.get("show_interp");
    this.update();
  }

  private chooser(): MenuItem[] {
    const on = new Set(S.get("readout_chips"));
    return CHIPS.map((c) => ({
      label: c.label,
      checked: on.has(c.id),
      keepOpen: true,
      action: () => {
        const now = new Set(S.get("readout_chips"));
        if (now.has(c.id)) now.delete(c.id);
        else now.add(c.id);
        S.set(
          "readout_chips",
          CHIPS.map((x) => x.id).filter((id) => now.has(id)),
        );
      },
    }));
  }

  private floatChip(kind: FloatKind): HTMLElement {
    const val = h("button", { type: "button", class: "stat-val mono stat-edit", tip: "Click to type a number" });
    const detail = h("span", { class: "stat-detail mono" });
    val.addEventListener("click", () => this.editFloat(kind, val));
    this.floats.set(kind, { val, detail });
    const chip = h(
      "div",
      { class: "stat stat-float" },
      h("span", { class: "stat-label" }, FLOAT_NAMES[kind]),
      val,
      detail,
    );
    setTip(chip, () => `IEEE-754 ${FLOAT_NAMES[kind]}: ${floatBreakdown(decodeFloat(this.model.value, kind))}`);
    return chip;
  }

  private editFloat(kind: FloatKind, val: HTMLElement) {
    if (this.editing) return;
    this.editing = kind;
    const input = h("input", {
      class: "field mono stat-input",
      value: formatFloatKind(decodeFloat(this.model.value, kind), kind),
      spellcheck: false,
    });
    const done = (commit: boolean) => {
      if (this.editing !== kind) return;
      this.editing = null;
      if (commit) {
        try {
          const f = parseFloatText(input.value);
          this.model.setValue(encodeFloat(f, kind));
          play("bitOn");
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          play("error");
          toast(e.message, "error");
        }
      }
      input.replaceWith(val);
      this.update();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(true);
      else if (e.key === "Escape") {
        e.stopPropagation();
        done(false);
      }
    });
    input.addEventListener("blur", () => done(true));
    val.replaceWith(input);
    input.focus();
    input.select();
  }

  update() {
    if (this.el.hidden) return;
    const { value: v, width: w } = this.model;
    for (const c of CHIPS) {
      const el = this.vals.get(c.id);
      if (el) el.textContent = c.value(v, w);
    }
    for (const [kind, { val, detail }] of this.floats) {
      const f = decodeFloat(v, kind);
      val.textContent = formatFloatKind(f, kind);
      detail.textContent = floatBreakdown(f);
    }
  }
}
