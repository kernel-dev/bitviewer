// Help (searchable topics + shortcuts) and About dialogs.
import { BookOpen, CircleQuestionMark, Info, Search, Sparkles } from "lucide";
import pkg from "../../package.json";
import type { CommandRegistry } from "../app/commands";
import { button, html, icon, modal } from "../ui/kit";
import { logoSvg } from "../ui/logo";

export const VERSION = pkg.version;

/** Renders "Ctrl+Shift+S" as key caps. */
export function keyCaps(spec: string): HTMLElement {
  const parts = spec.endsWith("++")
    ? [...spec.slice(0, -2).split("+"), "+"]
    : spec.split("+");
  return html(
    "span",
    { class: "keys" },
    ...parts.map((keyName) => html("kbd", {}, keyName)),
  );
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
    title: "Generate code",
    body: "Name your fields, then ⋯ › Export code writes C, Rust or Python for them. Pick 32 or 64-bit registers for structs.",
    guide: "06-generating-code.md",
  },
  {
    title: "Export templates",
    body: "In Export code, + writes your own template for any language: your text with ${…} values and @for / @if lines.",
    guide: "07-export-templates.md",
  },
  {
    title: "Templates",
    body: "Templates apply ready-made field layouts, such as IEEE-754 floats or RGB565.",
    guide: "05-templates-and-workspace.md",
  },
  {
    title: "Peripherals",
    body: "Group values into a peripheral with a base address (⋯ › Peripheral): each register shows its address, and Export writes a C struct or Rust module for the whole block.",
    guide: "09-peripherals.md",
  },
  {
    title: "CMSIS-SVD import",
    body: "File › Import CMSIS-SVD… (or drop a .svd file) adds a chip's registers as values, with fields, reset values and named values, or saves them as templates.",
    guide: "08-importing-svd.md",
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
  const withKeys = commands
    .all()
    .filter((command) => command.keys?.length && !command.hidden);
  return modal<void>({
    title: "Help",
    icon: CircleQuestionMark,
    wide: true,
    cancelValue: undefined,
    build: (body, close) => {
      const search = html("input", {
        class: "field help-search",
        placeholder: "Search help…",
        spellcheck: false,
      });
      const list = html("div", { class: "help" });
      const shortcuts = html(
        "div",
        { class: "shortcuts" },
        ...withKeys.flatMap((command) => [
          html("span", { class: "sc-label" }, commands.label(command)),
          html(
            "span",
            {},
            ...(command.keys ?? []).flatMap((keyName, index) =>
              index ? [" ", keyCaps(keyName)] : [keyCaps(keyName)],
            ),
          ),
        ]),
      );
      const guideLink = (page: string) => {
        const anchor = html(
          "a",
          { href: "#", class: "guide-link" },
          "Learn more",
        );
        anchor.addEventListener("click", (event) => {
          event.preventDefault();
          close();
          setTimeout(() => openGuide(page), 150);
        });
        return anchor;
      };
      const render = () => {
        const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
        const hit = (text: string) =>
          words.every((word) => text.toLowerCase().includes(word));
        const topics = TOPICS.filter((topic) =>
          hit(`${topic.title} ${topic.body}`),
        );
        const scRows = withKeys.filter((command) =>
          hit(`${commands.label(command)} ${command.keys?.join(" ")} shortcut`),
        );
        list.replaceChildren(
          ...topics.flatMap((topic) => [
            html("h4", {}, topic.title),
            html(
              "p",
              {},
              topic.body,
              " ",
              topic.guide ? guideLink(topic.guide) : "",
            ),
          ]),
          scRows.length ? html("h4", {}, "Shortcuts") : "",
          scRows.length ? shortcuts : "",
          !topics.length && !scRows.length
            ? html("p", { class: "muted" }, "Nothing found — try another word.")
            : "",
        );
        // filter shortcut rows in place
        const labels = [...shortcuts.querySelectorAll(".sc-label")];
        labels.forEach((label, index) => {
          const show = scRows.includes(withKeys[index]);
          (label as HTMLElement).hidden = !show;
          (label.nextElementSibling as HTMLElement).hidden = !show;
        });
      };
      search.addEventListener("input", render);
      body.append(
        html(
          "div",
          { class: "help-search-row" },
          icon(Search, 15, "muted"),
          search,
        ),
        list,
      );
      render();
      return [
        button({
          icon: BookOpen,
          label: "Open the guide",
          className: "outline",
          onClick: () => {
            close();
            setTimeout(() => openGuide(), 150);
          },
        }),
        button({
          icon: Sparkles,
          label: "Take the tour",
          className: "outline",
          onClick: () => {
            close();
            setTimeout(startTour, 150);
          },
        }),
        button({
          label: "Close",
          className: "primary",
          onClick: () => close(),
        }),
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
        html(
          "div",
          { class: "about" },
          logoSvg(64),
          html(
            "div",
            {},
            html("h3", {}, "Bit Viewer"),
            html("p", { class: "muted" }, `Version ${VERSION}`),
            html(
              "p",
              {},
              "Inspect and edit values of 1 to 512 bits, bit by bit.",
            ),
          ),
        ),
      );
      return [
        button({
          label: "Close",
          className: "primary",
          onClick: () => close(),
        }),
      ];
    },
  });
}
