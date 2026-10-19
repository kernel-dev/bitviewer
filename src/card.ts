// The card that shows one 32/64-bit value: header, rows, compare rows,
// register fields and interpretations.
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Binary,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  CopyPlus,
  Ellipsis,
  GitCompareArrows,
  Group as GroupIcon,
  type IconNode,
  Layers,
  MousePointerClick,
  Palette,
  PencilLine,
  RectangleHorizontal,
  Rows3,
  Rows4,
  Ruler,
  Tag,
  Trash,
  Undo2,
  X,
} from "lucide";
import { BitStrip, type StripHost } from "./bitstrip";
import { type ChangeKind, GROUP_COLORS, type Group, ModelError, type Op, type ValueModel, type View } from "./model";
import { asFloat, BASE_NAMES, BASE_ORDER, type Base, formatFloat, formatInt, popcount, toSigned } from "./numfmt";
import { copyText } from "./platform";
import { S } from "./settings";
import { play } from "./sound";
import {
  ask,
  button,
  h,
  icon,
  type MenuItem,
  NumberInput,
  openMenu,
  prompt,
  type Segmented,
  segmented,
  setTip,
  toast,
} from "./ui";

const VIEW_UI: { value: View; label: string; icon: IconNode; tip: string }[] = [
  {
    value: "line",
    label: "Line",
    icon: RectangleHorizontal,
    tip: "All bits on one line, stretched to the window width (wraps when narrow)",
  },
  { value: "byte", label: "Bytes", icon: Rows3, tip: "One row per byte" },
  { value: "nibble", label: "Nibbles", icon: Rows4, tip: "One row per nibble" },
];
const OPS_UI: { value: Op; label?: string; icon?: IconNode; tip: string }[] = [
  { value: "invert", label: "NOT", tip: "Invert every bit (bitwise NOT)" },
  { value: "clear", label: "CLR", tip: "Clear every bit to 0" },
  { value: "set", label: "SET", tip: "Set every bit to 1" },
  { value: "shl", icon: ChevronsLeft, tip: "Logical shift left by one bit" },
  { value: "shr", icon: ChevronsRight, tip: "Logical shift right by one bit" },
];
const ROW_OPS: [Op, string][] = [
  ["invert", "Invert bits"],
  ["clear", "Clear (all 0)"],
  ["set", "Set (all 1)"],
  ["shl", "Shift left ≪ 1"],
  ["shr", "Shift right ≫ 1"],
];

export interface CardEvents {
  remove(card: ValueCard): void;
  move(card: ValueCard, delta: number): void;
  duplicate(card: ValueCard): void;
  resize(card: ValueCard): void;
}

function baseSeg(base: Base, onPick: (b: Base) => void, cls = "sm"): Segmented<Base> {
  return segmented(
    BASE_ORDER.map((b) => ({ value: b, label: BASE_NAMES[b] })),
    { value: base, onPick, cls },
  );
}

export class ValueCard implements StripHost {
  root: HTMLElement;
  sel: [number, number] | null = null;
  private anchor: number | null = null;
  private rowAnchor: number | null = null;

  private strips = new Map<number, BitStrip>();
  private cmpStrips = new Map<number, BitStrip>();
  private rowBases = new Map<number, Segmented<Base>>();
  private rowEdits = new Map<number, NumberInput>();
  private rowReadouts = new Map<number, HTMLElement>();
  private cmpEdits = new Map<number, NumberInput>();
  private cmpReadouts = new Map<number, HTMLElement>();
  private cmpBases = new Map<number, HTMLElement>();
  private groupEdits: [Group, NumberInput, Segmented<Base>][] = [];
  private baseEdits = new Map<Base, NumberInput>();
  private fullBase!: Segmented<Base>;
  private fullEdit!: NumberInput;
  private selLabel!: HTMLElement;
  private groupBtn!: HTMLButtonElement;
  private clearSelBtn!: HTMLButtonElement;
  private stats = new Map<string, HTMLElement>();
  private statsEl!: HTMLElement;
  private listener = (k: ChangeKind) => this.onModel(k);

