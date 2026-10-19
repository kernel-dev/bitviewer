// Small UI kit: element builder, icons, segmented control, switch, popup
// menus, dialogs, tooltips, toasts and the validated number input.
import { Check, createElement, type IconNode, X } from "lucide";
import { type Base, formatInt, ParseError, parseValue } from "./numfmt";
import { play } from "./sound";

// ------------------------------------------------------------------ elements
type Child = Node | string | number | null | undefined | false;
type Props = Record<string, any> & { class?: string; style?: string; tip?: string | (() => string) };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.setAttribute("style", v);
    else if (k === "tip") setTip(el, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && typeof v !== "string") (el as any)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function icon(node: IconNode, size = 16, cls = ""): SVGElement {
  const svg = createElement(node, { width: size, height: size, "stroke-width": 2, class: `ico ${cls}` });
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

/** Button with an optional icon and label. */
export function button(opts: {
  icon?: IconNode;
  label?: string;
  tip?: string;
  cls?: string;
  onClick?: (e: MouseEvent) => void;
  size?: number;
}): HTMLButtonElement {
  const b = h("button", { class: `btn ${opts.cls ?? ""}`, type: "button", tip: opts.tip });
  if (opts.icon) b.append(icon(opts.icon, opts.size ?? 16));
  if (opts.label) b.append(h("span", {}, opts.label));
  if (opts.onClick) b.addEventListener("click", opts.onClick);
  if (!opts.label) b.classList.add("icon-only");
  return b;
}

// ------------------------------------------------------------------ segmented control
export interface Segmented<T> {
  el: HTMLElement;
  value: T | undefined;
  set(v: T): void;
}

/** Pill-shaped segmented control. `checkable: false` makes it a row of
 *  action buttons that fire `onPick` without keeping a selection. */
export function segmented<T>(
  options: { value: T; label?: string; icon?: IconNode; tip?: string }[],
  opts: { value?: T; checkable?: boolean; onPick: (v: T) => void; cls?: string },
): Segmented<T> {
  const checkable = opts.checkable ?? true;
  const el = h("div", { class: `seg ${opts.cls ?? ""}`, role: checkable ? "radiogroup" : "group" });
  const buttons = new Map<T, HTMLButtonElement>();
  const api: Segmented<T> = {
    el,
    value: opts.value,
    set(v: T) {
      api.value = v;
      if (checkable) for (const [k, b] of buttons) b.classList.toggle("on", k === v);
    },
  };
  for (const o of options) {
    const b = h("button", { type: "button", class: "seg-btn", tip: o.tip });
    if (o.icon) b.append(icon(o.icon, 14));
    if (o.label) b.append(h("span", {}, o.label));
    b.addEventListener("click", () => {
      if (checkable) {
        const changed = api.value !== o.value;
        api.set(o.value);
        if (changed) {
          play("toggle");
          opts.onPick(o.value);
        }
      } else opts.onPick(o.value);
    });
    buttons.set(o.value, b);
    el.append(b);
  }
  if (opts.value !== undefined) api.set(opts.value);
  return api;
}

// ------------------------------------------------------------------ switch
export function toggleSwitch(checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h("input", { type: "checkbox", checked, class: "switch-input" });
  input.addEventListener("change", () => {
    onChange(input.checked);
    play("toggle");
  });
  return h(
    "label",
    { class: "switch" },
    input,
    h("span", { class: "switch-track" }, h("span", { class: "switch-knob" })),
  );
}

// ------------------------------------------------------------------ tooltips
const tips = new WeakMap<Element, string | (() => string)>();
export function setTip(el: Element, tip: string | (() => string) | undefined) {
  if (tip) tips.set(el, tip);
  else tips.delete(el);
}

let tipEl: HTMLElement | null = null;
let tipTimer = 0;
let tipTarget: Element | null = null;

function findTip(t: EventTarget | null): Element | null {
  let el = t instanceof Element ? t : null;
  while (el && !tips.has(el)) el = el.parentElement;
  return el;
}

export function showTip(target: Element, text: string, x?: number, y?: number) {
  if (!text) return hideTip();
  tipEl ??= document.body.appendChild(h("div", { class: "tooltip", role: "tooltip" }));
  tipEl.textContent = text;
  tipEl.classList.add("show");
  const r = target.getBoundingClientRect();
  const tw = tipEl.offsetWidth;
  const th = tipEl.offsetHeight;
  let left = x !== undefined ? x + 12 : r.left + r.width / 2 - tw / 2;
  let top = y !== undefined ? y + 18 : r.bottom + 8;
  if (top + th > innerHeight - 6) top = (y !== undefined ? y - 10 : r.top - 8) - th;
  left = Math.max(6, Math.min(left, innerWidth - tw - 6));
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
  document.addEventListener("pointerover", (e) => {
    const t = findTip(e.target);
    if (t === tipTarget) return;
    hideTip();
    if (!t || e.buttons) return;
    tipTarget = t;
    tipTimer = window.setTimeout(() => {
      const tip = tips.get(t);
      const text = typeof tip === "function" ? tip() : tip;
      // bit cells follow the pointer, everything else anchors below the element
      if (text) t.classList.contains("bit") ? showTip(t, text, lastX, lastY) : showTip(t, text);
    }, 450);
  });
  document.addEventListener("pointermove", (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
  });
  document.addEventListener("pointerdown", hideTip, true);
  document.addEventListener("wheel", hideTip, { passive: true });
  document.addEventListener("keydown", hideTip, true);
}

// ------------------------------------------------------------------ toast
let toastEl: HTMLElement | null = null;
let toastTimer = 0;
export function toast(message: string, kind: "info" | "ok" | "error" = "info") {
  toastEl ??= document.body.appendChild(h("div", { class: "toast" }));
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
  for (const m of openMenus.splice(depth)) m.remove();
  document.querySelectorAll(".menu-open").forEach((el) => {
    if (depth === 0) el.classList.remove("menu-open");
  });
}

/** Opens a menu at a point, or under an anchor element. */
export function openMenu(items: MenuItem[], at: { x: number; y: number } | HTMLElement, depth = 0): HTMLElement {
  closeMenus(depth);
  const menu = h("div", { class: "menu", role: "menu" });
  for (const it of items) {
    if (it === "sep") {
      menu.append(h("div", { class: "menu-sep" }));
      continue;
    }
    const row = h(
      "button",
      { type: "button", class: `menu-item${it.danger ? " danger" : ""}`, disabled: !!it.disabled, role: "menuitem" },
      it.checked !== undefined
        ? it.checked
          ? icon(Check, 15, "menu-check")
          : h("span", { class: "menu-ico-pad" })
        : it.swatch
          ? h("span", { class: "menu-swatch", style: `background:${it.swatch}` })
          : it.icon
            ? icon(it.icon, 15)
            : h("span", { class: "menu-ico-pad" }),
      h("span", { class: "menu-label" }, it.label),
      it.shortcut ? h("span", { class: "menu-kbd" }, it.shortcut) : null,
      it.submenu ? h("span", { class: "menu-arrow" }, "›") : null,
    );
    if (it.submenu) {
      const sub = it.submenu;
      const openSub = () => {
        const r = row.getBoundingClientRect();
        openMenu(sub, { x: r.right + 2, y: r.top - 5 }, depth + 1).dataset.parentRow = "1";
      };
      row.addEventListener("pointerenter", openSub);
      row.addEventListener("click", openSub);
    } else {
      row.addEventListener("pointerenter", () => closeMenus(depth + 1));
      row.addEventListener("click", () => {
        if (it.keepOpen) {
          it.action?.();
          if (it.checked !== undefined) {
            it.checked = !it.checked;
            row.firstElementChild?.replaceWith(
              it.checked ? icon(Check, 15, "menu-check") : h("span", { class: "menu-ico-pad" }),
            );
          }
          return;
        }
        closeMenus();
        it.action?.();
      });
    }
    menu.append(row);
  }
  document.body.append(menu);
  openMenus.push(menu);

  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x: number;
  let y: number;
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    at.classList.add("menu-open");
    x = r.right - mw >= 6 && r.left + mw > innerWidth - 6 ? r.right - mw : r.left;
    y = r.bottom + 6;
    if (y + mh > innerHeight - 6) y = r.top - mh - 6;
  } else {
    x = at.x;
    y = at.y;
    if (x + mw > innerWidth - 6) x = innerWidth - mw - 6;
    if (y + mh > innerHeight - 6) y = Math.max(6, innerHeight - mh - 6);
  }
  menu.style.left = `${Math.max(6, x)}px`;
  menu.style.top = `${Math.max(6, y)}px`;
  requestAnimationFrame(() => menu.classList.add("show"));
  (menu.querySelector(".menu-item:not(:disabled)") as HTMLElement | null)?.focus({ preventScroll: true });
  return menu;
}

