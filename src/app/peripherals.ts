// Peripheral blocks in the workspace: the header shown above a peripheral's
// registers, and the dialogs for creating or editing a peripheral and for a
// register's offset. The App owns the data; this file only builds the UI.
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Cpu,
  Ellipsis,
  FileCode2,
  PencilLine,
  Plus,
  Trash,
  Ungroup,
} from "lucide";
import { ParseError, parseValue } from "../core/numfmt";
import type { Peripheral } from "../core/workspace";
import { button, html, icon, modal, openMenu } from "../ui/kit";

const hex = (value: bigint) => `0x${value.toString(16).toUpperCase()}`;

/** Addresses and offsets are typed in hex ("4001 1000", "0x40011000"); empty = none. */
export function parseAddress(text: string): bigint | null {
  if (!text.trim()) return null;
  return parseValue(text, 16, 64);
}

export interface PeripheralActions {
  toggle(): void;
  edit(): void;
  exportCode(): void;
  addRegister(): void;
  sortByOffset(): void;
  move(direction: -1 | 1): void;
  ungroup(): void;
  remove(): void;
}

/** The header line above a peripheral's registers. */
export function peripheralHeader(
  peripheral: Peripheral,
  registerCount: number,
  actions: PeripheralActions,
): HTMLElement {
  const more = button({
    icon: Ellipsis,
    className: "ghost sm",
    tip: "Peripheral actions",
  });
  more.addEventListener("click", () =>
    openMenu(
      [
        {
          label: "Edit name, base address, description…",
          icon: PencilLine,
          action: actions.edit,
        },
        { label: "Add register", icon: Plus, action: actions.addRegister },
        {
          label: "Sort registers by offset",
          icon: ArrowUpDown,
          action: actions.sortByOffset,
        },
        { label: "Export code…", icon: FileCode2, action: actions.exportCode },
        "sep",
        { label: "Move up", icon: ArrowUp, action: () => actions.move(-1) },
        { label: "Move down", icon: ArrowDown, action: () => actions.move(1) },
        "sep",
        {
          label: "Ungroup (keep the values)",
          icon: Ungroup,
          action: actions.ungroup,
        },
        {
          label: "Remove peripheral and its registers",
          icon: Trash,
          danger: true,
          action: actions.remove,
        },
      ],
      more,
    ),
  );
  const collapse = button({
    icon: peripheral.collapsed ? ChevronRight : ChevronDown,
    className: "ghost sm",
    tip: peripheral.collapsed ? "Show the registers" : "Hide the registers",
    onClick: actions.toggle,
  });
  collapse.setAttribute("aria-expanded", String(!peripheral.collapsed));
  return html(
    "header",
    { class: "periph-head" },
    collapse,
    html("span", { class: "periph-icon" }, icon(Cpu, 16)),
    html(
      "button",
      {
        type: "button",
        class: "periph-name",
        tip: "Edit the peripheral",
        onClick: actions.edit,
      },
      peripheral.name,
    ),
    html(
      "button",
      {
        type: "button",
        class: `badge mono${peripheral.base === null ? " warn" : ""}`,
        tip:
          peripheral.base === null
            ? "No base address yet: registers show their offsets. Click to set one."
            : "Base address. Click to change it.",
        onClick: actions.edit,
      },
      peripheral.base === null ? "no base address" : hex(peripheral.base),
    ),
    html(
      "span",
      { class: "muted small" },
      `${registerCount} register${registerCount === 1 ? "" : "s"}`,
    ),
    html(
      "span",
      { class: "muted small periph-desc", tip: peripheral.description },
      peripheral.description,
    ),
    html("div", { class: "spacer" }),
    button({
      icon: FileCode2,
      label: "Export",
      className: "ghost sm",
      tip: "Export code for the whole peripheral: a C struct, #defines or Rust",
      onClick: actions.exportCode,
    }),
    more,
  );
}

export interface PeripheralForm {
  name: string;
  base: bigint | null;
  description: string;
  /** Only asked for when a value starts a new peripheral. */
  offset?: bigint | null;
}

/** Asks for a peripheral's name, base address and description (and the
 *  first register's offset when `offset` is given). */