  constructor(
    public model: ValueModel,
    private events: CardEvents,
  ) {
    this.root = h("section", { class: "card" });
    model.subscribe(this.listener);
    this.rebuild();
  }

  detach() {
    this.model.unsubscribe(this.listener);
    for (const s of [...this.strips.values(), ...this.cmpStrips.values()]) s.destroy();
  }

  private onModel(kind: ChangeKind) {
    if (kind === "structure" || kind === "groups") this.rebuild();
    else if (kind !== "meta") this.refresh();
  }

  private get line(): boolean {
    return this.model.view === "line";
  }

  // ================================================================ building
  rebuild() {
    for (const s of [...this.strips.values(), ...this.cmpStrips.values()]) s.destroy();
    this.strips.clear();
    this.cmpStrips.clear();
    this.rowBases.clear();
    this.rowEdits.clear();
    this.rowReadouts.clear();
    this.cmpEdits.clear();
    this.cmpReadouts.clear();
    this.cmpBases.clear();
    const m = this.model;
    const focusedName =
      document.activeElement?.classList.contains("name-edit") && this.root.contains(document.activeElement);

    const rows = h("div", { class: `rows ${this.line ? "line" : "grid"}` });
    for (const lo of m.rowLos()) {
      if (this.line) {
        rows.append(this.buildLineRow(lo));
        if (m.hasCompare(lo)) rows.append(this.buildLineCompareRow(lo));
      } else {
        rows.append(this.buildRow(lo));
        if (m.hasCompare(lo)) rows.append(this.buildCompareRow(lo));
      }
    }
    this.root.replaceChildren(
      ...[
        this.buildHeader(),
        this.buildToolbar(),
        rows,
        this.buildBases(),
        this.buildFields(),
        this.buildStats(),
      ].filter((x): x is HTMLElement => x !== null),
    );
    if (focusedName) (this.root.querySelector(".name-edit") as HTMLElement).focus();
    this.refresh();
  }

  private buildHeader(): HTMLElement {
    const m = this.model;
    const name = h("input", {
      class: "name-edit",
      value: m.name,
      placeholder: "Name",
      spellcheck: false,
      tip: "Click to rename",
    });
    name.addEventListener("input", () => m.setName(name.value));
    name.addEventListener("keydown", (e) => e.key === "Enter" && name.blur());

    this.fullBase = baseSeg(m.fullBase, (b) => m.setFullBase(b), "");
    setTip(this.fullBase.el, "Number base of the whole value");
    this.fullEdit = new NumberInput(m.width, m.fullBase, (v) => m.setValue(v), {
      allowNegative: true,
      group: true,
      cls: "value-edit",
    });

    const copyBtn = button({ icon: Copy, label: "Copy", cls: "outline", tip: "Copy the whole value to the clipboard" });
    copyBtn.addEventListener("click", () =>
      openMenu(
        BASE_ORDER.map((b) => ({
          label: `Copy as ${BASE_NAMES[b]}`,
          action: () => this.copy(m.value, b, m.width),
        })),
        copyBtn,
      ),
    );
    const more = button({ icon: Ellipsis, cls: "ghost", tip: "More" });
    more.addEventListener("click", () =>
      openMenu(
        [
          { label: "Move up", icon: ArrowUp, action: () => this.events.move(this, -1) },
          { label: "Move down", icon: ArrowDown, action: () => this.events.move(this, +1) },
          { label: "Duplicate", icon: CopyPlus, action: () => this.events.duplicate(this) },
          { label: "Change width…", icon: Ruler, action: () => this.events.resize(this) },
          { label: m.showBases ? "Hide all bases" : "Show all bases", icon: Binary, action: () => this.toggleBases() },
          "sep",
          { label: "Remove value", icon: Trash, danger: true, action: () => this.events.remove(this) },
        ],
        more,
      ),
    );

    return h(
      "header",
      { class: "card-head" },
      name,
      h(
        "button",
        {
          type: "button",
          class: `badge${m.width > 32 ? " wide" : ""}`,
          tip: "Change width…",
          onClick: () => this.events.resize(this),
        },
        `${m.width}-bit`,
      ),
      h("div", { class: "spacer-sm" }),
      this.fullBase.el,
      this.fullEdit.el,
      copyBtn,
      more,
    );
  }

