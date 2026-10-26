// "Import CMSIS-SVD…": pick registers from a device description and add them
// as values (with their fields and reset values) or save them as templates.
import { ChevronDown, ChevronRight, Cpu } from "lucide";
import {
  hexAddress,
  type SvdDevice,
  type SvdPeripheral,
  type SvdRegister,
} from "../core/svd";
import { append, button, html, icon, modal } from "../ui/kit";

export interface SvdChoice {
  action: "add" | "templates";
  registers: SvdRegister[];
}

const MAX_ROWS = 400; // register rows drawn at once; the search narrows the rest

const matches = (query: string, ...texts: string[]) =>
  texts.some((text) => text.toLowerCase().includes(query));

export function pickSvdRegisters(
  device: SvdDevice,
  fileName: string,
): Promise<SvdChoice | null> {
  const selected = new Set<SvdRegister>(
    device.peripherals.flatMap((peripheral) => peripheral.registers),
  );
  const expanded = new Set<SvdPeripheral>();
  return modal<SvdChoice | null>({
    title: `Import from ${device.name}`,
    icon: Cpu,
    wide: true,
    cancelValue: null,
    hasChanges: () => selected.size > 0,
    build: (body, close) => {
      body.parentElement?.classList.add("guide-modal");
      const registerCount = device.peripherals.reduce(
        (total, peripheral) => total + peripheral.registers.length,
        0,
      );
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
            : peripheral.registers.filter((register) =>
                matches(
                  text,
                  register.name,
                  register.path,
                  register.description,
                ),
              );
          return peripheralHit || registers.length
            ? [{ peripheral, peripheralHit, registers }]
            : [];
        });
      };

      // "Select all" acts on what the filter shows (everything when empty)
      const inScope = () => filtered().flatMap((entry) => entry.registers);
      const allSelected = (registers: SvdRegister[]) =>
        registers.length > 0 &&
        registers.every((register) => selected.has(register));
      const allButton = button({
        label: "Select all",
        className: "outline svd-all",
        tip: "Select or unselect every register the filter shows",
        onClick: () => {
          const registers = inScope();
          const unselect = allSelected(registers);
          for (const register of registers)
            unselect ? selected.delete(register) : selected.add(register);
          render();
        },
      });

      const finish = (action: SvdChoice["action"]) => {
        if (!selected.size) return;
        // keep the file's order
        const registers = device.peripherals.flatMap((peripheral) =>
          peripheral.registers.filter((register) => selected.has(register)),
        );
        close({ action, registers });
      };

      const updateCount = () => {
        const chosen = selected.size;
        count.textContent = chosen
          ? `${chosen} register${chosen === 1 ? "" : "s"} selected`
          : `${device.peripherals.length} peripherals · ${registerCount} registers`;
        addButton.disabled = templatesButton.disabled = chosen === 0;
        addButton.textContent =
          chosen > 1 ? `Add ${chosen} values` : "Add value";
        const registers = inScope();
        allButton.textContent = `${allSelected(registers) ? "Unselect" : "Select"} all${query() ? " matching" : ""}`;
        allButton.disabled = !registers.length;
      };

      const peripheralBox = (peripheral: SvdPeripheral) => {
        const chosen = peripheral.registers.filter((register) =>
          selected.has(register),
        ).length;
        const box = html("input", {
          type: "checkbox",
          class: "svd-check",
          "aria-label": `Select every register of ${peripheral.name}`,
          checked: chosen > 0 && chosen === peripheral.registers.length,
          disabled: !peripheral.registers.length,
        });
        box.indeterminate = chosen > 0 && chosen < peripheral.registers.length;
        box.addEventListener("click", (event) => event.stopPropagation());
        box.addEventListener("change", () => {
          for (const register of peripheral.registers)
            box.checked ? selected.add(register) : selected.delete(register);
          render();
        });
        return box;
      };

      const registerRow = (register: SvdRegister) => {
        const box = html("input", {
          type: "checkbox",
          class: "svd-check",
          checked: selected.has(register),
          "aria-label": `Select ${register.path}`,
        });
        box.addEventListener("change", () => {
          box.checked ? selected.add(register) : selected.delete(register);
          render();
        });
        const fieldCount = register.fields.length;
        return html(
          "label",
          {
            class: "svd-reg",
            role: "treeitem",
            tip: register.warnings.length
              ? `Left out:\n${register.warnings.join("\n")}`
              : undefined,
          },
          box,
          html(
            "b",
            { class: "mono" },
            register.path.slice(register.peripheral.length + 1),
          ),
          html(
            "span",
            { class: "muted mono small" },
            `${hexAddress(register.address)} · ${register.size}-bit · ${fieldCount} field${fieldCount === 1 ? "" : "s"}${register.warnings.length ? " ⚠" : ""}`,
          ),
          html("span", { class: "muted small svd-desc" }, register.description),
        );
      };

      const render = () => {
        const scroll = list.scrollTop;
        list.replaceChildren();
        let rows = 0;
        let hidden = 0;
        for (const { peripheral, peripheralHit, registers } of filtered()) {
          // a search that only matches registers opens their peripheral
          const open =
            expanded.has(peripheral) || (!!query() && !peripheralHit);
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
              `${hexAddress(peripheral.baseAddress)} · ${peripheral.registers.length} register${peripheral.registers.length === 1 ? "" : "s"}`,
            ),
            html(
              "span",
              { class: "muted small svd-desc" },
              [peripheral.groupName, peripheral.description]
                .filter(Boolean)
                .join(" · "),
            ),
          );
          const toggle = () => {
            open ? expanded.delete(peripheral) : expanded.add(peripheral);
            render();
          };
          head.addEventListener("click", toggle);
          head.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggle();
            }
          });
          list.append(head);
          if (!open) continue;
          for (const register of registers) {
            if (rows >= MAX_ROWS) {
              hidden++;
              continue;
            }
            list.append(registerRow(register));
            rows++;
          }
        }
        if (hidden)
          list.append(
            html(
              "p",
              { class: "muted small svd-more" },
              `${hidden} more registers aren't shown; type in the filter to narrow the list.`,
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
            "Tick registers to add them as values (named after the register, set to its reset value, with its fields), or save their layouts as templates.",
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
              `${problems} part${problems === 1 ? " was" : "s were"} skipped (hover for details).`,
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
