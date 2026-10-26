// Ctrl+F search bar: filters values by name, fields, descriptions, named
// values, snapshots or hex digits, and highlights matching fields.
import { ChevronDown, ChevronUp, Search, X } from "lucide";
import type { ValueCard } from "../card/card";
import type { ValueModel } from "../core/model";
import { formatInt } from "../core/numfmt";
import { button, html, icon } from "../ui/kit";

/** Does a value match the (lower-case) query? Field names that match are returned too. */
export function matchValue(
  model: ValueModel,
  query: string,
): { hit: boolean; fields: Set<string> } {
  const fields = new Set<string>();
  if (!query) return { hit: true, fields };
  const containsQuery = (text: string) => text.toLowerCase().includes(query);
  for (const group of model.groups) {
    if (
      containsQuery(group.name) ||
      containsQuery(group.description) ||
      group.named.some((namedValue) => containsQuery(namedValue.label))
    )
      fields.add(group.name);
  }
  const hex = formatInt(model.value, 16, model.width).toLowerCase();
  const hit =
    containsQuery(model.name) ||
    containsQuery(model.block) ||
    containsQuery(model.description) ||
    fields.size > 0 ||
    model.snapshots.some((snapshot) => containsQuery(snapshot.name)) ||
    hex.includes(query.replace(/^0x|_/g, ""));
  return { hit, fields };
}

export class SearchBar {
  readonly element: HTMLElement;
  private input: HTMLInputElement;
  private count: HTMLElement;
  private current = -1;
  query = "";

  constructor(private cards: () => ValueCard[]) {
    this.input = html("input", {
      class: "field search-input",
      placeholder: "Search values, fields, descriptions, hex…",
      spellcheck: false,
    });
    this.count = html("span", { class: "muted small search-count" });
    this.input.addEventListener("input", () => {
      this.current = -1;
      this.apply();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.step(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    });
    this.element = html(
      "div",
      { class: "search-bar", hidden: true },
      icon(Search, 15, "muted"),
      this.input,
      this.count,
      button({
        icon: ChevronUp,
        className: "ghost sm",
        tip: "Previous match (Shift+Enter)",
        onClick: () => this.step(-1),
      }),
      button({
        icon: ChevronDown,
        className: "ghost sm",
        tip: "Next match (Enter)",
        onClick: () => this.step(1),
      }),
      button({
        icon: X,
        className: "ghost sm",
        tip: "Close (Esc)",
        onClick: () => this.close(),
      }),
    );
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  open() {
    this.element.hidden = false;
    this.input.focus();
    this.input.select();
    this.apply();
  }

  close() {
    this.element.hidden = true;
    this.input.value = "";
    this.apply();
  }

  private matches(): ValueCard[] {
    return this.cards().filter((card) => !card.root.hidden);
  }

  /** Filters the workspace for the current query. Call again after the cards change. */
  apply() {
    this.query = this.isOpen ? this.input.value.trim().toLowerCase() : "";
    // while searching, collapsed peripherals open so their matches show
    document.body.classList.toggle("searching", !!this.query);
    let matchCount = 0;
    for (const card of this.cards()) {
      const result = matchValue(card.model, this.query);
      card.root.hidden = !result.hit;
      card.markMatches(result.fields);
      if (result.hit) matchCount++;
    }
    const total = this.cards().length;
    this.count.textContent = !this.query
      ? ""
      : matchCount
        ? `${matchCount} of ${total} value${total === 1 ? "" : "s"}`
        : "No matches";
    this.input.classList.toggle("invalid", !!this.query && matchCount === 0);
  }

  private step(direction: number) {
    const list = this.matches();
    if (!list.length) return;
    this.current = (this.current + direction + list.length) % list.length;
    const card = list[this.current];
    card.root.scrollIntoView({ block: "start", behavior: "smooth" });
    card.root.classList.remove("flash");
    void card.root.offsetWidth; // restart the animation
    card.root.classList.add("flash");
  }
}