  private buildToolbar(): HTMLElement {
    const m = this.model;
    const view = segmented(VIEW_UI, { value: m.view, onPick: (v) => m.setView(v) });
    let mid: HTMLElement;
    if (this.line) {
      mid = button({
        icon: GitCompareArrows,
        label: "Compare",
        cls: `outline${m.hasCompare(0) ? " on" : ""}`,
        tip: "Show a linked compare row under the bits",
        onClick: () => (m.hasCompare(0) ? m.removeCompare(0) : m.addCompare(0)),
      });
    } else {
      mid = button({
        icon: ArrowUpDown,
        label: m.msbFirst ? "MSB row first" : "LSB row first",
        cls: "outline",
        tip: "Toggle row order. LSB first in byte view is the little-endian memory order.",
        onClick: () => m.setMsbFirst(!m.msbFirst),
      });
    }
    const ops = segmented(OPS_UI, { checkable: false, onPick: (op) => this.op(() => m.opValue(op)), cls: "ops" });
    const bases = button({
      icon: Binary,
      label: "Bases",
      cls: `outline${m.showBases ? " on" : ""}`,
      tip: "Show the value in every base (BIN · OCT · DEC · HEX)",
      onClick: () => this.toggleBases(),
    });

    this.selLabel = h("span", { class: "sel-label mono" });
    this.groupBtn = button({
      icon: GroupIcon,
      label: "Group selection",
      cls: "accent-ghost",
      tip: "Make the selected bits a named register field (Ctrl+G)",
      onClick: () => this.createGroupFromSelection(),
    });
    this.groupBtn.dataset.keepSel = "";
    this.clearSelBtn = button({
      icon: X,
      cls: "ghost",
      tip: "Clear selection (Esc)",
      onClick: () => this.clearSelection(),
    });
    return h(
      "div",
      { class: "card-tools" },
      view.el,
      mid,
      bases,
      ops.el,
      h("div", { class: "spacer" }),
      this.selLabel,
      this.groupBtn,
      this.clearSelBtn,
    );
  }

  private rowMenuButton(lo: number, compare: boolean): HTMLButtonElement {
    const b = button({ icon: Ellipsis, cls: "ghost sm", tip: compare ? "Compare row operations" : "Row operations" });
    b.addEventListener("click", () => openMenu(this.rowMenu(lo, compare, null), b));
    return b;
  }

  private readout(): HTMLElement {
    return h("span", { class: "readout mono" });
  }

  // ------------------------------------------------------------ line view
  private buildLineRow(lo: number): HTMLElement {
    const strip = new BitStrip(this, lo, false, true);
    this.strips.set(lo, strip);
    return h("div", { class: `row line-row${this.model.hasCompare(lo) ? " linked" : ""}` }, strip.el);
  }