export function editPeripheralDialog(
  title: string,
  start: PeripheralForm,
  isTaken: (name: string) => boolean,
): Promise<PeripheralForm | null> {
  let changed = () => false;
  return modal<PeripheralForm | null>({
    title,
    icon: Cpu,
    cancelValue: null,
    hasChanges: () => changed(),
    build: (body, close) => {
      const field = (value: string, placeholder: string, mono = true) =>
        html("input", {
          class: `field${mono ? " mono" : ""}`,
          value,
          placeholder,
          spellcheck: false,
        });
      const name = field(start.name, "e.g. UART0", false);
      const base = field(
        start.base === null ? "" : hex(start.base),
        "e.g. 0x40011000 (optional)",
      );
      const description = field(start.description, "What it is", false);
      const offset =
        start.offset !== undefined
          ? field(start.offset === null ? "0x0" : hex(start.offset), "e.g. 0x4")
          : null;
      const error = html("p", { class: "expr-error" });
      const ok = button({
        label: "OK",
        className: "primary",
        onClick: () => submit(),
      });
      const read = (): PeripheralForm | null => {
        const nameText = name.value.trim();
        if (!nameText) throw new ParseError("Give the peripheral a name");
        if (isTaken(nameText))
          throw new ParseError(
            `There is already a peripheral called “${nameText}”`,
          );
        const out: PeripheralForm = {
          name: nameText,
          base: parseAddress(base.value),
          description: description.value.trim(),
        };
        if (offset) out.offset = parseAddress(offset.value);
        return out;
      };
      const check = () => {
        try {
          read();
          error.textContent = "";
          ok.disabled = false;
        } catch (caught) {
          if (!(caught instanceof ParseError)) throw caught;
          error.textContent = caught.message;
          ok.disabled = true;
        }
      };
      const submit = () => {
        try {
          const result = read();
          if (result) close(result);
        } catch {
          /* the error is already shown */
        }
      };
      for (const input of [name, base, description, offset]) {
        if (!input) continue;
        input.addEventListener("input", check);
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") submit();
        });
      }
      const label = (text: string, hint = "") =>
        html(
          "label",
          { class: "modal-label" },
          text,
          hint ? html("span", { class: "muted small" }, ` — ${hint}`) : "",
        );
      body.append(
        label("Name"),
        name,
        label("Base address", "hex; registers' addresses are base + offset"),
        base,
        label("Description"),
        description,
        ...(offset
          ? [
              label("Offset of this value", "hex, in bytes from the base"),
              offset,
            ]
          : []),
        error,
      );
      const initial = () =>
        [name, base, description, offset]
          .map((input) => input?.value ?? "")
          .join("\n");
      const startState = initial();
      changed = () => initial() !== startState;
      check();
      return [button({ label: "Cancel", onClick: () => close(null) }), ok];
    },
  });
}

/** Asks for a register's offset. Resolves to the offset, null for "none",
 *  or undefined when cancelled. */
export function askOffset(
  registerName: string,
  peripheralName: string,
  current: bigint | null,
): Promise<bigint | null | undefined> {
  return modal<bigint | null | undefined>({
    title: `Offset of “${registerName}”`,
    icon: Cpu,
    cancelValue: undefined,
    build: (body, close) => {
      const input = html("input", {
        class: "field mono",
        value: current === null ? "" : hex(current),
        placeholder: "e.g. 0x4 (empty: no offset)",
        spellcheck: false,
      });
      const error = html("p", { class: "expr-error" });
      const ok = button({
        label: "OK",
        className: "primary",
        onClick: () => submit(),
      });
      const submit = () => {
        try {
          close(parseAddress(input.value));
        } catch (caught) {
          if (!(caught instanceof ParseError)) throw caught;
          error.textContent = caught.message;
        }
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
      });
      input.addEventListener("input", () => {
        error.textContent = "";
      });
      body.append(
        html(
          "label",
          { class: "modal-label" },
          `Bytes from the start of ${peripheralName}, in hex`,
        ),
        input,
        error,
      );
      return [button({ label: "Cancel", onClick: () => close(undefined) }), ok];
    },
  });
}
