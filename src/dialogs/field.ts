// "Field details" dialog: description, access, signedness, formula + unit,
// and named values.
import { Plus, SlidersVertical, Trash } from "lucide";
import { ExprError } from "../core/expr";
import { compileFormula, formatReal } from "../core/format/fields";
import { maxValue } from "../core/format/integers";
import type { Access, FieldDetails, Group, NamedValue } from "../core/model";
import { button, html, modal, segmented, toggleSwitch } from "../ui/kit";

function parseInteger(text: string): bigint {
  const cleaned = text.trim().replace(/_/g, "");
  if (!/^-?(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)$/i.test(cleaned))
    throw new ExprError(`"${text}" is not a whole number`);
  return cleaned.startsWith("-") ? -BigInt(cleaned.slice(1)) : BigInt(cleaned);
}

export function editField(group: Group): Promise<Partial<FieldDetails> | null> {
  let changed = () => false;
  return modal<Partial<FieldDetails> | null>({
    title: `Field “${group.name}” ${group.label()}`,
    icon: SlidersVertical,
    wide: true,
    cancelValue: null,
    hasChanges: () => changed(),
    build: (body, close) => {
      const details = group.details();
      const confirmButton = button({
        label: "Save",
        className: "primary",
        onClick: () => submit(),
      });

      const descriptionInput = html("input", {
        class: "field",
        value: details.description,
        placeholder: "What this field does",
        spellcheck: true,
      });
      const access = segmented<Access>(
        [
          { value: "rw", label: "Read / write" },
          {
            value: "ro",
            label: "Read-only",
            tip: "Clicking its bits asks before changing them",
          },
          {
            value: "reserved",
            label: "Reserved",
            tip: "Don't touch: clicking its bits asks before changing them",
          },
        ],
        {
          value: details.access,
          onPick: (access) => (details.access = access),
        },
      );
      const signed = toggleSwitch(details.signed, (value) => {
        details.signed = value;
        refreshFormula();
      });

      // ---- formula
      const formula = html("input", {
        class: "field mono",
        value: details.formula,
        placeholder: "e.g. x * 0.5 - 40   (x is the field's number)",
        spellcheck: false,
      });
      const unit = html("input", {
        class: "field unit-input",
        value: details.unit,
        placeholder: "°C",
        spellcheck: false,
      });
      const formulaInfo = html("div", { class: "expr-preview" });
      let formulaOk = true;
      const refreshFormula = () => {
        details.formula = formula.value.trim();
        formula.classList.remove("invalid");
        formulaOk = true;
        if (!details.formula) {
          formulaInfo.replaceChildren(
            html(
              "span",
              { class: "muted" },
              "No formula: the field shows its plain number.",
            ),
          );
        } else {
          try {
            const formula = compileFormula(details.formula);
            const lo =
              details.signed && group.width > 1
                ? -(1n << BigInt(group.width - 1))
                : 0n;
            const hi =
              details.signed && group.width > 1
                ? (1n << BigInt(group.width - 1)) - 1n
                : maxValue(group.width);
            const unitSuffix = unit.value.trim() ? ` ${unit.value.trim()}` : "";
            formulaInfo.replaceChildren(
              html(
                "span",
                { class: "mono" },
                `${lo} → ${formatReal(formula.evaluate(Number(lo)))}${unitSuffix}  ·  ${hi} → ${formatReal(formula.evaluate(Number(hi)))}${unitSuffix}`,
              ),
              html(
                "span",
                { class: formula.linear ? "same-text" : "expr-note" },
                formula.linear
                  ? "  ·  linear: values can be typed in"
                  : "  ·  not linear: shown read-only",
              ),
            );
          } catch (error) {
            if (!(error instanceof ExprError)) throw error;
            formulaOk = false;
            formula.classList.add("invalid");
            formulaInfo.replaceChildren(
              html("span", { class: "expr-error" }, error.message),
            );
          }
        }
        confirmButton.disabled = !formulaOk;
      };
      formula.addEventListener("input", refreshFormula);
      unit.addEventListener("input", refreshFormula);

      // ---- named values
      const rows: {
        value: HTMLInputElement;
        label: HTMLInputElement;
        row: HTMLElement;
      }[] = [];
      const table = html("div", { class: "named-table" });
      const addRow = (namedValue?: NamedValue) => {
        const value = html("input", {
          class: "field mono named-value",
          value: namedValue ? namedValue.value.toString() : "",
          placeholder: "0",
          spellcheck: false,
        });
        const label = html("input", {
          class: "field",
          value: namedValue?.label ?? "",
          placeholder: "Name",
          spellcheck: false,
        });
        const row = html(
          "div",
          { class: "named-row" },
          value,
          label,
          button({
            icon: Trash,
            className: "ghost danger sm",
            tip: "Remove",
            onClick: () => {
              row.remove();
              rows.splice(
                rows.findIndex((rowEntry) => rowEntry.row === row),
                1,
              );
            },
          }),
        );
        rows.push({ value, label, row });
        table.append(row);
        return value;
      };
      for (const namedValue of details.named) addRow(namedValue);

      const submit = () => {
        const named: NamedValue[] = [];
        for (const rowEntry of rows) {
          rowEntry.value.classList.remove("invalid");
          if (!rowEntry.value.value.trim() && !rowEntry.label.value.trim())
            continue;
          try {
            let value = parseInteger(rowEntry.value.value);
            if (value < 0n) value &= maxValue(group.width); // -1 means all ones
            if (value > maxValue(group.width))
              throw new ExprError(
                `${value} doesn't fit in ${group.width} bits`,
              );
            named.push({
              value: value,
              label: rowEntry.label.value.trim() || `VALUE_${value}`,
            });
          } catch (error) {
            if (!(error instanceof ExprError)) throw error;
            rowEntry.value.classList.add("invalid");
            rowEntry.value.focus();
            return;
          }
        }
        if (!formulaOk) return;
        close({
          description: descriptionInput.value.trim(),
          access: details.access,
          signed: details.signed,
          formula: formula.value.trim(),
          unit: unit.value.trim(),
          named,
        });
      };

      const row = (label: string, control: HTMLElement, hint = "") =>
        html(
          "div",
          { class: "set-row" },
          html(
            "div",
            {},
            html("div", { class: "set-label" }, label),
            hint ? html("div", { class: "set-hint" }, hint) : null,
          ),
          control,
        );
      body.append(
        html("label", { class: "modal-label" }, "Description"),
        descriptionInput,
        html(
          "section",
          { class: "set-section" },
          html("h4", {}, "Behaviour"),
          html(
            "div",
            { class: "set-card" },
            row("Access", access.element),
            row(
              "Signed",
              signed,
              `Read the field as two's complement (${group.width} bits)`,
            ),
          ),
        ),
        html(
          "section",
          { class: "set-section" },
          html("h4", {}, "Formula & unit"),
          html("div", { class: "formula-row" }, formula, unit),
          formulaInfo,
        ),
        html(
          "section",
          { class: "set-section" },
          html("h4", {}, "Named values"),
          html(
            "p",
            { class: "set-hint" },
            "Give specific numbers a name, e.g. 0 = Off, 1 = Auto. Numbers may be 0x… or 0b….",
          ),
          table,
          button({
            icon: Plus,
            label: "Add named value",
            className: "ghost sm",
            onClick: () => addRow().focus(),
          }),
        ),
      );
      refreshFormula();
      const formState = () =>
        JSON.stringify([
          descriptionInput.value,
          details.access,
          details.signed,
          formula.value,
          unit.value,
          rows.map((rowEntry) => [rowEntry.value.value, rowEntry.label.value]),
        ]);
      const initialState = formState();
      changed = () => formState() !== initialState;
      return [
        button({ label: "Cancel", onClick: () => close(null) }),
        confirmButton,
      ];
    },
  });
}
