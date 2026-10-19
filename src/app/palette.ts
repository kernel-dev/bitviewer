// Command palette (Ctrl+K): type to find any command, Enter to run it.

import { closeMenus, h, hideTip, icon } from "../ui/kit";
import type { Command, CommandRegistry } from "./commands";

/** Ranks how well `c` matches the query words; -1 = no match. */
export function score(label: string, extra: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const l = label.toLowerCase();
  const hay = `${l} ${extra.toLowerCase()}`;
  let s = 0;
  for (const word of q.split(/\s+/)) {
    const i = hay.indexOf(word);
    if (i < 0) return -1;
    if (l.startsWith(word)) s += 30;
    else if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(l)) s += 20;
    else if (i < l.length) s += 10;
    else s += 2; // only in keywords / group
  }
  return s;
}

let open = false;

export function paletteOpen(): boolean {
  return open;
}

export function openPalette(commands: CommandRegistry) {
  if (open) return;
  open = true;
  closeMenus();
  hideTip();
  const prevFocus = document.activeElement as HTMLElement | null;
  const input = h("input", {
    class: "palette-input",
    placeholder: "Type a command…",
    spellcheck: false,
    "aria-label": "Command",
  });
  const list = h("div", { class: "palette-list", role: "listbox" });
  const box = h("div", { class: "palette", role: "dialog", "aria-label": "Command palette" }, input, list);
  const backdrop = h("div", { class: "palette-backdrop" }, box);
  let shown: Command[] = [];
  let active = 0;

  const close = () => {
    open = false;
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    prevFocus?.focus?.({ preventScroll: true });
  };
  const run = (c: Command | undefined) => {
    if (!c || !commands.isEnabled(c)) return;
    close();
    c.run();
  };
  const render = () => {
    const q = input.value;
    shown = commands
      .all()
      .filter((c) => !c.hidden)
      .map((c) => ({ c, s: score(commands.label(c), `${c.keywords ?? ""} ${c.group}`, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(
      ...(shown.length
        ? shown.map((c, i) => {
            const ic = commands.icon(c);
            const row = h(
              "button",
              {
                type: "button",
                class: `palette-item${i === active ? " active" : ""}`,
                role: "option",
                disabled: !commands.isEnabled(c),
                "aria-selected": i === active ? "true" : "false",
              },
              ic ? icon(ic, 15) : h("span", { class: "menu-ico-pad" }),
              h("span", { class: "palette-group" }, c.group),
              h("span", { class: "palette-label" }, commands.label(c)),
              c.keys?.[0] ? h("span", { class: "menu-kbd" }, c.keys[0]) : null,
            );
            row.addEventListener("pointermove", () => {
              if (active !== i) {
                active = i;
                syncActive();
              }
            });
            row.addEventListener("click", () => run(c));
            return row;
          })
        : [h("div", { class: "palette-empty muted" }, "No matching commands")]),
    );
  };
  const syncActive = () => {
    list.querySelectorAll(".palette-item").forEach((el, i) => {
      el.classList.toggle("active", i === active);
      el.setAttribute("aria-selected", i === active ? "true" : "false");
    });
    (list.querySelectorAll(".palette-item")[active] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      syncActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(shown[active]);
    }
  };
  input.addEventListener("input", () => {
    active = 0;
    render();
  });
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop);
  render();
  input.focus();
}
