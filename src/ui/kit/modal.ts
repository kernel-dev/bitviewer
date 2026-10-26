// Dialogs: modal() for custom content, ask() for a message with buttons,
// prompt() for one line of text. Dialogs stack; only the top one gets keys.

import { type IconNode, X } from "lucide";
import { button, html, icon } from "./dom";
import { closeMenus, menusOpen } from "./menu";
import { hideTip } from "./tooltip";

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