  private buildLineCompareRow(lo: number): HTMLElement {
    const m = this.model;
    const base = h("span", { class: "muted mono small", tip: "Uses the value's base" });
    this.cmpBases.set(lo, base);
    const edit = new NumberInput(m.rowWidthAt(lo), m.fullBase, (v) => m.setCompare(lo, v), {
      group: true,
      cls: "cmp-edit",
    });
    this.cmpEdits.set(lo, edit);
    const ro = this.readout();
    this.cmpReadouts.set(lo, ro);
    const strip = new BitStrip(this, lo, true, true);
    this.cmpStrips.set(lo, strip);
    return h(
      "div",
      { class: "row cmp-row cmp-line" },
      h(
        "div",
        { class: "cmp-bar" },
        h(
          "span",
          { class: "cmp-label", tip: "Independent value compared against the bits above" },
          icon(GitCompareArrows, 14),
          "Compare",
        ),
        base,
        edit.el,
        ro,
        h("div", { class: "spacer" }),
        button({
          icon: X,
          label: "Remove",
          cls: "ghost danger sm",
          tip: "Remove this compare row",
          onClick: () => this.removed(() => m.removeCompare(lo)),
        }),
        this.rowMenuButton(lo, true),
      ),
      strip.el,
    );
  }

  // ------------------------------------------------------------ byte / nibble view
  private buildRow(lo: number): HTMLElement {
    const m = this.model;
    const hi = lo + m.rowWidthAt(lo) - 1;
    const label = h(
      "button",
      {
        type: "button",
        class: "row-label",
        tip: "Click to select this row · Shift+click to extend over consecutive rows",
      },
      h("b", {}, m.rowTitle(lo)),
      h("span", { class: "muted mono" }, `[${hi}:${lo}]`),
    );
    label.addEventListener("click", (e) => this.rowLabelClicked(lo, e.shiftKey));

    const strip = new BitStrip(this, lo);
    this.strips.set(lo, strip);
    const seg = baseSeg(m.rowBase(lo), (b) => m.setRowBase(lo, b), "xs");
    this.rowBases.set(lo, seg);
    const edit = new NumberInput(m.rowWidthAt(lo), m.rowBase(lo), (v) => m.setRowValue(lo, v), {
      cls: `row-edit w${m.rowWidth}`,
    });
    this.rowEdits.set(lo, edit);
    const ro = this.readout();
    ro.classList.toggle("off", !S.get("show_readouts"));
    this.rowReadouts.set(lo, ro);
    const cmp = button({
      icon: GitCompareArrows,
      label: "Compare",
      cls: `ghost sm${m.hasCompare(lo) ? " on" : ""}`,
      tip: "Show a linked compare row under this one",
      onClick: () => (m.hasCompare(lo) ? m.removeCompare(lo) : m.addCompare(lo)),
    });
    return h(
      "div",
      { class: `row${m.hasCompare(lo) ? " linked" : ""}` },
      label,
      strip.el,
      seg.el,
      edit.el,
      ro,
      cmp,
      this.rowMenuButton(lo, false),
    );
  }

  private buildCompareRow(lo: number): HTMLElement {
    const m = this.model;
    const strip = new BitStrip(this, lo, true);
    this.cmpStrips.set(lo, strip);
    const base = h("span", { class: "cmp-base muted mono small", tip: "Uses the parent row's base" });
    this.cmpBases.set(lo, base);
    const edit = new NumberInput(m.rowWidthAt(lo), m.rowBase(lo), (v) => m.setCompare(lo, v), {
      cls: `row-edit w${m.rowWidth}`,
    });
    this.cmpEdits.set(lo, edit);
    const ro = this.readout();
    this.cmpReadouts.set(lo, ro);
    return h(
      "div",
      { class: "row cmp-row" },
      h(
        "span",
        {
          class: "cmp-label",
          tip: `Independent value compared against ${m.rowTitle(lo)}; it shares that row's fields`,
        },
        icon(GitCompareArrows, 14),
        "Compare",
      ),
      strip.el,
      base,
      edit.el,
      ro,
      button({
        icon: X,
        label: "Remove",
        cls: "ghost danger sm",
        tip: "Remove this compare row",
        onClick: () => this.removed(() => m.removeCompare(lo)),
      }),
      this.rowMenuButton(lo, true),
    );
  }

