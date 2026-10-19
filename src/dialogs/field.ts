// "Field details" dialog: description, access, signedness, formula + unit,
// and named values.
import { Plus, SlidersVertical, Trash } from "lucide";
import { ExprError } from "../expr";
import { compileFormula, formatReal } from "../fieldfmt";
import type { Access, FieldDetails, Group, NamedValue } from "../model";
import { maxValue } from "../numfmt";
import { button, h, modal, segmented, toggleSwitch } from "../ui";

function parseInteger(text: string): bigint {
  const t = text.trim().replace(/_/g, "");
  if (!/^-?(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)$/i.test(t)) throw new ExprError(`"${text}" is not a whole number`);
  return t.startsWith("-") ? -BigInt(t.slice(1)) : BigInt(t);
}

export function editField(g: Group): Promise<Partial<FieldDetails> | null> {
  return modal<Partial<FieldDetails> | null>({
    title: `Field “${g.name}” ${g.label()}`,
    icon: SlidersVertical,
    wide: true,
    cancelValue: null,
    build: (body, close) => {
      const d = g.details();
      const ok = button({ label: "Save", cls: "primary", onClick: () => submit() });

      const desc = h("input", {
        class: "field",
        value: d.description,
        placeholder: "What this field does",
        spellcheck: true,
      });
      const access = segmented<Access>(
        [
          { value: "rw", label: "Read / write" },
          { value: "ro", label: "Read-only", tip: "Clicking its bits asks before changing them" },
          { value: "reserved", label: "Reserved", tip: "Don't touch: clicking its bits asks before changing them" },
        ],
        { value: d.access, onPick: (v) => (d.access = v) },
      );
      const signed = toggleSwitch(d.signed, (v) => {
        d.signed = v;
        refreshFormula();
      });

      // ---- formula
      const formula = h("input", {
        class: "field mono",
        value: d.formula,
        placeholder: "e.g. x * 0.5 - 40   (x is the field's number)",
        spellcheck: false,
      });
      const unit = h("input", { class: "field unit-input", value: d.unit, placeholder: "°C", spellcheck: false });
      const formulaInfo = h("div", { class: "expr-preview" });
      let formulaOk = true;
      const refreshFormula = () => {
        d.formula = formula.value.trim();
        formula.classList.remove("invalid");
        formulaOk = true;
        if (!d.formula) {
          formulaInfo.replaceChildren(h("span", { class: "muted" }, "No formula: the field shows its plain number."));
        } else {
          try {
            const f = compileFormula(d.formula);
            const lo = d.signed && g.width > 1 ? -(1n << BigInt(g.width - 1)) : 0n;
            const hi = d.signed && g.width > 1 ? (1n << BigInt(g.width - 1)) - 1n : maxValue(g.width);
            const u = unit.value.trim() ? ` ${unit.value.trim()}` : "";
            formulaInfo.replaceChildren(
              h(
                "span",
                { class: "mono" },
                `${lo} → ${formatReal(f.f(Number(lo)))}${u}  ·  ${hi} → ${formatReal(f.f(Number(hi)))}${u}`,
              ),
              h(
                "span",
                { class: f.linear ? "same-text" : "expr-note" },
                f.linear ? "  ·  linear: values can be typed in" : "  ·  not linear: shown read-only",
              ),
            );
          } catch (e) {
            if (!(e instanceof ExprError)) throw e;
            formulaOk = false;
            formula.classList.add("invalid");
            formulaInfo.replaceChildren(h("span", { class: "expr-error" }, e.message));
          }
        }
        ok.disabled = !formulaOk;
      };
      formula.addEventListener("input", refreshFormula);
      unit.addEventListener("input", refreshFormula);

      // ---- named values
      const rows: { value: HTMLInputElement; label: HTMLInputElement; row: HTMLElement }[] = [];
      const table = h("div", { class: "named-table" });
      const addRow = (n?: NamedValue) => {
        const value = h("input", {
          class: "field mono named-value",
          value: n ? n.value.toString() : "",
          placeholder: "0",
          spellcheck: false,
        });
        const label = h("input", { class: "field", value: n?.label ?? "", placeholder: "Name", spellcheck: false });
        const row = h(
          "div",
          { class: "named-row" },
          value,
          label,
          button({
            icon: Trash,
            cls: "ghost danger sm",
            tip: "Remove",
            onClick: () => {
              row.remove();
              rows.splice(
                rows.findIndex((r) => r.row === row),
                1,
              );
            },
          }),
        );
        rows.push({ value, label, row });
        table.append(row);
        return value;
      };
      for (const n of d.named) addRow(n);

      const submit = () => {
        const named: NamedValue[] = [];
        for (const r of rows) {
          r.value.classList.remove("invalid");
          if (!r.value.value.trim() && !r.label.value.trim()) continue;
          try {
            let v = parseInteger(r.value.value);
            if (v < 0n) v &= maxValue(g.width); // -1 means all ones
            if (v > maxValue(g.width)) throw new ExprError(`${v} doesn't fit in ${g.width} bits`);
            named.push({ value: v, label: r.label.value.trim() || `VALUE_${v}` });
          } catch (e) {
            if (!(e instanceof ExprError)) throw e;
            r.value.classList.add("invalid");
            r.value.focus();
            return;
          }
        }
        if (!formulaOk) return;
        close({
          description: desc.value.trim(),
          access: d.access,
          signed: d.signed,
          formula: formula.value.trim(),
          unit: unit.value.trim(),
          named,
        });
      };

      const row = (label: string, control: HTMLElement, hint = "") =>
        h(
          "div",
          { class: "set-row" },
          h("div", {}, h("div", { class: "set-label" }, label), hint ? h("div", { class: "set-hint" }, hint) : null),
          control,
        );
      body.append(
        h("label", { class: "modal-label" }, "Description"),
        desc,
        h(
          "section",
          { class: "set-section" },
          h("h4", {}, "Behaviour"),
          h(
            "div",
            { class: "set-card" },
            row("Access", access.el),
            row("Signed", signed, `Read the field as two's complement (${g.width} bits)`),
          ),
        ),
        h(
          "section",
          { class: "set-section" },
          h("h4", {}, "Formula & unit"),
          h("div", { class: "formula-row" }, formula, unit),
          formulaInfo,
        ),
        h(
          "section",
          { class: "set-section" },
          h("h4", {}, "Named values"),
          h(
            "p",
            { class: "set-hint" },
            "Give specific numbers a name, e.g. 0 = Off, 1 = Auto. Numbers may be 0x… or 0b….",
          ),
          table,
          button({ icon: Plus, label: "Add named value", cls: "ghost sm", onClick: () => addRow().focus() }),
        ),
      );
      refreshFormula();
      return [button({ label: "Cancel", onClick: () => close(null) }), ok];
    },
  });
}
