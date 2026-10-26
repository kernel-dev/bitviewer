// Short messages at the bottom of the window.

import { html } from "./dom";

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
