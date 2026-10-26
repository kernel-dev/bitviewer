// Small UI kit: element builder, icons, segmented control, switch, popup
// menus, dialogs, tooltips, toasts and the validated number input.
import { Check, createElement, type IconNode, X } from "lucide";
import { type Base, formatInt, ParseError, parseValue } from "../core/numfmt";
import { play } from "./sound";

// ------------------------------------------------------------------ elements
type Child = Node | string | number | null | undefined | false;
type Props = Record<string, any> & {
  class?: string;
  style?: string;
  tip?: string | (() => string);
};

export function html<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  properties: Props = {},
  ...children: Child[]
) {
  const element = document.createElement(tagName);

  for (const [attributeName, value] of Object.entries(properties)) {
    if (value === undefined || value === null || value === false) continue;

    if (attributeName === "class") element.className = value;
    else if (attributeName === "style") element.setAttribute("style", value);
    else if (attributeName === "tip") setTip(element, value);
    else if (attributeName.startsWith("on") && typeof value === "function")
      element.addEventListener(attributeName.slice(2).toLowerCase(), value);
    else if (attributeName === "dataset") Object.assign(element.dataset, value);
    else if (attributeName in element && typeof value !== "string")
      (element as any)[attributeName] = value;
    else
      element.setAttribute(attributeName, value === true ? "" : String(value));
  }

  append(element, children);

  return element;
}

export function append(element: Element, children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;

    element.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
}

export function icon(node: IconNode, size = 16, className = ""): SVGElement {
  const svg = createElement(node, {
    width: size,
    height: size,
    "stroke-width": 2,
    class: `ico ${className}`,
  });

  svg.setAttribute("aria-hidden", "true");

  return svg;
}

/** Button with an optional icon and label. */
export function button(options: {
  icon?: IconNode;
  label?: string;
  tip?: string;
  className?: string;
  onClick?: (event: MouseEvent) => void;
  size?: number;
}): HTMLButtonElement {
  const buttonElement = html("button", {
    class: `btn ${options.className ?? ""}`,
    type: "button",
    tip: options.tip,
  });

  if (options.icon)
    buttonElement.append(icon(options.icon, options.size ?? 16));

  if (options.label) buttonElement.append(html("span", {}, options.label));

  if (options.onClick) buttonElement.addEventListener("click", options.onClick);

  if (!options.label) {
    buttonElement.classList.add("icon-only");
    if (options.tip)
      buttonElement.setAttribute(
        "aria-label",
        options.tip.replace(/\s*\(.*\)$/, ""),
      ); // drop "(Ctrl+X)"
  }

  return buttonElement;
}

// ------------------------------------------------------------------ segmented control
export interface Segmented<T> {
  element: HTMLElement;
  value: T | undefined;
  set(value: T): void;
}

/** Pill-shaped segmented control. `checkable: false` makes it a row of
 *  action buttons that fire `onPick` without keeping a selection. */
export function segmented<T>(
  options: { value: T; label?: string; icon?: IconNode; tip?: string }[],
  config: {
    value?: T;
    checkable?: boolean;
    onPick: (value: T) => void;
    className?: string;
  },
): Segmented<T> {
  const checkable = config.checkable ?? true;
  const element = html("div", {
    class: `seg ${config.className ?? ""}`,
    role: checkable ? "radiogroup" : "group",
  });
  const buttons = new Map<T, HTMLButtonElement>();
  const control: Segmented<T> = {
    element,
    value: config.value,
    set(value: T) {
      control.value = value;
      if (checkable) {
        for (const [key, buttonElement] of buttons) {
          buttonElement.classList.toggle("on", key === value);
          buttonElement.setAttribute(
            "aria-checked",
            key === value ? "true" : "false",
          );
        }
      }
    },
  };

  for (const option of options) {
    const buttonElement = html("button", {
      type: "button",
      class: "seg-btn",
      tip: option.tip,
      role: checkable ? "radio" : undefined,
      "aria-label": option.label ? undefined : option.tip,
    });

    if (option.icon) buttonElement.append(icon(option.icon, 14));
    if (option.label) buttonElement.append(html("span", {}, option.label));

    buttonElement.addEventListener("click", () => {
      if (checkable) {
        const changed = control.value !== option.value;
        control.set(option.value);
        if (changed) {
          play("toggle");
          config.onPick(option.value);
        }
      } else {
        config.onPick(option.value);
      }
    });

    buttons.set(option.value, buttonElement);
    element.append(buttonElement);
  }

  if (config.value !== undefined) control.set(config.value);

  return control;
}

