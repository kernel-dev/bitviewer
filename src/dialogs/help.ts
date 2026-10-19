// Help ("Controls") and About dialogs.
import { CircleQuestionMark, Info } from "lucide";
import type { CommandRegistry } from "../commands";
import { logoSvg } from "../logo";
import { button, h, modal } from "../ui";

export const VERSION = "2.0.0";

/** Renders "Ctrl+Shift+S" as key caps. */
export function keyCaps(spec: string): HTMLElement {
  const parts = spec.endsWith("++") ? [...spec.slice(0, -2).split("+"), "+"] : spec.split("+");
  return h("span", { class: "keys" }, ...parts.map((k) => h("kbd", {}, k)));
}

export function showControls(commands: CommandRegistry): Promise<void> {
  const withKeys = commands.all().filter((c) => c.keys?.length && !c.hidden);
  return modal<void>({
    title: "Controls",
    icon: CircleQuestionMark,
    wide: true,
    cancelValue: undefined,
    build: (body, close) => {
      body.append(
        h(
          "div",
          { class: "help" },
          h("h4", {}, "Bits"),
          h(
            "p",
            {},
            "Click a bit to flip it · drag across bits (also across rows) to select · Shift+click to extend · " +
              "click a row label to select the row, Shift+click another to select consecutive rows · " +
              "right-click a bit for row actions.",
          ),
          h("h4", {}, "Values"),
          h(
            "p",
            {},
            "Type into any field in its selected base. Prefixes 0x / 0b / 0o override the base (in HEX, 0b… is read " +
              "as hex). Spaces and _ are ignored. The whole-value field accepts negative decimals (stored as two's " +
              "complement). Invalid input turns red; Esc reverts.",
          ),
          h("h4", {}, "Fields & compare rows"),
          h(
            "p",
            {},
            "Select bits, then “Group selection” or Ctrl+G. Fields may span rows but cannot overlap. Compare rows " +
              "hold an independent value, inherit the parent's fields, and outline bits that differ.",
          ),
          h("h4", {}, "Shortcuts"),
          h(
            "div",
            { class: "shortcuts" },
            ...withKeys.flatMap((c) => [
              h("span", {}, commands.label(c)),
              h("span", {}, ...(c.keys ?? []).flatMap((k, i) => (i ? [" ", keyCaps(k)] : [keyCaps(k)]))),
            ]),
          ),
        ),
      );
      return [button({ label: "Got it", cls: "primary", onClick: () => close() })];
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