  // ------------------------------------------------------------ fields & stats
  private buildFields(): HTMLElement {
    const m = this.model;
    this.groupEdits = [];
    const head = h(
      "div",
      { class: "fields-head" },
      icon(Layers, 15, "muted"),
      h("span", { class: "fields-title" }, "Register fields"),
      m.groups.length ? h("span", { class: "count" }, String(m.groups.length)) : null,
      m.groups.length
        ? null
        : h(
            "span",
            { class: "muted small hint" },
            "Drag across bits (or click a row label, then Shift+click another) and press “Group selection”. Fields may span rows; they cannot overlap.",
          ),
    );
    const list = h("div", { class: "fields-list" });
    for (const g of m.groups) {
      const sw = h("button", { type: "button", class: "swatch", style: `--g:${g.color}`, tip: "Change colour" });
      sw.addEventListener("click", () => this.pickColor(g, sw));
      const name = h("input", { class: "field", value: g.name, placeholder: "Field name", spellcheck: false });
      name.addEventListener("input", () => m.updateGroup(g, { name: name.value }));
      const seg = baseSeg(g.base, (b) => m.updateGroup(g, { base: b }), "xs");
      const edit = new NumberInput(g.width, g.base, (v) => m.setGroupValue(g, v), { cls: "group-edit" });
      edit.el.style.setProperty("--chars", String(Math.min(Math.max(g.width, 4), 34)));
      this.groupEdits.push([g, edit, seg]);
      list.append(
        h(
          "div",
          { class: "field-row" },
          sw,
          name,
          h("span", { class: "muted mono small range" }, `${g.label()} · ${g.width} bit${g.width > 1 ? "s" : ""}`),
          seg.el,
          edit.el,
          button({
            icon: MousePointerClick,
            cls: "ghost sm",
            tip: "Select this field's bits",
            onClick: () => this.setSelection(g.lo, g.hi),
          }),
          button({
            icon: Trash,
            cls: "ghost danger sm",
            tip: "Remove this field",
            onClick: () => this.removed(() => m.removeGroup(g)),
          }),
        ),
      );
    }
    return h("div", { class: `fields${m.groups.length ? "" : " no-fields"}` }, head, m.groups.length ? list : null);
  }

  /** The value in every base, each line editable and copyable. */
  private buildBases(): HTMLElement | null {
    const m = this.model;
    this.baseEdits.clear();
    if (!m.showBases) return null;
    const list = h("div", { class: "bases-list" });
    for (const b of [16, 10, 8, 2] as Base[]) {
      const edit = new NumberInput(m.width, b, (v) => m.setValue(v), {
        allowNegative: b === 10,
        group: true,
        cls: "bases-edit",
      });
      this.baseEdits.set(b, edit);
      list.append(
        h(
          "div",
          { class: "bases-row" },
          h("span", { class: "bases-name" }, BASE_NAMES[b], h("small", {}, `base ${b}`)),
          edit.el,
          button({
            icon: Copy,
            cls: "ghost sm",
            tip: `Copy as ${BASE_NAMES[b]}`,
            onClick: () => this.copy(m.value, b, m.width),
          }),
        ),
      );
    }
    return h(
      "div",
      { class: "bases" },
      h(
        "div",
        { class: "fields-head" },
        icon(Binary, 15, "muted"),
        h("span", { class: "fields-title" }, "All bases"),
        h("span", { class: "muted small hint" }, "Type into any line to change the value"),
        h("div", { class: "spacer" }),
        button({ icon: X, cls: "ghost sm", tip: "Hide all bases", onClick: () => this.toggleBases() }),
      ),
      list,
    );
  }

  private toggleBases() {
    play("toggle");
    this.model.setShowBases(!this.model.showBases);
  }

  private op(f: () => void) {
    f();
    play("op");
  }

  private removed(f: () => void) {
    f();
    play("remove");
  }

