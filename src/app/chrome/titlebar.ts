// The title bar: logo, menu bar, the file name (the drag region) and, in the
// desktop app, the window buttons.

import { Maximize, Minimize, Minus, Square, X } from "lucide";
import * as P from "../../platform/native";
import { html, icon, menusOpen, openMenu } from "../../ui/kit";
import { logoSvg } from "../../ui/logo";
import type { App } from "../app";
import { menuLayout } from "../commands/menus";

export class Titlebar {
  readonly element: HTMLElement;
  private titleFile: HTMLElement;
  private maxBtn: HTMLButtonElement;

  constructor(app: App) {
    const menuBar = html("nav", { class: "menubar" });

    for (const [name] of menuLayout(app)) {
      // built on each open so dynamic entries (recent files, labels) are current
      const items = () =>
        app.commands.menu(
          menuLayout(app).find(([menuName]) => menuName === name)?.[1] ?? [],
        );
      const buttonElement = html(
        "button",
        { type: "button", class: "menubar-item", "data-keep-sel": "" },
        name,
      );
      buttonElement.addEventListener("click", () =>
        openMenu(items(), buttonElement),
      );

      buttonElement.addEventListener("pointerenter", () => {
        // slide between open menus like a native menu bar
        if (
          menusOpen() &&
          document.querySelector(".menubar-item.menu-open") &&
          !buttonElement.classList.contains("menu-open")
        ) {
          openMenu(items(), buttonElement);
        }
      });

      menuBar.append(buttonElement);
    }

    this.titleFile = html("span", { class: "title-file" });
    this.maxBtn = html(
      "button",
      { type: "button", class: "win-btn", tip: "Maximize" },
      icon(Square, 13),
    );

    this.maxBtn.addEventListener("click", async () => {
      await P.toggleMaximize();
      this.syncMaxButton();
    });

    const controls = P.isTauri
      ? html(
          "div",
          { class: "win-controls" },
          html(
            "button",
            {
              type: "button",
              class: "win-btn",
              tip: "Minimize",
              onClick: () => P.minimize(),
            },
            icon(Minus, 15),
          ),
          this.maxBtn,
          html(
            "button",
            {
              type: "button",
              class: "win-btn close",
              tip: "Close",
              onClick: () => P.closeWindow(),
            },
            icon(X, 16),
          ),
        )
      : null;
    const drag = html(
      "div",
      { class: "drag", "data-tauri-drag-region": "" },
      html(
        "span",
        { class: "title-text", "data-tauri-drag-region": "" },
        "Bit Viewer",
      ),
      this.titleFile,
    );
    this.element = html(
      "div",
      { class: "titlebar" },
      html(
        "div",
        { class: "brand", "data-tauri-drag-region": "" },
        logoSvg(20),
      ),
      menuBar,
      drag,
      controls,
    );
  }

  /** Shows the file name (with a dot when there are unsaved changes). */
  setFile(text: string) {
    this.titleFile.textContent = text;
  }

  /** The maximize button shows "restore" while the window is maximized. */
  async syncMaxButton() {
    if (!P.isTauri) return;
    const max = await P.isMaximized();
    this.maxBtn.replaceChildren(icon(max ? Minimize : Maximize, 13));
  }
}
