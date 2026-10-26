// Popup menus with submenus, checkmarks, colour swatches and shortcuts.
// Arrow keys move between items, Esc closes the innermost menu.

import { Check, type IconNode } from "lucide";
import { html, icon } from "./dom";

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
