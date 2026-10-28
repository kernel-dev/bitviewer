// "Import CMSIS-SVD…": pick registers from a device description and add them
// as values (with their fields and reset values) or save them as templates.
// A register array is one row: its copies can be listed, or picked by
// position ("0-7, 12"), so arrays of any size stay quick to work with.
import { ChevronDown, ChevronRight, Cpu } from "lucide";
import {
  hexAddress,
  IndexSet,
  type SvdDevice,
  type SvdPeripheral,
  type SvdRegisterArray,
} from "../core/svd";
import { append, button, html, icon, modal, setTip } from "../ui/kit";

export interface SvdChoice {
  action: "add" | "templates";
  /** The picked copies of each array, in file order. */
  picks: { array: SvdRegisterArray; positions: IndexSet }[];
  /** How many registers that is. */
  count: number;
}

const MAX_ROWS = 400; // rows drawn at once; the search narrows the rest

const matches = (query: string, ...texts: string[]) =>
  texts.some((text) => text.toLowerCase().includes(query));

const plural = (count: number, word: string, words = `${word}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? word : words}`;

/** A checkbox that stands for many: ticked, empty or in between. */
function groupBox(label: string, chosen: number, total: number) {
  const box = html("input", {
    type: "checkbox",
    class: "svd-check",
    "aria-label": label,
    checked: chosen > 0 && chosen === total,
    disabled: !total,
  });
  box.indeterminate = chosen > 0 && chosen < total;
  box.addEventListener("click", (event) => event.stopPropagation());
  return box;
}

/** Makes `row` open and close with a click, Enter or Space. */
function toggleOn(row: HTMLElement, toggle: () => void) {
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", (event) => {
    if (event.target !== row) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });
}

