// The card that shows one 32/64-bit value: header, rows, compare rows,
// register fields and interpretations.
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Binary,
  BookmarkPlus,
  Camera,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Ellipsis,
  FileCode2,
  GitCompareArrows,
  GripVertical,
  Group as GroupIcon,
  History,
  type IconNode,
  Layers,
  LayoutTemplate,
  Lock,
  MousePointerClick,
  Palette,
  PencilLine,
  RectangleHorizontal,
  Rows3,
  Rows4,
  Ruler,
  SlidersVertical,
  SquareFunction,
  Tag,
  Trash,
  Undo2,
  X,
} from "lucide";
import { copyText } from "../app/platform";
import { S } from "../app/settings";
import { ExprError } from "../core/expr";
import { decodeField, isInvertible, rawFromNumber } from "../core/fieldfmt";
import { parseFloatText } from "../core/formats";
import {
  type ChangeKind,
  GROUP_COLORS,
  type Group,
  ModelError,
  type Op,
  type ValueModel,
  type View,
} from "../core/model";
import { BASE_NAMES, BASE_ORDER, type Base, formatInt, ParseError, popcount } from "../core/numfmt";
import { copyBytesMenu, pasteBytes } from "../dialogs/bytes";
import { exportCode } from "../dialogs/export";
import { editField } from "../dialogs/field";
import { pickTemplate, saveTemplate } from "../dialogs/templates";
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
} from "../ui/kit";
import { play } from "../ui/sound";
import { BitStrip, type StripHost } from "./bitstrip";
import { expressionBar } from "./exprbar";
import { moreOpsMenu } from "./ops-ui";
import { SelectionBar } from "./selbar";
import { StatsBar } from "./stats";

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
const SEL_NOTE = " — applies to the selection when bits are selected";
const OPS_UI: { value: Op; label?: string; icon?: IconNode; tip: string }[] = [
  { value: "invert", label: "NOT", tip: `Invert every bit (bitwise NOT)${SEL_NOTE}` },
  { value: "clear", label: "CLR", tip: `Clear every bit to 0${SEL_NOTE}` },
  { value: "set", label: "SET", tip: `Set every bit to 1${SEL_NOTE}` },
  { value: "shl", icon: ChevronsLeft, tip: `Logical shift left by one bit${SEL_NOTE}` },
  { value: "shr", icon: ChevronsRight, tip: `Logical shift right by one bit${SEL_NOTE}` },
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
  /** Value of another card by name, for expressions. */
  lookup(card: ValueCard, name: string): bigint | undefined;
  /** The other cards in the workspace. */
  others(card: ValueCard): ValueCard[];
  /** The drag handle was pressed: start reordering. */
  dragStart(card: ValueCard, e: PointerEvent): void;
  /** Group the following changes into one undo step (true) / end the group (false). */
  batch(on: boolean): void;
}

function baseSeg(base: Base, onPick: (b: Base) => void, cls = "sm"): Segmented<Base> {
  return segmented(
    BASE_ORDER.map((b) => ({ value: b, label: BASE_NAMES[b] })),
    { value: base, onPick, cls },
  );
}

interface FieldUi {
  g: Group;
  edit: NumberInput;
  seg: Segmented<Base>;
  decoded?: HTMLElement;
  named?: HTMLButtonElement;
  row?: HTMLElement;
}

