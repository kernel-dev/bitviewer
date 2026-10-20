// Help (searchable topics + shortcuts) and About dialogs.
import { BookOpen, CircleQuestionMark, Info, Search, Sparkles } from "lucide";
import pkg from "../../package.json";
import type { CommandRegistry } from "../app/commands";
import { button, h, icon, modal } from "../ui/kit";
import { logoSvg } from "../ui/logo";

export const VERSION = pkg.version;

/** Renders "Ctrl+Shift+S" as key caps. */
export function keyCaps(spec: string): HTMLElement {
  const parts = spec.endsWith("++") ? [...spec.slice(0, -2).split("+"), "+"] : spec.split("+");
  return h("span", { class: "keys" }, ...parts.map((k) => h("kbd", {}, k)));
}

/** Short reminders; `guide` is the page in docs/guide that explains the topic properly. */
export const TOPICS: { title: string; body: string; guide?: string }[] = [
  {
    title: "Bits",
    body: "Click a bit to flip it, drag to select, Shift+click to extend. Right-click a bit for row operations.",
    guide: "01-bits-and-values.md",
  },
  {
    title: "Typing values",
    body: "Type in the selected base. 0x / 0b / 0o prefixes override it; spaces and _ are ignored. Esc reverts.",
    guide: "01-bits-and-values.md",
  },
  {
    title: "Paint mode",
    body: "Alt+drag sets bits to 1, Alt+Shift+drag sets them to 0.",
    guide: "01-bits-and-values.md",
  },
  {
    title: "Expressions",
    body: "The ƒx button opens an expression bar, e.g. 0x1F << 3 | bit(31). x is this value; field names work too.",
    guide: "02-expressions.md",
  },
  {
    title: "Register fields",
    body: "Select bits and press Group selection (Ctrl+G). Right-click a field to rename, recolour or resize it.",
    guide: "03-register-fields.md",
  },
  {
    title: "Operations",
    body: "NOT, CLR, SET and shifts are on the toolbar, more under ⌄. They act on the selection when there is one.",
    guide: "04-operations-and-compare.md",
  },
  {
    title: "Compare rows & snapshots",
    body: "Compare adds a linked row that outlines differing bits. Snapshots are in a value's ⋯ menu.",
    guide: "04-operations-and-compare.md",
  },
  {
    title: "Templates & code export",
    body: "Templates apply ready-made field layouts. Export code is in a value's ⋯ menu.",
    guide: "05-templates-and-workspace.md",
  },
  {
    title: "Workspace",
    body: "Ctrl+Z / Ctrl+Y undo and redo, work is auto-saved, Ctrl+F searches, Ctrl+K opens the command palette.",
    guide: "05-templates-and-workspace.md",
  },
];

export function showHelp(
  commands: CommandRegistry,
  startTour: () => void,
  openGuide: (page?: string) => void,
): Promise<void> {
  const withKeys = commands.all().filter((c) => c.keys?.length && !c.hidden);
  return modal<void>({
    title: "Help",
    icon: CircleQuestionMark,
    wide: true,
    cancelValue: undefined,
    build: (body, close) => {
      const search = h("input", { class: "field help-search", placeholder: "Search help…", spellcheck: false });
      const list = h("div", { class: "help" });
      const shortcuts = h(
        "div",
        { class: "shortcuts" },
        ...withKeys.flatMap((c) => [
          h("span", { class: "sc-label" }, commands.label(c)),
          h("span", {}, ...(c.keys ?? []).flatMap((k, i) => (i ? [" ", keyCaps(k)] : [keyCaps(k)]))),
        ]),
      );
      const guideLink = (page: string) => {
        const a = h("a", { href: "#", class: "guide-link" }, "Learn more");
        a.addEventListener("click", (e) => {
          e.preventDefault();
          close();
          setTimeout(() => openGuide(page), 150);
        });
        return a;
      };
      const render = () => {
        const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
        const hit = (s: string) => words.every((w) => s.toLowerCase().includes(w));
        const topics = TOPICS.filter((t) => hit(`${t.title} ${t.body}`));
        const scRows = withKeys.filter((c) => hit(`${commands.label(c)} ${c.keys?.join(" ")} shortcut`));
        list.replaceChildren(
          ...topics.flatMap((t) => [h("h4", {}, t.title), h("p", {}, t.body, " ", t.guide ? guideLink(t.guide) : "")]),
          scRows.length ? h("h4", {}, "Shortcuts") : "",
          scRows.length ? shortcuts : "",
          !topics.length && !scRows.length ? h("p", { class: "muted" }, "Nothing found — try another word.") : "",
        );
        // filter shortcut rows in place
        const labels = [...shortcuts.querySelectorAll(".sc-label")];
        labels.forEach((l, i) => {
          const show = scRows.includes(withKeys[i]);
          (l as HTMLElement).hidden = !show;
          (l.nextElementSibling as HTMLElement).hidden = !show;
        });
      };
      search.addEventListener("input", render);
      body.append(h("div", { class: "help-search-row" }, icon(Search, 15, "muted"), search), list);
      render();
      return [
        button({
          icon: BookOpen,
          label: "Open the guide",
          cls: "outline",
          onClick: () => {
            close();
            setTimeout(() => openGuide(), 150);
          },
        }),
        button({
          icon: Sparkles,
          label: "Take the tour",
          cls: "outline",
          onClick: () => {
            close();
            setTimeout(startTour, 150);
          },
        }),
        button({ label: "Close", cls: "primary", onClick: () => close() }),
      ];
    },
  });
}

export function showAbout(): Promise<void> {
  return modal<void>({
    title: "About",
    icon: Info,
    cancelValue: undefined,
    build: (body, close) => {
      body.append(
        h(
          "div",
          { class: "about" },
          logoSvg(64),
          h(
            "div",
            {},
            h("h3", {}, "Bit Viewer"),
            h("p", { class: "muted" }, `Version ${VERSION}`),
            h("p", {}, "Inspect and edit values of 1 to 512 bits, bit by bit."),
          ),
        ),
      );
      return [button({ label: "Close", cls: "primary", onClick: () => close() })];
    },
  });
}