export function pickSvdRegisters(
  device: SvdDevice,
  fileName: string,
): Promise<SvdChoice | null> {
  const arrays = device.peripherals.flatMap(
    (peripheral) => peripheral.registers,
  );
  const picked = new Map<SvdRegisterArray, IndexSet>(
    arrays.map((array) => [array, IndexSet.all(array.count)]),
  );
  const pickedIn = (list: SvdRegisterArray[]) =>
    list.reduce((total, array) => total + picked.get(array)!.size, 0);
  const countIn = (list: SvdRegisterArray[]) =>
    list.reduce((total, array) => total + array.count, 0);
  const expanded = new Set<SvdPeripheral>();
  const openArrays = new Set<SvdRegisterArray>();

  return modal<SvdChoice | null>({
    title: `Import from ${device.name}`,
    icon: Cpu,
    wide: true,
    cancelValue: null,
    hasChanges: () => pickedIn(arrays) > 0,

    build: (body, close) => {
      body.parentElement?.classList.add("guide-modal");
      const registerCount = countIn(arrays);
      const search = html("input", {
        class: "field svd-search",
        placeholder: "Filter peripherals and registers by name or description…",
        spellcheck: false,
      });
      const count = html("span", { class: "muted small svd-count" });
      const list = html("div", {
        class: "svd-list",
        role: "tree",
        "aria-label": "Peripherals and registers",
      });
      const addButton = button({
        label: "Add values",
        className: "primary",
        onClick: () => finish("add"),
      });
      const templatesButton = button({
        label: "Save as templates",
        className: "outline",
        tip: "Keep the field layouts in your templates, to apply to any value later",
        onClick: () => finish("templates"),
      });

      const query = () => search.value.trim().toLowerCase();

      /** The peripherals the filter lets through, each with its registers
       *  that do (all of them when the peripheral itself matches). */
      const filtered = () => {
        const text = query();
        return device.peripherals.flatMap((peripheral) => {
          const peripheralHit =
            !text ||
            matches(
              text,
              peripheral.name,
              peripheral.groupName,
              peripheral.description,
            );
          const registers = peripheralHit
            ? peripheral.registers
            : peripheral.registers.filter((array) =>
                matches(text, array.label, array.description),
              );
          return peripheralHit || registers.length
            ? [{ peripheral, peripheralHit, registers }]
            : [];
        });
      };

      // "Select all" acts on what the filter shows (everything when empty)
      const inScope = () => filtered().flatMap((entry) => entry.registers);
      const allPicked = (list: SvdRegisterArray[]) =>
        list.length > 0 && pickedIn(list) === countIn(list);

      const allButton = button({
        label: "Select all",
        className: "outline svd-all",
        tip: "Select or unselect every register the filter shows",
        onClick: () => {
          const registers = inScope();
          const on = !allPicked(registers);
          for (const array of registers) picked.get(array)!.fill(on);
          render();
        },
      });

      const finish = (action: SvdChoice["action"]) => {
        const picks = arrays
          .map((array) => ({ array, positions: picked.get(array)! }))
          .filter((pick) => pick.positions.size > 0);
        const chosen = pickedIn(arrays);
        if (chosen) close({ action, picks, count: chosen });
      };

      const updateCount = () => {
        const chosen = pickedIn(arrays);
        count.textContent = chosen
          ? `${plural(chosen, "register")} selected`
          : `${device.peripherals.length} peripherals · ${plural(registerCount, "register")}`;
        addButton.disabled = templatesButton.disabled = chosen === 0;
        addButton.textContent =
          chosen > 1
            ? `Add ${chosen.toLocaleString("en-US")} values`
            : "Add value";
        const registers = inScope();
        allButton.textContent = `${allPicked(registers) ? "Unselect" : "Select"} all${query() ? " matching" : ""}`;
        allButton.disabled = !registers.length;
      };

      const peripheralBox = (peripheral: SvdPeripheral) => {
        const box = groupBox(
          `Select every register of ${peripheral.name}`,
          pickedIn(peripheral.registers),
          countIn(peripheral.registers),
        );

        box.addEventListener("change", () => {
          for (const array of peripheral.registers)
            picked.get(array)!.fill(box.checked);
          render();
        });

        return box;
      };

      const details = (array: SvdRegisterArray) => {
        const fieldCount = array.fields.length;
        return `${array.size}-bit · ${plural(fieldCount, "field")}${array.warnings.length ? " ⚠" : ""}`;
      };
      const warningTip = (array: SvdRegisterArray) =>
        array.warnings.length
          ? `Left out:\n${array.warnings.join("\n")}`
          : undefined;

      /** A plain register: one row with a checkbox. */
      const registerRow = (array: SvdRegisterArray) => {
        const positions = picked.get(array)!;
        const box = html("input", {
          type: "checkbox",
          class: "svd-check",
          checked: positions.size > 0,
          "aria-label": `Select ${array.label}`,
        });

        box.addEventListener("change", () => {
          positions.fill(box.checked);
          render();
        });

        return html(
          "label",
          { class: "svd-reg", role: "treeitem", tip: warningTip(array) },
          box,
          html("b", { class: "mono" }, array.label),
          html(
            "span",
            { class: "muted mono small" },
            `${hexAddress(array.at(0).address)} · ${details(array)}`,
          ),
          html("span", { class: "muted small svd-desc" }, array.description),
        );
      };

      /** The positions box of an array: "0-7, 12", applied on Enter or
       *  when it loses focus. */
      const positionsInput = (array: SvdRegisterArray) => {
        const last = array.count - 1;
        const hint = `Copies to pick, counted from 0 (0–${last.toLocaleString("en-US")}), e.g. 0-7, 12`;
        const input = html("input", {
          class: "field mono small svd-positions",
          value: picked.get(array)!.toString(),
          placeholder: "none",
          spellcheck: false,
          "aria-label": `Copies of ${array.label} to pick`,
          tip: hint,
        });
        input.addEventListener("click", (event) => event.stopPropagation());

        const read = () => IndexSet.parse(input.value, array.count);

        input.addEventListener("input", () => {
          const result = read();
          const problem = typeof result === "string" ? result : "";
          input.classList.toggle("invalid", !!problem);
          input.setAttribute("aria-invalid", problem ? "true" : "false");
          setTip(input, problem || hint);
        });

        const apply = () => {
          const result = read();
          if (typeof result === "string") return;
          picked.set(array, result);
          render();
        };

        input.addEventListener("change", apply);
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            apply();
          }
        });

        return input;
      };

      /** An array of registers: a row that opens to list its copies. */
      const arrayRow = (array: SvdRegisterArray) => {
        const positions = picked.get(array)!;
        const open = openArrays.has(array);
        const box = groupBox(
          `Select every copy of ${array.label}`,
          positions.size,
          array.count,
        );

        box.addEventListener("change", () => {
          positions.fill(box.checked);
          render();
        });

        const row = html(
          "div",
          {
            class: "svd-reg svd-array",
            role: "treeitem",
            "aria-expanded": open ? "true" : "false",
            tabindex: 0,
            tip: warningTip(array),
          },
          icon(open ? ChevronDown : ChevronRight, 15, "muted"),
          box,
          html("b", { class: "mono" }, array.label),
          html(
            "span",
            { class: "muted mono small" },
            `${hexAddress(array.at(0).address)} · ${plural(array.count, "copy", "copies")} · ${details(array)}`,
          ),
          positionsInput(array),
          html("span", { class: "muted small svd-desc" }, array.description),
        );

        toggleOn(row, () => {
          open ? openArrays.delete(array) : openArrays.add(array);
          render();
        });

        return row;
      };

      /** One copy of an array, listed under it. */
      const copyRow = (
        array: SvdRegisterArray,
        position: number,
        fullPath: boolean,
      ) => {
        const register = array.at(position);
        const positions = picked.get(array)!;
        const box = html("input", {
          type: "checkbox",
          class: "svd-check",
          checked: positions.has(position),
          "aria-label": `Select ${register.path}`,
        });

        box.addEventListener("change", () => {
          positions.set(position, box.checked);
          render();
        });

        return html(
          "label",
          { class: "svd-reg svd-copy", role: "treeitem" },
          box,
          html(
            "b",
            { class: "mono" },
            fullPath
              ? register.path
              : register.path.slice(register.peripheral.length + 1),
          ),
          html(
            "span",
            { class: "muted mono small" },
            `#${position} · ${hexAddress(register.address)}`,
          ),
        );
      };

      const render = () => {
        const scroll = list.scrollTop;
        list.replaceChildren();
        let rows = 0;
        let hiddenRegisters = 0;
        let hiddenCopies = 0;

        for (const { peripheral, peripheralHit, registers } of filtered()) {
          // a search that only matches registers opens their peripheral
          const open =
            expanded.has(peripheral) || (!!query() && !peripheralHit);
          const total = countIn(peripheral.registers);
          const head = html(
            "div",
            {
              class: "svd-periph",
              role: "treeitem",
              "aria-expanded": open ? "true" : "false",
              tabindex: 0,
            },
            icon(open ? ChevronDown : ChevronRight, 15, "muted"),
            peripheralBox(peripheral),
            html("b", { class: "mono" }, peripheral.name),
            html(
              "span",
              { class: "muted mono small" },
              `${hexAddress(peripheral.baseAddress)}${peripheral.count > 1 ? ` · ×${peripheral.count.toLocaleString("en-US")}` : ""} · ${plural(total, "register")}`,
            ),
            html(
              "span",
              { class: "muted small svd-desc" },
              [peripheral.groupName, peripheral.description]
                .filter(Boolean)
                .join(" · "),
            ),
          );

          toggleOn(head, () => {
            open ? expanded.delete(peripheral) : expanded.add(peripheral);
            render();
          });

          list.append(head);
          if (!open) continue;

          for (const array of registers) {
            if (rows >= MAX_ROWS) {
              hiddenRegisters++;
              continue;
            }

            list.append(
              array.count === 1 ? registerRow(array) : arrayRow(array),
            );
            rows++;
            if (array.count === 1 || !openArrays.has(array)) continue;

            const shown = Math.min(array.count, Math.max(0, MAX_ROWS - rows));
            for (let position = 0; position < shown; position++)
              list.append(copyRow(array, position, peripheral.count > 1));
            rows += shown;
            hiddenCopies += array.count - shown;
          }
        }

        if (hiddenRegisters)
          list.append(
            html(
              "p",
              { class: "muted small svd-more" },
              `${hiddenRegisters.toLocaleString("en-US")} more registers aren't shown; type in the filter to narrow the list.`,
            ),
          );

        if (hiddenCopies)
          list.append(
            html(
              "p",
              { class: "muted small svd-more" },
              `${plural(hiddenCopies, "more copy", "more copies")} aren't listed; type their positions in the array's box, e.g. 0-99.`,
            ),
          );

        if (!list.childElementCount)
          list.append(
            html(
              "p",
              { class: "muted small svd-more" },
              "Nothing matches the filter.",
            ),
          );

        list.scrollTop = scroll;
        updateCount();
      };

      search.addEventListener("input", render);
      const problems = device.warnings.length;
      append(body, [
        html(
          "p",
          { class: "muted small" },
          `${fileName}${device.description ? ` — ${device.description}` : ""}. ` +
            "Tick registers to add them as values (named after the register, set to its reset value, with its fields), or save their layouts as templates. Open an array to tick single copies, or type which ones in its box.",
        ),
        html("div", { class: "svd-top" }, search, allButton, count),
        list,
        problems
          ? html(
              "p",
              {
                class: "expr-note small",
                tip: device.warnings.join("\n"),
              },
              `${plural(problems, "problem")} in the file (hover for details).`,
            )
          : null,
      ]);
      render();
      return [
        button({ label: "Cancel", onClick: () => close(null) }),
        templatesButton,
        addButton,
      ];
    },
  });
}