/** "21.5 °C" → "21.5" when the unit is "°C". */
function stripUnit(text: string, unit: string): string {
  const t = text.trim();
  return unit && t.endsWith(unit) ? t.slice(0, -unit.length).trim() : t;
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
  private fieldUis: FieldUi[] = [];
  private rowsEl: HTMLElement | null = null;
  private static nextUid = 1;
  private readonly uid = ValueCard.nextUid++;
  cursor: number | null = null;
  /** Field names matching the current search, highlighted in the fields panel. */
  private fieldMatches = new Set<string>();
  private baseEdits = new Map<Base, NumberInput>();
  private fullBase!: Segmented<Base>;
  private fullEdit!: NumberInput;
  private selBar: SelectionBar;
  private groupBtn!: HTMLButtonElement;
  private clearSelBtn!: HTMLButtonElement;
  private statsBar: StatsBar;
  private exprOpen = false;
  private exprText = "";
  private listener = (k: ChangeKind) => this.onModel(k);

  constructor(
    public model: ValueModel,
    private events: CardEvents,
  ) {
    this.root = h("section", { class: "card" });
    this.selBar = new SelectionBar(model);
    this.statsBar = new StatsBar(model);
    model.subscribe(this.listener);
    this.rebuild();
  }

  /** Resolves a name in an expression: x / this / value, this card's fields, then other values. */
  lookup = (name: string): bigint | undefined => {
    const m = this.model;
    const n = name.trim().toLowerCase();
    if (["x", "this", "value", "v"].includes(n)) return m.value;
    const g = m.groups.find((f) => f.name.toLowerCase() === n);
    if (g) return m.groupValue(g);
    return this.events.lookup(this, name);
  };

  /** Width that operations act on: the selection, or the whole value. */
  private get opWidth(): number {
    return this.sel ? this.sel[1] - this.sel[0] + 1 : this.model.width;
  }

  /** Runs an operation on the selected bits, or on the whole value when nothing is selected. */
  applyOp(op: Op, arg?: bigint) {
    try {
      if (this.sel) this.model.opBits(this.sel[0], this.sel[1], op, arg);
      else this.model.opValue(op, arg);
      play("op");
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      play("error");
      toast(e.message, "error");
    }
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

    this.root.classList.toggle("collapsed", m.collapsed);
    if (m.collapsed) {
      // only the header line; the toolbar's buttons are still created because
      // selection code updates them
      this.fieldUis = [];
      const header = this.buildHeader();
      this.buildToolbar();
      this.root.replaceChildren(header);
      if (focusedName) (this.root.querySelector(".name-edit") as HTMLElement).focus();
      this.refresh();
      return;
    }

    const rows = h("div", {
      class: `rows ${this.line ? "line" : "grid"}`,
      tabindex: 0,
      role: "group",
      "aria-label": `Bits of ${m.name || "value"}. Arrow keys move, Space flips, 0 and 1 set, Shift+arrows select.`,
    });
    rows.addEventListener("keydown", (e) => this.onBitKey(e));
    this.rowsEl = rows;
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
        this.exprOpen ? this.buildExprBar() : null,
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
    const more = button({ icon: Ellipsis, cls: "ghost more-btn", tip: "More" });
    more.addEventListener("click", () =>
      openMenu(
        [
          {
            label: m.collapsed ? "Expand" : "Collapse",
            icon: m.collapsed ? ChevronRight : ChevronDown,
            action: () => this.toggleCollapsed(),
          },
          { label: "Snapshots", icon: Camera, submenu: this.snapshotMenu() },
          "sep",
          { label: "Move up", icon: ArrowUp, action: () => this.events.move(this, -1) },
          { label: "Move down", icon: ArrowDown, action: () => this.events.move(this, +1) },
          { label: "Duplicate", icon: CopyPlus, action: () => this.events.duplicate(this) },
          { label: "Change width…", icon: Ruler, action: () => this.events.resize(this) },
          "sep",
          { label: m.showBases ? "Hide all bases" : "Show all bases", icon: Binary, action: () => this.toggleBases() },
          {
            label: this.exprOpen ? "Hide expression bar" : "Expression bar",
            icon: SquareFunction,
            action: () => this.toggleExpr(),
          },
          "sep",
          { label: "Apply template…", icon: LayoutTemplate, action: () => this.applyTemplate() },
          {
            label: "Save fields as template…",
            icon: BookmarkPlus,
            disabled: !m.groups.length,
            action: () => this.saveAsTemplate(),
          },
          { label: "Export code…", icon: FileCode2, action: () => this.exportCode() },
          "sep",
          { label: "Paste bytes…", icon: ClipboardPaste, action: () => this.pasteBytes() },
          {
            label: "Copy as bytes",
            icon: Copy,
            submenu: copyBytesMenu(
              () => m.value,
              m.width,
              (t) => this.copyText(t),
            ),
          },
          {
            label: "Compare with",
            icon: GitCompareArrows,
            disabled: this.events.others(this).length === 0,
            submenu: this.events.others(this).map((o) => ({
              label: `${o.model.name || "(unnamed)"}  ·  ${o.model.width}-bit`,
              action: () => {
                m.compareWith(o.model.value);
                play("toggle");
              },
            })),
          },
          "sep",
          { label: "Remove value", icon: Trash, danger: true, action: () => this.events.remove(this) },
        ],
        more,
      ),
    );

    const grip = h(
      "button",
      { type: "button", class: "grip", tip: "Drag to reorder", "aria-label": "Drag to reorder" },
      icon(GripVertical, 16),
    );
    grip.addEventListener("pointerdown", (e) => {
      if (e.button === 0) this.events.dragStart(this, e);
    });
    const collapse = button({
      icon: m.collapsed ? ChevronRight : ChevronDown,
      cls: "ghost sm collapse-btn",
      tip: m.collapsed ? "Expand" : "Collapse to the header line",
      onClick: () => this.toggleCollapsed(),
    });
    return h(
      "header",
      { class: "card-head" },
      grip,
      collapse,
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
    const ops = segmented(OPS_UI, { checkable: false, onPick: (op) => this.applyOp(op), cls: "ops" });
    const moreOps = button({
      icon: ChevronDown,
      cls: "ghost sm more-ops",
      tip: `More operations: rotate, swap bytes, reverse, negate, AND/OR/XOR…${SEL_NOTE}`,
    });
    moreOps.dataset.keepSel = "";
    moreOps.addEventListener("click", () =>
      openMenu(
        moreOpsMenu((op, arg) => this.applyOp(op, arg), this.opWidth, this.lookup),
        moreOps,
      ),
    );
    const expr = button({
      icon: SquareFunction,
      cls: `outline expr-toggle${this.exprOpen ? " on" : ""}`,
      tip: "Expression bar: type a calculation to set the value (or the selected bits)",
      onClick: () => this.toggleExpr(),
    });
    expr.dataset.keepSel = "";
    ops.el.dataset.keepSel = "";
    const bases = button({
      icon: Binary,
      label: "Bases",
      cls: `outline${m.showBases ? " on" : ""}`,
      tip: "Show the value in every base (BIN · OCT · DEC · HEX)",
      onClick: () => this.toggleBases(),
    });

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
      h("div", { class: "ops-wrap" }, ops.el, moreOps),
      expr,
      h("div", { class: "spacer" }),
      this.selBar.el,
      this.groupBtn,
      this.clearSelBtn,
    );
  }

  private buildExprBar(): HTMLElement {
    return expressionBar({
      width: () => this.opWidth,
      lookup: this.lookup,
      target: () => (this.sel ? `bits [${this.sel[1]}:${this.sel[0]}]` : "value"),
      text: this.exprText,
      onText: (s) => {
        this.exprText = s;
      },
      apply: (v) => {
        if (this.sel) this.model.setBitsValue(this.sel[0], this.opWidth, v);
        else this.model.setValue(v);
        play("op");
      },
      close: () => this.toggleExpr(false),
    });
  }

  toggleExpr(open = !this.exprOpen) {
    this.exprOpen = open;
    play("toggle");
    this.rebuild();
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
    this.fieldUis = [];
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
      h("div", { class: "spacer" }),
      button({
        icon: LayoutTemplate,
        label: "Templates",
        cls: "ghost sm",
        tip: "Apply a field layout (IEEE-754, RGB565, IPv4, your own…)",
        onClick: () => this.applyTemplate(),
      }),
    );
    const list = h("div", { class: "fields-list" });
    for (const g of m.groups) list.append(this.buildFieldRow(g));
    return h("div", { class: `fields${m.groups.length ? "" : " no-fields"}` }, head, m.groups.length ? list : null);
  }

  private buildFieldRow(g: Group): HTMLElement {
    const m = this.model;
    const sw = h("button", { type: "button", class: "swatch", style: `--g:${g.color}`, tip: "Change colour" });
    sw.addEventListener("click", () => this.pickColor(g, sw));
    const name = h("input", { class: "field", value: g.name, placeholder: "Field name", spellcheck: false });
    name.addEventListener("input", () => m.updateGroup(g, { name: name.value }));
    if (g.description) setTip(name, g.description);
    const seg = baseSeg(g.base, (b) => m.updateGroup(g, { base: b }), "xs");
    const edit = new NumberInput(g.width, g.base, (v) => m.setGroupValue(g, v), { cls: "group-edit" });
    edit.el.style.setProperty("--chars", String(Math.min(Math.max(g.width, 4), 34)));
    const ui: FieldUi = { g, edit, seg };

    // the field's meaning: signed number / formula result with unit
    let decoded: HTMLElement | null = null;
    if (g.signed || g.formula || g.unit) {
      if (isInvertible(g)) {
        const input = h("input", {
          class: "field mono decoded-edit",
          spellcheck: false,
          tip: "Type a value to set the raw bits",
        });
        const commit = () => {
          if (input.dataset.dirty !== "1") return;
          input.dataset.dirty = "";
          try {
            const y = parseFloatText(stripUnit(input.value, g.unit));
            m.setGroupValue(g, rawFromNumber(g, y));
            input.classList.remove("invalid");
          } catch (e) {
            if (!(e instanceof ExprError || e instanceof ParseError)) throw e;
            input.classList.add("invalid");
            play("error");
            toast(e.message, "error");
          }
        };
        input.addEventListener("input", () => {
          input.dataset.dirty = "1";
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            e.stopPropagation();
            input.dataset.dirty = "";
            input.blur();
          }
        });
        input.addEventListener("blur", () => {
          commit();
          this.refresh();
        });
        ui.decoded = input;
        decoded = h("span", { class: "decoded" }, input, g.unit ? h("span", { class: "muted small" }, g.unit) : null);
      } else {
        const span = h("span", {
          class: "decoded-ro mono",
          tip: "Not linear, so it can't be typed in; edit the raw value",
        });
        ui.decoded = span;
        decoded = span;
      }
    }
    // named values
    let named: HTMLButtonElement | null = null;
    if (g.named.length) {
      named = h("button", { type: "button", class: "btn outline sm named-pick", tip: "Pick a named value" });
      named.addEventListener("click", () =>
        openMenu(
          g.named.map((n) => ({
            label: `${n.label}  ·  ${formatInt(n.value, g.base, g.width, { prefix: true })}`,
            checked: m.groupValue(g) === n.value,
            action: () => {
              m.setGroupValue(g, n.value);
              play("toggle");
            },
          })),
          named as HTMLButtonElement,
        ),
      );
      ui.named = named;
    }
    this.fieldUis.push(ui);
    const row = h(
      "div",
      { class: `field-row${g.protected ? " protected" : ""}` },
      sw,
      name,
      h(
        "span",
        { class: "muted mono small range" },
        g.protected ? icon(Lock, 12, "lock") : null,
        `${g.label()} · ${g.width} bit${g.width > 1 ? "s" : ""}`,
      ),
      seg.el,
      edit.el,
      decoded,
      named,
      h("div", { class: "spacer" }),
      button({
        icon: SlidersVertical,
        cls: "ghost sm",
        tip: "Field details: description, signed, formula & unit, named values, access",
        onClick: () => this.editFieldDetails(g),
      }),
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
    );
    ui.row = row;
    row.classList.toggle("match", this.fieldMatches.has(g.name));
    return row;
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

  toggleBases() {
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
    this.statsBar.build();
    return this.statsBar.el;
  }

  async pasteBytes() {
    const v = await pasteBytes(this.model.width);
    if (v !== null) {
      this.model.setValue(v);
      play("op");
    }
  }

  // ------------------------------------------------------------ keyboard & paint
  bitId(bit: number): string {
    return `v${this.uid}-bit${bit}`;
  }

  setCursor(bit: number, focus = true) {
    const m = this.model;
    this.cursor = Math.max(0, Math.min(m.width - 1, bit));
    this.repaintStrips();
    this.rowsEl?.setAttribute("aria-activedescendant", this.bitId(this.cursor));
    if (focus) this.rowsEl?.focus({ preventScroll: true });
    document.getElementById(this.bitId(this.cursor))?.scrollIntoView({ block: "nearest" });
  }

  /** How many bits "up" moves the cursor (rows or wrapped lines above have higher bits when MSB comes first). */
  private verticalStep(): number {
    const m = this.model;
    const strip = this.strips.values().next().value;
    const per = strip?.lineBits ?? m.rowWidth;
    const higherAbove = this.line ? S.get("msb_left") : m.msbFirst;
    return higherAbove ? per : -per;
  }

  private onBitKey(e: KeyboardEvent) {
    const m = this.model;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const cur = this.cursor ?? m.width - 1;
    const left = S.get("msb_left") ? 1 : -1; // moving left goes to a higher bit when the MSB is on the left
    const moves: Record<string, number> = {
      ArrowLeft: left,
      ArrowRight: -left,
      ArrowUp: this.verticalStep(),
      ArrowDown: -this.verticalStep(),
    };
    let next: number | null = null;
    if (e.key in moves) next = cur + moves[e.key];
    else if (e.key === "Home") next = m.width - 1;
    else if (e.key === "End") next = 0;
    if (next !== null) {
      e.preventDefault();
      // up/down past the first/last line stays put; left/right stop at the ends
      const vertical = e.key === "ArrowUp" || e.key === "ArrowDown";
      if (vertical && (next < 0 || next >= m.width)) next = cur;
      next = Math.max(0, Math.min(m.width - 1, next));
      if (e.shiftKey) {
        if (this.anchor === null) this.anchor = this.sel ? (this.sel[0] === cur ? this.sel[1] : this.sel[0]) : cur;
        this.setSelection(this.anchor, next);
        play("select");
      } else if (this.cursor === null) next = cur;
      this.setCursor(next);
      return;
    }
    if (this.cursor === null) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      void this.flipBit(this.cursor);
    } else if (e.key === "0" || e.key === "1") {
      e.preventDefault();
      if (m.bit(this.cursor) !== Number(e.key)) void this.flipBit(this.cursor);
    }
  }

  paintStart() {
    this.events.batch(true);
    this.clearSelection();
  }

  paintBit(bit: number, on: boolean) {
    const g = this.model.groupAt(bit);
    if (g?.protected && !this.unlocked.has(g)) return; // painting never touches protected fields
    if (this.model.bit(bit) === (on ? 1 : 0)) return;
    this.model.setBitsValue(bit, 1, on ? 1n : 0n);
    play(on ? "bitOn" : "bitOff");
  }

  paintEnd() {
    this.events.batch(false);
  }

  /** Highlights fields that match a search (empty set clears). */
  markMatches(names: Set<string>) {
    this.fieldMatches = names;
    for (const f of this.fieldUis) f.row?.classList.toggle("match", names.has(f.g.name));
  }

  // ------------------------------------------------------------ collapse & snapshots
  toggleCollapsed(collapsed = !this.model.collapsed) {
    play("toggle");
    this.model.setCollapsed(collapsed);
  }

  private snapshotMenu(): MenuItem[] {
    const m = this.model;
    const time = (at: number) =>
      at ? new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "";
    const items: MenuItem[] = [{ label: "Take snapshot…", icon: Camera, action: () => this.takeSnapshot() }];
    if (m.snapshots.length) items.push("sep");
    for (const snap of [...m.snapshots].reverse()) {
      items.push({
        label: `${snap.name}  ·  ${formatInt(snap.value & m.mask, 16, m.width, { prefix: true, group: true })}`,
        icon: History,
        submenu: [
          { label: time(snap.at) || "Snapshot", disabled: true },
          "sep",
          {
            label: "Restore this value",
            icon: Undo2,
            action: () => {
              m.setValue(snap.value);
              play("op");
              toast(`Restored “${snap.name}”`, "ok");
            },
          },
          {
            label: "Compare with current",
            icon: GitCompareArrows,
            action: () => {
              m.compareWith(snap.value);
              play("toggle");
            },
          },
          "sep",
          {
            label: "Delete snapshot",
            icon: Trash,
            danger: true,
            action: () => this.removed(() => m.removeSnapshot(snap)),
          },
        ],
      });
    }
    return items;
  }

  async takeSnapshot() {
    const m = this.model;
    const name = await prompt(
      "Take snapshot",
      `Name for the current value of “${m.name || "value"}”`,
      `Snapshot ${m.snapshots.length + 1}`,
      Camera,
    );
    if (name === null) return;
    const snap = m.takeSnapshot(name);
    play("group");
    toast(`Saved snapshot “${snap.name}”`, "ok");
  }

  // ------------------------------------------------------------ field features
  /** Fields the user already agreed to change this session. */
  private unlocked = new WeakSet<Group>();

  /** Flips a bit; for read-only / reserved fields, asks first (once per field per session). */
  async flipBit(bit: number) {
    const m = this.model;
    const g = m.groupAt(bit);
    if (g?.protected && !this.unlocked.has(g)) {
      play("error");
      const kind = g.access === "ro" ? "read-only" : "reserved";
      const r = await ask(
        `Change a ${kind} field?`,
        `Bit ${bit} belongs to “${g.name}” ${g.label()}, which is marked ${kind}.` +
          (g.description ? `\n\n${g.description}` : ""),
        [
          { id: "cancel", label: "Cancel" },
          { id: "always", label: "Allow for this field", cls: "outline" },
          { id: "once", label: "Change it", cls: "primary" },
        ],
      );
      if (r === "cancel") return;
      if (r === "always") this.unlocked.add(g);
    }
    m.flipBit(bit);
    play(m.bit(bit) ? "bitOn" : "bitOff");
  }

  private async editFieldDetails(g: Group) {
    const d = await editField(g);
    if (d) {
      this.model.setGroupDetails(g, d);
      play("toggle");
    }
  }

  async applyTemplate() {
    const m = this.model;
    const t = await pickTemplate(`Apply a template to “${m.name || "value"}”`, "Apply");
    if (!t) return;
    if (t.width > m.width) {
      const r = await ask(
        "Template is wider",
        `“${t.name}” is ${t.width} bits wide; this value has ${m.width}. Widen the value to ${t.width} bits?`,
        [
          { id: "cancel", label: "Cancel" },
          { id: "yes", label: `Widen to ${t.width} bits`, cls: "primary" },
        ],
      );
      if (r !== "yes") return;
      m.setWidth(t.width);
    }
    if (m.groups.length) {
      // replacing named fields is only ever done with the user's explicit go-ahead
      const r = await ask(
        "Replace fields?",
        `This removes the current field${m.groups.length > 1 ? "s" : ""} (${m.groups.map((g) => g.name).join(", ")}) ` +
          `and applies “${t.name}”. You can undo this with Ctrl+Z.`,
        [
          { id: "cancel", label: "Cancel" },
          { id: "yes", label: "Replace fields", cls: "danger-btn" },
        ],
      );
      if (r !== "yes") return;
    }
    try {
      m.applyTemplate(t);
      play("group");
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      toast(e.message, "error");
    }
  }

  async saveAsTemplate() {
    const m = this.model;
    if (!m.groups.length) {
      toast("Create some fields first", "error");
      return;
    }
    const name = await prompt("Save fields as template", "Template name", m.name || "My register", BookmarkPlus);
    if (!name?.trim()) return;
    saveTemplate({
      name: name.trim(),
      width: m.width,
      fields: m.groups.map((g) => g.toJSON() as never),
    });
  }

  exportCode() {
    void exportCode(this.model);
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
    for (const f of this.fieldUis) {
      const raw = m.groupValue(f.g);
      f.seg.set(f.g.base);
      f.edit.setFormat(f.g.width, f.g.base);
      f.edit.setValue(raw);
      if (f.decoded) {
        const d = decodeField(f.g, raw);
        if (f.decoded instanceof HTMLInputElement) {
          if (document.activeElement !== f.decoded) {
            f.decoded.value = d.error ? "?" : stripUnit(d.text, f.g.unit);
            f.decoded.classList.toggle("invalid", !!d.error);
          }
        } else f.decoded.textContent = d.error ? `⚠ ${d.error}` : d.text;
      }
      if (f.named) f.named.textContent = f.g.nameOf(raw) ?? "—";
    }
    this.statsBar.update();
    this.updateSelUi();
  }

  private readoutText(v: bigint, w: number): string {
    const parts = [formatInt(v, 16, w, { prefix: true }), v.toString(), formatInt(v, 8, w, { prefix: true })];
    if (w === 8 && v >= 0x20n && v < 0x7fn) parts.push(`'${String.fromCharCode(Number(v))}'`);
    return parts.join(" · ");
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
    this.selBar.update(this.sel);
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
    this.copyText(formatInt(v, base, width, { prefix: true }));
  }

  private copyText(text: string) {
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
    const rowOp = (op: Op, arg?: bigint) => this.op(() => (compare ? m.opCompare(lo, op, arg) : m.opRow(lo, op, arg)));
    for (const [op, text] of ROW_OPS) items.push({ label: text, action: () => rowOp(op) });
    items.push({ label: "More operations", icon: ChevronDown, submenu: moreOpsMenu(rowOp, rw, this.lookup) });
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
    if (g) {
      const raw = m.groupValue(g);
      const extra = [decodeField(g, raw).text, g.nameOf(raw)].filter(Boolean).join(" · ");
      lines.push(
        `${g.name} ${g.label()} = ${formatInt(raw, g.base, g.width, { prefix: true })}${extra ? `  (${extra})` : ""}`,
      );
      if (g.access !== "rw") lines.push(g.access === "ro" ? "🔒 read-only field" : "🔒 reserved field");
      if (g.description) lines.push(g.description);
    }
    if (!compare) lines.push("Click: flip · Drag: select · Shift+click: extend");
    return lines.join("\n");
  }
}
