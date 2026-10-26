// "Compare with…": what a value's compare rows are filled with. Any number or
// expression can be typed (x is the value itself; other values by name work
// too). Picking one of the other values in the workspace is a shortcut that
// fills in its value.

import { GitCompareArrows } from "lucide";
import { formatInt } from "../core/format/integers";
import { type ExprField, exprField, type Lookup } from "../ui/expr-field";
import { button, html, modal } from "../ui/kit";

/** Another value the user can take the bits of. */
export interface CompareCandidate {
  name: string;
  width: number;
  value: bigint;
}

/** Longest list shown at once; typing in the filter narrows it down. */
const MAX_LISTED = 200;

const hexOf = (value: bigint, width: number) =>
  formatInt(value, 16, width, { prefix: true });

/** Asks what to compare a `width`-bit value with. Resolves to the value to
 *  compare with, or null when cancelled. */
export function pickCompareValue(options: {
  name: string;
  width: number;
  value: bigint;
  lookup: Lookup;
  candidates: CompareCandidate[];
}): Promise<bigint | null> {
  return modal<bigint | null>({
    title: `Compare “${options.name || "value"}” with…`,
    icon: GitCompareArrows,
    wide: true,
    cancelValue: null,
    build: (body, close) => {
      const confirmButton = button({
        label: "Compare",
        className: "primary",
        onClick: () => submit(),
      });

      const field = exprField({
        width: () => options.width,
        lookup: options.lookup,
        value: hexOf(options.value, options.width),
        placeholder: "e.g. 0xFF00   ·   x ^ 0b1000   ·   {Value 2}",
        onEnter: () => submit(),

        onChange: (result) => {
          confirmButton.disabled = !result;
        },
      });

      const submit = () => {
        const result = field.result();
        if (result) close(result.value);
      };

      body.append(
        html(
          "label",
          { class: "modal-label" },
          "Value to compare with: a number or an expression. x is this value; use other values by name, {braces} for names with spaces.",
        ),
        field.element,
      );

      if (options.candidates.length)
        body.append(
          candidatePicker(options.candidates, field, (value) => close(value)),
        );

      requestAnimationFrame(() => {
        field.input.focus();
        field.input.select();
      });

      return [
        button({ label: "Cancel", onClick: () => close(null) }),
        confirmButton,
      ];
    },
  });
}

/** The shortcut: a filterable list of the other values. Clicking one fills in
 *  its value; double-clicking compares with it at once. Collapsed at first. */
function candidatePicker(
  candidates: CompareCandidate[],
  field: ExprField,
  compare: (value: bigint) => void,
): HTMLElement {
  const filter = html("input", {
    class: "field compare-filter",
    placeholder: "Filter by name…",
    spellcheck: false,
  });
  const list = html("div", { class: "compare-list", role: "listbox" });

  const fill = (candidate: CompareCandidate) => {
    field.input.value = hexOf(candidate.value, candidate.width);
    field.refresh();
  };

  const render = () => {
    const query = filter.value.trim().toLowerCase();
    const matching = query
      ? candidates.filter((candidate) =>
          candidate.name.toLowerCase().includes(query),
        )
      : candidates;

    const items = matching.slice(0, MAX_LISTED).map((candidate) => {
      const item = html(
        "button",
        { type: "button", class: "compare-item", role: "option" },
        html("span", { class: "compare-name" }, candidate.name),
        html(
          "span",
          { class: "muted mono small" },
          `${candidate.width}-bit · ${formatInt(candidate.value, 16, candidate.width, { prefix: true, group: true })}`,
        ),
      );

      item.addEventListener("click", () => {
        fill(candidate);
        for (const other of list.children)
          other.classList.toggle("on", other === item);
      });

      item.addEventListener("dblclick", () => {
        const result = field.result();
        if (result) compare(result.value);
      });

      return item;
    });

    const note = !matching.length
      ? "No values match"
      : matching.length > MAX_LISTED
        ? `${matching.length - MAX_LISTED} more: type to narrow the list`
        : "";
    list.replaceChildren(
      ...items,
      ...(note ? [html("p", { class: "muted small compare-more" }, note)] : []),
    );
  };

  filter.addEventListener("input", render);

  filter.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      list.querySelector<HTMLElement>(".compare-item")?.click();
    }
  });

  const details = html(
    "details",
    { class: "compare-pick" },
    html(
      "summary",
      {},
      `Or take the value of another one in the workspace (${candidates.length})`,
    ),
    filter,
    list,
  );

  // the list is only built when opened
  details.addEventListener("toggle", () => {
    if (!details.open) return;
    render();
    filter.focus();
  });

  return details;
}
