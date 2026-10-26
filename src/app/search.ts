// Ctrl+F search bar: filters values by name, fields, descriptions, named
// values, snapshots or hex digits, and highlights matching fields. It searches
// when Enter or the Search button is pressed, not on every keystroke.
import { ChevronDown, ChevronUp, Search, X } from "lucide";
import type { ValueCard } from "../card/card";
import { formatInt } from "../core/format/integers";
import type { ValueModel } from "../core/model";
import { button, html, icon } from "../ui/kit";
import { bringIntoView } from "./workspace/reveal";

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
  private matchCount = 0;
  /** The query the workspace is filtered by (lower case; "" shows everything).
   *  It changes on Enter or the Search button, not on every keystroke:
   *  filtering a large workspace takes a moment. */
  query = "";

  /** `shown` runs after filtering, when hidden values may have come back. */
  constructor(
    private cards: () => ValueCard[],
    private shown: () => void = () => {},
  ) {
    this.input = html("input", {
      class: "field search-input",
      placeholder: "Search values, fields, descriptions, hex… then press Enter",
      spellcheck: false,
    });
    this.count = html("span", { class: "muted small search-count" });
    this.input.addEventListener("input", () => {
      // an emptied box shows everything again at once
      if (!this.typed) this.search();
      else this.showCount();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.go(event.shiftKey ? -1 : 1);
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
      button({
        label: "Search",
        className: "outline sm",
        tip: "Search for what you typed (Enter)",
        onClick: () => this.search(),
      }),
      this.count,
      button({
        icon: ChevronUp,
        className: "ghost sm",
        tip: "Previous match (Shift+Enter)",
        onClick: () => this.go(-1),
      }),
      button({
        icon: ChevronDown,
        className: "ghost sm",
        tip: "Next match (Enter)",
        onClick: () => this.go(1),
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

  /** What is typed in the box, as a query. */
  private get typed(): string {
    return this.input.value.trim().toLowerCase();
  }

  open() {
    this.element.hidden = false;
    this.input.focus();
    this.input.select();
    this.showCount();
  }

  close() {
    this.element.hidden = true;
    this.input.value = "";
    this.search();
  }

  /** Filters the workspace for what is typed. */
  search() {
    this.current = -1;
    this.query = this.typed;
    this.apply();
  }

  /** Enter / the arrows: search for new text, otherwise go to the next or
   *  previous match. */
  private go(direction: number) {
    if (this.typed !== this.query) this.search();
    else this.step(direction);
  }

  private matches(): ValueCard[] {
    return this.cards().filter((card) => !card.root.hidden);
  }

  /** Filters the workspace for the current query. Call again after the cards change. */
  apply() {
    if (!this.isOpen) this.query = "";
    // while searching, collapsed peripherals open so their matches show
    document.body.classList.toggle("searching", !!this.query);
    this.matchCount = 0;
    for (const card of this.cards()) {
      const result = matchValue(card.model, this.query);
      // only touch cards whose state changes: each change restyles the card
      if (card.root.hidden === result.hit) card.root.hidden = !result.hit;
      card.markMatches(result.fields);
      if (result.hit) this.matchCount++;
    }
    this.showCount();
    this.shown();
  }

  /** "3 of 40 values", "No matches", or a reminder that new text isn't searched yet. */
  private showCount() {
    const pending = this.typed !== this.query;
    const total = this.cards().length;
    this.count.textContent = pending
      ? "Press Enter to search"
      : !this.query
        ? ""
        : this.matchCount
          ? `${this.matchCount} of ${total} value${total === 1 ? "" : "s"}`
          : "No matches";
    this.input.classList.toggle(
      "invalid",
      !pending && !!this.query && this.matchCount === 0,
    );
  }

  private step(direction: number) {
    const list = this.matches();
    if (!list.length) return;
    this.current = (this.current + direction + list.length) % list.length;
    const card = list[this.current];
    bringIntoView(card.root, "start", this.shown);
    card.root.classList.remove("flash");
    void card.root.offsetWidth; // restart the animation
    card.root.classList.add("flash");
  }
}