  private buildStats(): HTMLElement {
    const w = this.model.width;
    const defs: [string, string, string][] = [
      ["u", `u${w}`, `Unsigned ${w}-bit integer`],
      ["s", `s${w}`, `Signed ${w}-bit integer (two's complement)`],
      ["pop", "set bits", "Number of bits set to 1"],
    ];
    // IEEE-754 only defines the float view for these widths
    if (w === 32 || w === 64) defs.push(["float", `float${w}`, `IEEE-754 float${w} interpretation of the bits`]);
    this.stats.clear();
    this.statsEl = h("div", { class: "stats" });
    for (const [k, label, tip] of defs) {
      const val = h("span", { class: "stat-val mono" });
      this.stats.set(k, val);
      this.statsEl.append(h("div", { class: `stat stat-${k}`, tip }, h("span", { class: "stat-label" }, label), val));
    }
    this.statsEl.hidden = !S.get("show_interp");
    return this.statsEl;
  }

  // ================================================================ refresh
  refresh() {
    const m = this.model;
    this.fullBase.set(m.fullBase);
    this.fullEdit.setFormat(m.width, m.fullBase);
    this.fullEdit.setValue(m.value);

    for (const [lo, strip] of this.strips) {
      const base = this.line ? m.fullBase : m.rowBase(lo);
      const val = m.rowValue(lo);
      const edit = this.rowEdits.get(lo);
      if (edit) {
        this.rowBases.get(lo)!.set(base);
        edit.setFormat(m.rowWidthAt(lo), base);
        edit.setValue(val);
        this.rowReadouts.get(lo)!.textContent = this.readoutText(val, m.rowWidthAt(lo));
      }
      strip.update();
      const cs = this.cmpStrips.get(lo);
      if (cs) {
        this.cmpBases.get(lo)!.textContent = BASE_NAMES[base];
        this.cmpEdits.get(lo)!.setFormat(m.rowWidthAt(lo), base);
        this.cmpEdits.get(lo)!.setValue(m.compareValue(lo));
        const diff = m.compareDiff(lo);
        const ro = this.cmpReadouts.get(lo)!;
        if (diff) {
          const n = popcount(diff);
          ro.replaceChildren(
            h("span", { class: "diff-text" }, `Δ ${n} bit${n > 1 ? "s" : ""}`),
            ` · XOR ${formatInt(diff, 16, m.rowWidthAt(lo), { prefix: true, group: this.line })}`,
          );
        } else ro.replaceChildren(h("span", { class: "same-text" }, "identical"));
        cs.update();
      }
    }
    for (const edit of this.baseEdits.values()) {
      edit.setFormat(m.width, edit.base);
      edit.setValue(m.value);
    }
    for (const [g, edit, seg] of this.groupEdits) {
      seg.set(g.base);
      edit.setFormat(g.width, g.base);
      edit.setValue(m.groupValue(g));
    }
    if (S.get("show_interp")) this.updateStats();
    this.updateSelUi();
  }

  private readoutText(v: bigint, w: number): string {
    const parts = [formatInt(v, 16, w, { prefix: true }), v.toString(), formatInt(v, 8, w, { prefix: true })];
    if (w === 8 && v >= 0x20n && v < 0x7fn) parts.push(`'${String.fromCharCode(Number(v))}'`);
    return parts.join(" · ");
  }

  private updateStats() {
    const { width: w, value: v } = this.model;
    this.stats.get("u")!.textContent = v.toString();
    this.stats.get("s")!.textContent = toSigned(v, w).toString();
    this.stats.get("pop")!.textContent = String(popcount(v));
    const fl = this.stats.get("float");
    if (fl) fl.textContent = formatFloat(asFloat(v, w), w);
  }

  // ================================================================ selection
  setSelection(a: number, b: number) {
    this.sel = [Math.min(a, b), Math.max(a, b)];
    this.repaintStrips();
    this.updateSelUi();
  }

