// Ctrl+F search bar: filters values by name, fields, descriptions, named
// values, snapshots or hex digits, and highlights matching fields.
import { ChevronDown, ChevronUp, Search, X } from "lucide";
import type { ValueCard } from "./card";
import type { ValueModel } from "./model";
import { formatInt } from "./numfmt";
import { button, h, icon } from "./ui";

/** Does a value match the (lower-case) query? Field names that match are returned too. */
export function matchValue(m: ValueModel, q: string): { hit: boolean; fields: Set<string> } {
  const fields = new Set<string>();
  if (!q) return { hit: true, fields };
  const has = (s: string) => s.toLowerCase().includes(q);
  for (const g of m.groups) {
    if (has(g.name) || has(g.description) || g.named.some((n) => has(n.label))) fields.add(g.name);
  }
  const hex = formatInt(m.value, 16, m.width).toLowerCase();
  const hit =
    has(m.name) || fields.size > 0 || m.snapshots.some((s) => has(s.name)) || hex.includes(q.replace(/^0x|_/g, ""));
  return { hit, fields };
}

export class SearchBar {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private count: HTMLElement;
  private current = -1;
  query = "";

  constructor(private cards: () => ValueCard[]) {
    this.input = h("input", {
      class: "field search-input",
      placeholder: "Search values, fields, descriptions, hex…",
      spellcheck: false,
    });
    this.count = h("span", { class: "muted small search-count" });
    this.input.addEventListener("input", () => {
      this.current = -1;
      this.apply();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    this.el = h(
      "div",
      { class: "search-bar", hidden: true },
      icon(Search, 15, "muted"),
      this.input,
      this.count,
      button({ icon: ChevronUp, cls: "ghost sm", tip: "Previous match (Shift+Enter)", onClick: () => this.step(-1) }),
      button({ icon: ChevronDown, cls: "ghost sm", tip: "Next match (Enter)", onClick: () => this.step(1) }),
      button({ icon: X, cls: "ghost sm", tip: "Close (Esc)", onClick: () => this.close() }),
    );
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open() {
    this.el.hidden = false;
    this.input.focus();
    this.input.select();
    this.apply();
  }

  close() {
    this.el.hidden = true;
    this.input.value = "";
    this.apply();
  }

  private matches(): ValueCard[] {
    return this.cards().filter((c) => !c.root.hidden);
  }

  /** Filters the workspace for the current query. Call again after the cards change. */
  apply() {
    this.query = this.isOpen ? this.input.value.trim().toLowerCase() : "";
    let n = 0;
    for (const c of this.cards()) {
      const r = matchValue(c.model, this.query);
      c.root.hidden = !r.hit;
      c.markMatches(r.fields);
      if (r.hit) n++;
    }
    const total = this.cards().length;
    this.count.textContent = !this.query ? "" : n ? `${n} of ${total} value${total === 1 ? "" : "s"}` : "No matches";
    this.input.classList.toggle("invalid", !!this.query && n === 0);
  }

  private step(dir: number) {
    const list = this.matches();
    if (!list.length) return;
    this.current = (this.current + dir + list.length) % list.length;
    const card = list[this.current];
    card.root.scrollIntoView({ block: "start", behavior: "smooth" });
    card.root.classList.remove("flash");
    void card.root.offsetWidth; // restart the animation
    card.root.classList.add("flash");
  }
}