export function menusOpen(): boolean {
  return openMenus.length > 0;
}

export function installMenus() {
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!openMenus.length) return;
      const t = e.target as Element;
      if (!t.closest(".menu") && !t.closest(".menu-open")) closeMenus();
    },
    true,
  );
  window.addEventListener("blur", () => closeMenus());
  window.addEventListener("resize", () => closeMenus());
  document.addEventListener(
    "keydown",
    (e) => {
      if (!openMenus.length) return;
      const menu = openMenus[openMenus.length - 1];
      const items = [...menu.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)")];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMenus(openMenus.length - 1);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = items.length;
        items[(i + (e.key === "ArrowDown" ? 1 : n - 1) + n) % n]?.focus();
      }
    },
    true,
  );
}

// ------------------------------------------------------------------ dialogs
let modalDepth = 0;
export function modalOpen(): boolean {
  return modalDepth > 0;
}

/** Generic modal. `build` fills the body and receives `close(result)`. */
export function modal<T>(opts: {
  title: string;
  icon?: IconNode;
  wide?: boolean;
  build: (body: HTMLElement, close: (r: T) => void) => HTMLElement[] | undefined; // returns footer buttons
  cancelValue: T;
}): Promise<T> {
  closeMenus();
  hideTip();
  return new Promise((resolve) => {
    modalDepth++;
    const prevFocus = document.activeElement as HTMLElement | null;
    const body = h("div", { class: "modal-body" });
    const footer = h("div", { class: "modal-footer" });
    const box = h(
      "div",
      { class: `modal${opts.wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true" },
      h(
        "div",
        { class: "modal-head" },
        opts.icon ? h("span", { class: "modal-ico" }, icon(opts.icon, 18)) : null,
        h("h2", {}, opts.title),
        button({ icon: X, cls: "ghost modal-x", tip: "Close (Esc)", onClick: () => close(opts.cancelValue) }),
      ),
      body,
      footer,
    );
    const backdrop = h("div", { class: "backdrop" }, box);
    let done = false;
    const close = (r: T) => {
      if (done) return;
      done = true;
      modalDepth--;
      document.removeEventListener("keydown", onKey, true);
      backdrop.classList.remove("show");
      setTimeout(() => backdrop.remove(), 140);
      prevFocus?.focus?.({ preventScroll: true });
      resolve(r);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !menusOpen()) {
        e.preventDefault();
        e.stopPropagation();
        close(opts.cancelValue);
      }
    };
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) close(opts.cancelValue);
    });
    const buttons = opts.build(body, close);
    if (buttons) footer.append(...buttons);
    else footer.remove();
    document.body.append(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("show"));
    const focusable =
      body.querySelector<HTMLElement>("input, [autofocus]") ?? footer.querySelector<HTMLElement>(".primary");
    focusable?.focus();
    if (focusable instanceof HTMLInputElement) focusable.select();
  });
}

/** Message box with custom buttons. Resolves to the clicked button's id, or `cancel`. */
export function ask(
  title: string,
  message: string,
  buttons: { id: string; label: string; cls?: string }[],
  cancel = "cancel",
  ico?: IconNode,
): Promise<string> {
  return modal<string>({
    title,
    icon: ico,
    cancelValue: cancel,
    build(body, close) {
      body.append(h("p", { class: "modal-text" }, message));
      return buttons.map((b) => button({ label: b.label, cls: b.cls ?? "", onClick: () => close(b.id) }));
    },
  });
}

export function prompt(title: string, label: string, value: string, ico?: IconNode): Promise<string | null> {
  return modal<string | null>({
    title,
    icon: ico,
    cancelValue: null,
    build(body, close) {
      const input = h("input", { class: "field", value, spellcheck: false });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") close(input.value);
      });
      body.append(h("label", { class: "modal-label" }, label), input);
      return [
        button({ label: "Cancel", onClick: () => close(null) }),
        button({ label: "OK", cls: "primary", onClick: () => close(input.value) }),
      ];
    },
  });
}

// ------------------------------------------------------------------ number input
/** Validated integer field. Commits live while typing; invalid input is
 *  marked red with the reason as tooltip; Esc / blur restores the value. */
export class NumberInput {
  el: HTMLInputElement;
  private value = 0n;
  private tipText: string;
  private error: string | null = null;

  constructor(
    private width: number,
    public base: Base,
    private onCommit: (v: bigint) => void,
    private opts: { allowNegative?: boolean; group?: boolean; cls?: string } = {},
  ) {
    this.tipText =
      "Type a value in the selected base.\nPrefixes 0x / 0b / 0o override it (in HEX, 0b… is read as hex).\n" +
      "Spaces and _ are ignored." +
      (opts.allowNegative ? "\nA leading - stores the two's complement." : "");
    this.el = h("input", { class: `field mono ${opts.cls ?? ""}`, spellcheck: false, autocomplete: "off" });
    setTip(this.el, () => (this.error ? `⚠ ${this.error}\n\n${this.tipText}` : this.tipText));
    this.el.addEventListener("input", () => this.onEdited());
    this.el.addEventListener("blur", () => this.render());
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.render();
        this.el.blur();
      } else if (e.key === "Enter") this.el.blur();
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
  setValue(v: bigint) {
    const changed = v !== this.value;
    this.value = v;
    if (changed || document.activeElement !== this.el) this.render();
  }

  private render() {
    this.el.value = formatInt(this.value, this.base, this.width, { group: this.opts.group });
    this.mark(null);
  }

  private onEdited() {
    let v: bigint;
    try {
      v = parseValue(this.el.value, this.base, this.width, this.opts.allowNegative);
    } catch (e) {
      if (e instanceof ParseError) this.mark(e.incomplete ? null : e.message);
      return;
    }
    this.mark(null);
    this.value = v;
    this.onCommit(v);
  }

  private mark(error: string | null) {
    if (error && !this.error) play("error");
    this.error = error;
    this.el.classList.toggle("invalid", !!error);
    if (error && document.activeElement === this.el) showTip(this.el, error);
    else if (!error && document.activeElement === this.el) hideTip();
  }
}