  clearSelection() {
    this.anchor = null;
    this.rowAnchor = null;
    if (this.sel) {
      this.sel = null;
      this.repaintStrips();
      this.updateSelUi();
    }
  }

  beginDrag(bit: number) {
    this.anchor = bit;
    this.rowAnchor = null;
  }

  updateDrag(bit: number) {
    if (this.anchor === null) return;
    const before = this.sel?.join();
    this.setSelection(this.anchor, bit);
    if (this.sel?.join() !== before) play("select");
  }

  extendSelection(bit: number) {
    if (this.anchor === null) this.anchor = this.sel ? this.sel[0] : bit;
    this.setSelection(this.anchor, bit);
  }

  private rowLabelClicked(lo: number, shift: boolean) {
    const top = (r: number) => r + this.model.rowWidthAt(r) - 1;
    if (shift && this.rowAnchor !== null) {
      const a = this.rowAnchor;
      this.setSelection(Math.min(a, lo), top(Math.max(a, lo)));
    } else {
      this.rowAnchor = lo;
      this.anchor = null;
      this.setSelection(lo, top(lo));
    }
  }

  private repaintStrips() {
    for (const s of this.strips.values()) s.update();
  }

  private updateSelUi() {
    if (this.sel) {
      const [lo, hi] = this.sel;
      const w = hi - lo + 1;
      const rng = w > 1 ? `[${hi}:${lo}]` : `[${lo}]`;
      this.selLabel.textContent = `${rng} · ${w} bit${w > 1 ? "s" : ""} = ${formatInt(this.model.bitsValue(lo, w), 16, w, { prefix: true })}`;
      this.selLabel.classList.add("active");
    } else {
      this.selLabel.textContent = "drag across bits to select";
      this.selLabel.classList.remove("active");
    }
    this.groupBtn.disabled = !this.sel;
    this.clearSelBtn.hidden = !this.sel;
  }

  // ================================================================ actions
  async createGroupFromSelection() {
    if (!this.sel) return;
    const [lo, hi] = this.sel;
    const clash = this.model.overlapping(lo, hi);
    if (clash.length) {
      play("error");
      await ask(
        "Fields cannot overlap",
        `The selection [${hi}:${lo}] overlaps ${clash.map((g) => `“${g.name}” ${g.label()}`).join(", ")}. ` +
          "Remove that field first or select a different range.",
        [{ id: "ok", label: "OK", cls: "primary" }],
        "ok",
      );
      return;
    }
    const suggestion = this.model.suggestGroupName();
    const name = await prompt(
      "New register field",
      `Name for bits [${hi}:${lo}] (${hi - lo + 1} bits)`,
      suggestion,
      Tag,
    );
    if (name === null) return;
    try {
      this.model.addGroup(lo, hi, name.trim() || suggestion);
      play("group");
    } catch (e) {
      if (e instanceof ModelError) toast(e.message, "error");
      return;
    }
    this.clearSelection();
  }

  private pickColor(g: Group, anchor: HTMLElement | { x: number; y: number }) {
    const custom = () => {
      const input = h("input", { type: "color", value: g.color, class: "hidden-color" });
      document.body.append(input);
      input.addEventListener("input", () => this.model.updateGroup(g, { color: input.value }));
      input.addEventListener("change", () => {
        input.remove();
        this.rebuild();
      });
      input.click();
    };
    openMenu(
      [
        ...GROUP_COLORS.map(
          (c): MenuItem => ({
            label: c.toUpperCase(),
            swatch: c,
            action: () => {
              this.model.updateGroup(g, { color: c });
              this.rebuild();
            },
          }),
        ),
        "sep",
        { label: "Custom colour…", icon: Palette, action: custom },
      ],
      anchor,
    );
  }

  private async renameGroup(g: Group) {
    const name = await prompt("Rename field", "Field name", g.name, PencilLine);
    if (name?.trim()) {
      this.model.updateGroup(g, { name: name.trim() });
      this.rebuild();
    }
  }

