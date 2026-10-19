// Help (searchable topics + shortcuts) and About dialogs.
import { CircleQuestionMark, Info, Search, Sparkles } from "lucide";
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

export const TOPICS: { title: string; body: string }[] = [
  {
    title: "Bits",
    body:
      "Click a bit to flip it. Drag across bits (also across rows) to select them; Shift+click extends the selection. " +
      "In byte / nibble view, click a row label to select the row and Shift+click another to select consecutive rows. " +
      "Right-click a bit for row operations. Clicking anywhere else clears an unnamed selection.",
  },
  {
    title: "Keyboard control",
    body:
      "Click a bit (or Tab to the bits) to place the cursor. Arrow keys move it the way the bits are laid out, " +
      "Space or Enter flips the bit, 0 and 1 set it, Shift+arrows select, Home / End jump to the top / bottom bit.",
  },
  {
    title: "Paint mode",
    body: "Hold Alt and drag across bits to set them all to 1; Alt+Shift+drag sets them to 0. A stroke is one undo step and skips read-only fields.",
  },
  {
    title: "Typing values",
    body:
      "Type into any field in its selected base (BIN / OCT / DEC / HEX). Prefixes 0x / 0b / 0o override the base " +
      "(in HEX, 0b… is read as hex). Spaces and _ are ignored. The whole-value field accepts negative decimals, stored as " +
      "two's complement. Invalid input turns red with the reason in a tooltip; Esc reverts.",
  },
  {
    title: "Expressions",
    body:
      "The ƒx button opens an expression bar: type e.g. 0x1F << 3 | bit(31) and press Enter. Operators: + - * / % ** " +
      "<< >> & | ^ ~ !. Functions: min max abs bit(n) mask(n) popcount. Names: x (this value), this value's fields, " +
      "other values; {braces} for names with spaces. Edit › New value from expression combines values.",
  },
  {
    title: "Operations",
    body:
      "NOT, CLR, SET, ≪ and ≫ are on each value's toolbar; the ⌄ next to them has rotate, arithmetic shift, shift/rotate " +
      "by N, swap bytes, reverse bits, negate, increment, decrement and AND / OR / XOR with a mask. When bits are selected, " +
      "operations apply to the selection only.",
  },
  {
    title: "Register fields",
    body:
      "Select bits and press Group selection (Ctrl+G). Fields may span rows but can't overlap. The sliders button opens " +
      "field details: description, signed, a formula with a unit (e.g. x * 0.5 - 40 °C — linear formulas can be typed back " +
      "in), named values (0 = Off, 1 = Auto…) and access. Read-only and reserved fields are hatched and ask before their " +
      "bits change. Named fields are only ever removed by you.",
  },
  {
    title: "Templates & code export",
    body:
      "Templates (fields panel, or Edit › Add value from template) apply ready-made layouts: IEEE-754 float32/64/16, " +
      "bfloat16, RGB565, ARGB8888, IPv4, UTF-8 lead byte — or your own, saved from a value's ⋯ menu. Export code " +
      "generates C macros, a C bitfield struct, Rust or Python for a value's fields.",
  },
  {
    title: "Compare rows & snapshots",
    body:
      "Compare opens a linked row with its own value; differing bits are outlined and the row shows Δ and XOR. Closing a " +
      "compare row keeps its value for next time. ⋯ › Compare with fills compare rows from another value. Snapshots (⋯ menu) " +
      "save named copies of a value to restore or compare later.",
  },
  {
    title: "Floats, bytes and readouts",
    body:
      "Float chips (float16 / bfloat16 / float32 / float64) are editable: click and type 1.5. ⋯ › Paste bytes reads " +
      "DE AD BE EF, {0xDE, 0xAD}, b'\\xde' in either byte order; Copy as bytes writes hex, C or Python. The + after the " +
      "chips adds text, BCD, Gray code, one's complement, zero counts, parity and the highest set bit.",
  },
  {
    title: "Workspace",
    body:
      "Ctrl+Z / Ctrl+Y undo and redo anything. Work is auto-saved and restored after a restart or crash. File › Open recent " +
      "lists recent workspaces; dropping a .bitview.json on the window opens it. Drag a value by its handle to reorder, " +
      "collapse it with the chevron, Ctrl+F searches, Ctrl+K opens the command palette.",
  },
  {
    title: "Customising",
    body:
      "Settings (Ctrl+,): dark / light / high-contrast theme, accent colour, compact mode, zoom (also Ctrl+wheel), bit order, " +
      "layout and base for new values, optional sounds and which readouts show.",
  },
];

export function showHelp(commands: CommandRegistry, startTour: () => void): Promise<void> {
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
      const render = () => {
        const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
        const hit = (s: string) => words.every((w) => s.toLowerCase().includes(w));
        const topics = TOPICS.filter((t) => hit(`${t.title} ${t.body}`));
        const scRows = withKeys.filter((c) => hit(`${commands.label(c)} ${c.keys?.join(" ")} shortcut`));
        list.replaceChildren(
          ...topics.flatMap((t) => [h("h4", {}, t.title), h("p", {}, t.body)]),
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