// ------------------------------------------------------------------ switch
export function toggleSwitch(
  checked: boolean,
  onChange: (value: boolean) => void,
): HTMLElement {
  const input = html("input", {
    type: "checkbox",
    checked,
    class: "switch-input",
  });

  input.addEventListener("change", () => {
    onChange(input.checked);
    play("toggle");
  });

  return html(
    "label",
    { class: "switch" },
    input,
    html(
      "span",
      { class: "switch-track" },
      html("span", { class: "switch-knob" }),
    ),
  );
}

// ------------------------------------------------------------------ tooltips
const tooltips = new WeakMap<Element, string | (() => string)>();
export function setTip(
  element: Element,
  tip: string | (() => string) | undefined,
) {
  if (tip) tooltips.set(element, tip);
  else tooltips.delete(element);
}

let tipEl: HTMLElement | null = null;
let tipTimer = 0;
let tipTarget: Element | null = null;

function findTip(target: EventTarget | null): Element | null {
  let element = target instanceof Element ? target : null;
  while (element && !tooltips.has(element)) element = element.parentElement;
  return element;
}

export function showTip(target: Element, text: string, x?: number, y?: number) {
  if (!text) return hideTip();

  tipEl ??= document.body.appendChild(
    html("div", { class: "tooltip", role: "tooltip" }),
  );
  tipEl.textContent = text;
  tipEl.classList.add("show");

  const rect = target.getBoundingClientRect();
  const tipWidth = tipEl.offsetWidth;
  const tipHeight = tipEl.offsetHeight;

  let left =
    x !== undefined ? x + 12 : rect.left + rect.width / 2 - tipWidth / 2;
  let top = y !== undefined ? y + 18 : rect.bottom + 8;
  if (top + tipHeight > innerHeight - 6)
    top = (y !== undefined ? y - 10 : rect.top - 8) - tipHeight;

  left = Math.max(6, Math.min(left, innerWidth - tipWidth - 6));

  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${Math.max(6, top)}px`;
}

export function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  tipEl?.classList.remove("show");
}

export function installTooltips() {
  let lastX = 0;
  let lastY = 0;

  document.addEventListener("pointerover", (event) => {
    const target = findTip(event.target);
    if (target === tipTarget) return;

    hideTip();

    if (!target || event.buttons) return;

    tipTarget = target;
    tipTimer = window.setTimeout(() => {
      const tip = tooltips.get(target);
      const text = typeof tip === "function" ? tip() : tip;
      // bit cells follow the pointer, everything else anchors below the element
      if (text)
        target.classList.contains("bit")
          ? showTip(target, text, lastX, lastY)
          : showTip(target, text);
    }, 450);
  });

  document.addEventListener("pointermove", (event) => {
    lastX = event.clientX;
    lastY = event.clientY;
  });
  document.addEventListener("pointerdown", hideTip, true);
  document.addEventListener("wheel", hideTip, { passive: true });
  document.addEventListener("keydown", hideTip, true);
}

// ------------------------------------------------------------------ toast
let toastEl: HTMLElement | null = null;
let toastTimer = 0;
export function toast(message: string, kind: "info" | "ok" | "error" = "info") {
  // role=status: screen readers announce each message without moving focus
  toastEl ??= document.body.appendChild(
    html("div", { class: "toast", role: "status", "aria-live": "polite" }),
  );
  toastEl.textContent = message;
  toastEl.dataset.kind = kind;
  toastEl.classList.add("show");

  clearTimeout(toastTimer);

  toastTimer = window.setTimeout(() => toastEl?.classList.remove("show"), 2600);
}

// ------------------------------------------------------------------ popup menus
export type MenuItem =
  | "sep"
  | {
      label: string;
      icon?: IconNode;
      action?: () => void;
      disabled?: boolean;
      danger?: boolean;
      shortcut?: string;
      submenu?: MenuItem[];
      swatch?: string;
      /** Shows a checkmark (true) or an empty slot (false) instead of an icon. */
      checked?: boolean;
      /** Keep the menu open after clicking (for checkbox lists). */
      keepOpen?: boolean;
    };

const openMenus: HTMLElement[] = [];

export function closeMenus(depth = 0) {
  for (const menuElement of openMenus.splice(depth)) menuElement.remove();

  document.querySelectorAll(".menu-open").forEach((element) => {
    if (depth === 0) element.classList.remove("menu-open");
  });
}

/** Opens a menu at a point, or under an anchor element. */
export function openMenu(
  items: MenuItem[],
  anchor: { x: number; y: number } | HTMLElement,
  depth = 0,
): HTMLElement {
  closeMenus(depth);
  const menu = html("div", { class: "menu", role: "menu" });

  for (const item of items) {
    if (item === "sep") {
      menu.append(html("div", { class: "menu-sep" }));
      continue;
    }

    const row = html(
      "button",
      {
        type: "button",
        class: `menu-item${item.danger ? " danger" : ""}`,
        disabled: !!item.disabled,
        role: "menuitem",
      },
      item.checked !== undefined
        ? item.checked
          ? icon(Check, 15, "menu-check")
          : html("span", { class: "menu-ico-pad" })
        : item.swatch
          ? html("span", {
              class: "menu-swatch",
              style: `background:${item.swatch}`,
            })
          : item.icon
            ? icon(item.icon, 15)
            : html("span", { class: "menu-ico-pad" }),
      html("span", { class: "menu-label" }, item.label),
      item.shortcut ? html("span", { class: "menu-kbd" }, item.shortcut) : null,
      item.submenu ? html("span", { class: "menu-arrow" }, "›") : null,
    );

    if (item.submenu) {
      const submenu = item.submenu;
      const openSub = () => {
        const rect = row.getBoundingClientRect();
        openMenu(
          submenu,
          { x: rect.right + 2, y: rect.top - 5 },
          depth + 1,
        ).dataset.parentRow = "1";
      };

      row.addEventListener("pointerenter", openSub);
      row.addEventListener("click", openSub);
    } else {
      row.addEventListener("pointerenter", () => closeMenus(depth + 1));
      row.addEventListener("click", () => {
        if (item.keepOpen) {
          item.action?.();
          if (item.checked !== undefined) {
            item.checked = !item.checked;
            row.firstElementChild?.replaceWith(
              item.checked
                ? icon(Check, 15, "menu-check")
                : html("span", { class: "menu-ico-pad" }),
            );
          }
          return;
        }
        closeMenus();
        item.action?.();
      });
    }

    menu.append(row);
  }

  document.body.append(menu);
  openMenus.push(menu);

  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  let x: number;
  let y: number;

  if (anchor instanceof HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    anchor.classList.add("menu-open");

    x =
      rect.right - menuWidth >= 6 && rect.left + menuWidth > innerWidth - 6
        ? rect.right - menuWidth
        : rect.left;
    y = rect.bottom + 6;

    if (y + menuHeight > innerHeight - 6) y = rect.top - menuHeight - 6;
  } else {
    x = anchor.x;
    y = anchor.y;

    if (x + menuWidth > innerWidth - 6) x = innerWidth - menuWidth - 6;
    if (y + menuHeight > innerHeight - 6)
      y = Math.max(6, innerHeight - menuHeight - 6);
  }

  menu.style.left = `${Math.max(6, x)}px`;
  menu.style.top = `${Math.max(6, y)}px`;
  requestAnimationFrame(() => menu.classList.add("show"));
  (
    menu.querySelector(".menu-item:not(:disabled)") as HTMLElement | null
  )?.focus({ preventScroll: true });

  return menu;
}

export function menusOpen(): boolean {
  return openMenus.length > 0;
}

export function installMenus() {
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!openMenus.length) return;
      const target = event.target as Element;
      if (!target.closest(".menu") && !target.closest(".menu-open"))
        closeMenus();
    },
    true,
  );

  window.addEventListener("blur", () => closeMenus());
  window.addEventListener("resize", () => closeMenus());

  document.addEventListener(
    "keydown",
    (event) => {
      if (!openMenus.length) return;
      const menu = openMenus[openMenus.length - 1];
      const items = [
        ...menu.querySelectorAll<HTMLButtonElement>(
          ".menu-item:not(:disabled)",
        ),
      ];
      const focusedIndex = items.indexOf(
        document.activeElement as HTMLButtonElement,
      );

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenus(openMenus.length - 1);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const itemCount = items.length;
        items[
          (focusedIndex +
            (event.key === "ArrowDown" ? 1 : itemCount - 1) +
            itemCount) %
            itemCount
        ]?.focus();
      }
    },
    true,
  );
}

// ------------------------------------------------------------------ dialogs
/** Open dialogs, bottom first. Only the top one reacts to keys. */
const modalStack: HTMLElement[] = [];
let modalCount = 0;
export function modalOpen(): boolean {
  return modalStack.length > 0;
}

const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex='-1'])";

export function modal<T>(options: {
  title: string;
  icon?: IconNode;
  wide?: boolean;
  build: (
    body: HTMLElement,
    close: (result: T) => void,
  ) => HTMLElement[] | undefined; // returns footer buttons
  cancelValue: T;
  /** For forms: true when there are edits that Esc, the X or a click outside
   *  would throw away. The user is asked first. */
  hasChanges?: () => boolean;
}): Promise<T> {
  closeMenus();
  hideTip();

  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const titleId = `modal-title-${++modalCount}`;
    const body = html("div", { class: "modal-body" });
    const footer = html("div", { class: "modal-footer" });
    const box = html(
      "div",
      {
        class: `modal${options.wide ? " wide" : ""}`,
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
      },
      html(
        "div",
        { class: "modal-head" },
        options.icon
          ? html("span", { class: "modal-ico" }, icon(options.icon, 18))
          : null,
        html("h2", { id: titleId }, options.title),
        button({
          icon: X,
          className: "ghost modal-x",
          tip: "Close (Esc)",
          onClick: () => void dismiss(),
        }),
      ),
      body,
      footer,
    );
    const backdrop = html("div", { class: "backdrop" }, box);
    modalStack.push(box);

    let done = false;
    const close = (result: T) => {
      if (done) return;
      done = true;
      modalStack.splice(modalStack.indexOf(box), 1);
      document.removeEventListener("keydown", onKey, true);
      backdrop.classList.remove("show");
      setTimeout(() => backdrop.remove(), 140);
      prevFocus?.focus?.({ preventScroll: true });
      resolve(result);
    };

    /** Esc, the X or a click outside: asks first when a form has edits. */
    let asking = false;
    const dismiss = async () => {
      if (done || asking) return;
      if (options.hasChanges?.()) {
        asking = true;
        const answer = await ask(
          "Discard changes?",
          "Your changes in this dialog haven't been saved.",
          [
            { id: "keep", label: "Keep editing" },
            { id: "discard", label: "Discard", className: "danger-btn" },
          ],
          "keep",
        );
        asking = false;
        if (answer !== "discard") return;
      }
      close(options.cancelValue);
    };

    const onKey = (event: KeyboardEvent) => {
      // every open dialog listens on the document, so only the top one acts
      if (modalStack[modalStack.length - 1] !== box) return;
      if (event.key === "Escape" && !menusOpen()) {
        event.preventDefault();
        event.stopPropagation();
        void dismiss();
      } else if (event.key === "Tab") {
        // keep keyboard focus inside the dialog
        const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (element) => element.offsetParent !== null,
        );
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !box.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (active === last || !box.contains(active))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("pointerdown", (event) => {
      if (event.target === backdrop) void dismiss();
    });

    const buttons = options.build(body, close);
    if (buttons) footer.append(...buttons);
    else footer.remove();

    document.body.append(backdrop);

    requestAnimationFrame(() => backdrop.classList.add("show"));

    const focusable =
      body.querySelector<HTMLElement>("input, textarea, [autofocus]") ??
      footer.querySelector<HTMLElement>(".primary");

    focusable?.focus();
    if (focusable instanceof HTMLInputElement) focusable.select();
  });
}

/** Message box with custom buttons. Resolves to the clicked button's id, or `cancel`. */
export function ask(
  title: string,
  message: string,
  buttons: { id: string; label: string; className?: string }[],
  cancel = "cancel",
  iconNode?: IconNode,
): Promise<string> {
  return modal<string>({
    title,
    icon: iconNode,
    cancelValue: cancel,
    build(body, close) {
      body.append(html("p", { class: "modal-text" }, message));
      return buttons.map((buttonSpec) =>
        button({
          label: buttonSpec.label,
          className: buttonSpec.className ?? "",
          onClick: () => close(buttonSpec.id),
        }),
      );
    },
  });
}

export function prompt(
  title: string,
  label: string,
  value: string,
  iconNode?: IconNode,
): Promise<string | null> {
  return modal<string | null>({
    title,
    icon: iconNode,
    cancelValue: null,
    build(body, close) {
      const input = html("input", { class: "field", value, spellcheck: false });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") close(input.value);
      });
      body.append(html("label", { class: "modal-label" }, label), input);
      return [
        button({ label: "Cancel", onClick: () => close(null) }),
        button({
          label: "OK",
          className: "primary",
          onClick: () => close(input.value),
        }),
      ];
    },
  });
}

// ------------------------------------------------------------------ number input
/** Validated integer field. Commits live while typing; invalid input is
 *  marked red with the reason as tooltip; Esc / blur restores the value. */
export class NumberInput {
  element: HTMLInputElement;
  private value = 0n;
  private tipText: string;
  private error: string | null = null;

  constructor(
    private width: number,
    public base: Base,
    private onCommit: (value: bigint) => void,
    private opts: {
      allowNegative?: boolean;
      group?: boolean;
      className?: string;
    } = {},
  ) {
    this.tipText =
      "Type a value in the selected base.\nPrefixes 0x / 0b / 0o override it (in HEX, 0b… is read as hex).\n" +
      "Spaces and _ are ignored." +
      (opts.allowNegative ? "\nA leading - stores the two's complement." : "");

    this.element = html("input", {
      class: `field mono ${opts.className ?? ""}`,
      spellcheck: false,
      autocomplete: "off",
    });

    setTip(this.element, () =>
      this.error ? `⚠ ${this.error}\n\n${this.tipText}` : this.tipText,
    );

    this.element.addEventListener("input", () => this.onEdited());
    this.element.addEventListener("blur", () => this.render());
    this.element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.render();
        this.element.blur();
      } else if (event.key === "Enter") {
        this.element.blur();
      }
    });
  }

  setFormat(width: number, base: Base) {
    if (width !== this.width || base !== this.base) {
      this.width = width;
      this.base = base;
      this.render();
    }
  }

  /** While the user types, the text already equals the committed value, so
   *  leave it alone. Any other change (bit flip, operation) re-renders. */
  setValue(value: bigint) {
    const changed = value !== this.value;
    this.value = value;
    if (changed || document.activeElement !== this.element) this.render();
  }

  private render() {
    this.element.value = formatInt(this.value, this.base, this.width, {
      group: this.opts.group,
    });
    this.mark(null);
  }

  private onEdited() {
    let value: bigint;
    try {
      value = parseValue(
        this.element.value,
        this.base,
        this.width,
        this.opts.allowNegative,
      );
    } catch (error) {
      if (error instanceof ParseError)
        this.mark(error.incomplete ? null : error.message);
      return;
    }

    this.mark(null);
    this.value = value;
    this.onCommit(value);
  }

  private mark(error: string | null) {
    if (error && !this.error) play("error");

    this.error = error;
    this.element.classList.toggle("invalid", !!error);

    if (error && document.activeElement === this.element)
      showTip(this.element, error);
    else if (!error && document.activeElement === this.element) hideTip();
  }
}