  private copy(v: bigint, base: Base, width: number) {
    const text = formatInt(v, base, width, { prefix: true });
    copyText(text).then(
      () => {
        play("copy");
        toast(`Copied ${text}`, "ok");
      },
      () => toast("Could not access the clipboard", "error"),
    );
  }

  openRowMenu(lo: number, compare: boolean, bit: number | null, at: { x: number; y: number }) {
    openMenu(this.rowMenu(lo, compare, bit), at);
  }

  private rowMenu(lo: number, compare: boolean, bit: number | null): MenuItem[] {
    const m = this.model;
    const rw = m.rowWidthAt(lo);
    const items: MenuItem[] = [];
    if (!compare) {
      items.push({
        label: "Group selection",
        icon: GroupIcon,
        shortcut: "Ctrl+G",
        disabled: !this.sel,
        action: () => this.createGroupFromSelection(),
      });
      const g = bit !== null ? m.groupAt(bit) : undefined;
      if (g) {
        items.push(
          { label: `Rename “${g.name}”…`, icon: PencilLine, action: () => this.renameGroup(g) },
          {
            label: `Colour of “${g.name}”`,
            icon: Palette,
            submenu: [
              ...GROUP_COLORS.map(
                (c): MenuItem => ({
                  label: c.toUpperCase(),
                  swatch: c,
                  action: () => {
                    m.updateGroup(g, { color: c });
                    this.rebuild();
                  },
                }),
              ),
            ],
          },
          { label: `Select “${g.name}”`, icon: MousePointerClick, action: () => this.setSelection(g.lo, g.hi) },
          {
            label: `Remove “${g.name}”`,
            icon: Trash,
            danger: true,
            action: () => this.removed(() => m.removeGroup(g)),
          },
        );
      }
      items.push("sep");
    }
    for (const [op, text] of ROW_OPS) {
      items.push({ label: text, action: () => this.op(() => (compare ? m.opCompare(lo, op) : m.opRow(lo, op))) });
    }
    items.push(
      "sep",
      {
        label: "Copy",
        icon: Copy,
        submenu: BASE_ORDER.map(
          (b): MenuItem => ({
            label: `as ${BASE_NAMES[b]}`,
            action: () => this.copy(compare ? m.compareValue(lo) : m.rowValue(lo), b, rw),
          }),
        ),
      },
      "sep",
    );
    if (compare) {
      items.push(
        { label: "Reset to parent value", icon: Undo2, action: () => m.setCompare(lo, m.rowValue(lo)) },
        { label: "Copy compare into parent", icon: ArrowUp, action: () => m.setRowValue(lo, m.compareValue(lo)) },
        { label: "Remove compare row", icon: X, danger: true, action: () => this.removed(() => m.removeCompare(lo)) },
      );
    } else if (m.hasCompare(lo)) {
      items.push({
        label: "Remove compare row",
        icon: X,
        danger: true,
        action: () => this.removed(() => m.removeCompare(lo)),
      });
    } else {
      items.push({ label: "Compare", icon: GitCompareArrows, action: () => m.addCompare(lo) });
    }
    return items;
  }

  bitTip(b: number, lo: number, compare: boolean): string {
    const m = this.model;
    const lines: string[] = [];
    if (compare) {
      const cv = m.compareBit(lo, b);
      const pv = m.bit(b);
      lines.push(`Bit ${b} (compare) = ${cv}` + (cv === pv ? "" : `   ≠ parent ${pv}`));
    } else lines.push(`Bit ${b} = ${m.bit(b)}`);
    const g = m.groupAt(b);
    if (g) lines.push(`${g.name} ${g.label()} = ${formatInt(m.groupValue(g), g.base, g.width, { prefix: true })}`);
    if (!compare) lines.push("Click: flip · Drag: select · Shift+click: extend");
    return lines.join("\n");
  }
}
