// Command palette (Ctrl+K): type to find any command, Enter to run it.

import { closeMenus, hideTip, html, icon } from "../ui/kit";
import type { Command, CommandRegistry } from "./commands/registry";

/** Ranks how well `c` matches the query words; -1 = no match. */
export function score(label: string, extra: string, query: string): number {
  const lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) return 0;
  const lowerLabel = label.toLowerCase();
  const haystack = `${lowerLabel} ${extra.toLowerCase()}`;
  let total = 0;
  for (const word of lowerQuery.split(/\s+/)) {
    const matchIndex = haystack.indexOf(word);
    if (matchIndex < 0) return -1;
    if (lowerLabel.startsWith(word)) total += 30;
    else if (
      new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(
        lowerLabel,
      )
    )
      total += 20;
    else if (matchIndex < lowerLabel.length) total += 10;
    else total += 2; // only in keywords / group
  }
  return total;
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
  const input = html("input", {
    class: "palette-input",
    placeholder: "Type a command…",
    spellcheck: false,
    "aria-label": "Command",
  });
  const list = html("div", { class: "palette-list", role: "listbox" });
  const box = html(
    "div",
    { class: "palette", role: "dialog", "aria-label": "Command palette" },
    input,
    list,
  );
  const backdrop = html("div", { class: "palette-backdrop" }, box);
  let shown: Command[] = [];
  let active = 0;

  const close = () => {
    open = false;
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    prevFocus?.focus?.({ preventScroll: true });
  };
  const run = (command: Command | undefined) => {
    if (!command || !commands.isEnabled(command)) return;
    close();
    command.run();
  };
  const render = () => {
    const queryText = input.value;
    shown = commands
      .all()
      .filter((command) => !command.hidden)
      .map((command) => ({
        command,
        score: score(
          commands.label(command),
          `${command.keywords ?? ""} ${command.group}`,
          queryText,
        ),
      }))
      .filter((ranked) => ranked.score >= 0)
      .sort((first, second) => second.score - first.score)
      .map((ranked) => ranked.command);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(
      ...(shown.length
        ? shown.map((command, rowIndex) => {
            const iconNode = commands.icon(command);
            const row = html(
              "button",
              {
                type: "button",
                class: `palette-item${rowIndex === active ? " active" : ""}`,
                role: "option",
                disabled: !commands.isEnabled(command),
                "aria-selected": rowIndex === active ? "true" : "false",
              },
              iconNode
                ? icon(iconNode, 15)
                : html("span", { class: "menu-ico-pad" }),
              html("span", { class: "palette-group" }, command.group),
              html("span", { class: "palette-label" }, commands.label(command)),
              command.keys?.[0]
                ? html("span", { class: "menu-kbd" }, command.keys[0])
                : null,
            );
            row.addEventListener("pointermove", () => {
              if (active !== rowIndex) {
                active = rowIndex;
                syncActive();
              }
            });
            row.addEventListener("click", () => run(command));
            return row;
          })
        : [
            html(
              "div",
              { class: "palette-empty muted" },
              "No matching commands",
            ),
          ]),
    );
  };
  const syncActive = () => {
    list.querySelectorAll(".palette-item").forEach((element, rowIndex) => {
      element.classList.toggle("active", rowIndex === active);
      element.setAttribute(
        "aria-selected",
        rowIndex === active ? "true" : "false",
      );
    });
    (
      list.querySelectorAll(".palette-item")[active] as HTMLElement | undefined
    )?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!shown.length) return;
      active =
        (active + (event.key === "ArrowDown" ? 1 : -1) + shown.length) %
        shown.length;
      syncActive();
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(shown[active]);
    }
  };
  input.addEventListener("input", () => {
    active = 0;
    render();
  });
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop);
  render();
  input.focus();
}
