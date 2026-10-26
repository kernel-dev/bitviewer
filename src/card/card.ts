// The card that shows one value (1 to 512 bits): header, rows, compare rows,
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
  Cpu,
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
  MoveHorizontal,
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
import { appSettings } from "../app/settings";
import { ExprError } from "../core/expr";
import { decodeField, isInvertible, rawFromNumber } from "../core/fieldfmt";
import { parseFloatText } from "../core/formats";
import {
  applyOp,
  type ChangeKind,
  GROUP_COLORS,
  type Group,
  ModelError,
  type Op,
  type ValueModel,
  type View,
} from "../core/model";
import {
  BASE_NAMES,
  BASE_ORDER,
  type Base,
  formatInt,
  maxValue,
  ParseError,
  popcount,
} from "../core/numfmt";
import { addressOf, type Peripheral } from "../core/workspace";
import { copyBytesMenu, pasteBytes } from "../dialogs/bytes";
import { exportCode } from "../dialogs/export";
import { editField } from "../dialogs/field";
import { pickTemplate, saveTemplate } from "../dialogs/templates";
import {
  ask,
  button,
  html,
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
  {
    value: "invert",
    label: "NOT",
    tip: `Invert every bit (bitwise NOT)${SEL_NOTE}`,
  },
  { value: "clear", label: "CLR", tip: `Clear every bit to 0${SEL_NOTE}` },
  { value: "set", label: "SET", tip: `Set every bit to 1${SEL_NOTE}` },
  {
    value: "shl",
    icon: ChevronsLeft,
    tip: `Logical shift left by one bit${SEL_NOTE}`,
  },
  {
    value: "shr",
    icon: ChevronsRight,
    tip: `Logical shift right by one bit${SEL_NOTE}`,
  },
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
  dragStart(card: ValueCard, event: PointerEvent): void;
  /** Group the following changes into one undo step (true) / end the group (false). */
  batch(holding: boolean): void;
  /** The peripheral the value is a register of, if any. */
  peripheral(card: ValueCard): Peripheral | undefined;
  /** Entries for the card's "Peripheral" submenu. */
  peripheralMenu(card: ValueCard): MenuItem[];
  /** Asks for a new offset within the peripheral. */
  editOffset(card: ValueCard): void;
}

function baseSeg(
  base: Base,
  onPick: (base: Base) => void,
  className = "sm",
): Segmented<Base> {
  return segmented(
    BASE_ORDER.map((base) => ({ value: base, label: BASE_NAMES[base] })),
    { value: base, onPick, className },
  );
}

interface FieldUi {
  group: Group;
  edit: NumberInput;
  baseControl: Segmented<Base>;
  decoded?: HTMLElement;
  named?: HTMLButtonElement;
  row?: HTMLElement;
}

/** The page's one hidden colour picker (cancelling it fires no event, so a
 *  new input per click would never be removed). */
let sharedColorInput: HTMLInputElement | null = null;
function colorInput(): HTMLInputElement {
  sharedColorInput ??= document.body.appendChild(
    html("input", { type: "color", class: "hidden-color", tabindex: -1 }),
  );
  return sharedColorInput;
}

/** "#abc" → "#aabbcc" (a colour input only takes the long form). */
function expandColor(color: string): string {
  return /^#[0-9a-f]{3}$/i.test(color)
    ? `#${[...color.slice(1)].map((digit) => digit + digit).join("")}`
    : color;
}

/** "21.5 °C" → "21.5" when the unit is "°C". */
function stripUnit(text: string, unit: string): string {
  const trimmed = text.trim();
  return unit && trimmed.endsWith(unit)
    ? trimmed.slice(0, -unit.length).trim()
    : trimmed;
}

export class ValueCard implements StripHost {
  root: HTMLElement;
  selection: [number, number] | null = null;
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
  private readonly uniqueId = ValueCard.nextUid++;
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
  /** Re-evaluates the open expression bar; null while it's closed. */
  private exprRefresh: (() => void) | null = null;
  private listener = (kind: ChangeKind) => this.onModel(kind);

  constructor(
    public model: ValueModel,
    private events: CardEvents,
  ) {
    this.root = html("section", { class: "card" });
    this.selBar = new SelectionBar(model, (lo, width, value, input) => {
      void this.commit(model.withBits(lo, width, value), { typing: input });
    });
    this.statsBar = new StatsBar(model, (value) => this.commit(value));
    model.subscribe(this.listener);
    this.rebuild();
  }

  /** Resolves a name in an expression: x / this / value, this card's fields, then other values. */
  lookup = (name: string): bigint | undefined => {
    const model = this.model;
    const normalizedName = name.trim().toLowerCase();
    if (["x", "this", "value", "v"].includes(normalizedName))
      return model.value;
    const group = model.groups.find(
      (field) => field.name.toLowerCase() === normalizedName,
    );
    if (group) return model.groupValue(group);
    return this.events.lookup(this, name);
  };

  /** Width that operations act on: the selection, or the whole value. */
  private get opWidth(): number {
    return this.selection
      ? this.selection[1] - this.selection[0] + 1
      : this.model.width;
  }

  /** Runs an operation on the selected bits, or on the whole value when nothing is selected. */
  async applyOp(operation: Op, argument?: bigint) {
    const model = this.model;
    let next: bigint;
    try {
      if (this.selection) {
        const [lo, hi] = this.selection;
        const width = hi - lo + 1;
        next = model.withBits(
          lo,
          width,
          applyOp(operation, model.bitsValue(lo, width), width, argument),
        );
      } else next = applyOp(operation, model.value, model.width, argument);
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      play("error");
      toast(error.message, "error");
      return;
    }
    if (await this.commit(next)) play("op");
  }

  // ------------------------------------------------------------ protected fields
  /** Fields the user agreed to change for the rest of this session. */
  private unlocked = new WeakSet<Group>();
  /** Fields allowed only until the text box being typed in loses focus. */
  private allowedWhileTyping = new Set<Group>();

  /** Read-only / reserved fields whose bits differ in `next` and that haven't been allowed. */
  private protectedChanges(next: bigint): Group[] {
    const model = this.model;
    const diff = (model.value ^ next) & model.mask;
    if (!diff) return [];
    return model.groups.filter(
      (group) =>
        group.protected &&
        !this.unlocked.has(group) &&
        !this.allowedWhileTyping.has(group) &&
        (diff >> BigInt(group.lo)) & maxValue(group.width),
    );
  }

  private async askProtected(
    groups: Group[],
  ): Promise<"cancel" | "always" | "once"> {
    play("error");
    const kind = (group: Group) =>
      group.access === "ro" ? "read-only" : "reserved";
    const one = groups.length === 1;
    const answer = await ask(
      one ? `Change a ${kind(groups[0])} field?` : "Change protected fields?",
      one
        ? `This changes “${groups[0].name}” ${groups[0].label()}, which is marked ${kind(groups[0])}.` +
            (groups[0].description ? `\n\n${groups[0].description}` : "")
        : `This changes fields marked read-only or reserved: ${groups.map((group) => `“${group.name}” ${group.label()} (${kind(group)})`).join(", ")}.`,
      [
        { id: "cancel", label: "Cancel" },
        {
          id: "always",
          label: one ? "Allow for this field" : "Allow for these fields",
          className: "outline",
        },
        { id: "once", label: "Change it", className: "primary" },
      ],
    );
    return answer === "always" || answer === "once" ? answer : "cancel";
  }

  /** Sets the whole value, asking first when that changes a read-only or
   *  reserved field. `typing` is the text box the change comes from: "Change it"
   *  then holds until it loses focus, so each keystroke doesn't ask again.
   *  Resolves false when the user cancels (the display is restored). */
  async commit(
    next: bigint,
    options: { typing?: HTMLElement; onCancel?: () => void } = {},
  ): Promise<boolean> {
    const blocked = this.protectedChanges(next);
    if (blocked.length) {
      const answer = await this.askProtected(blocked);
      if (answer === "cancel") {
        options.onCancel?.();
        this.refresh();
        return false;
      }
      if (answer === "always")
        for (const group of blocked) this.unlocked.add(group);
      else if (options.typing) {
        for (const group of blocked) this.allowedWhileTyping.add(group);
        options.typing.addEventListener(
          "blur",
          () => this.allowedWhileTyping.clear(),
          { once: true },
        );
      }
    }
    this.model.setValue(next);
    return true;
  }

  detach() {
    this.model.unsubscribe(this.listener);
    for (const strip of [...this.strips.values(), ...this.cmpStrips.values()])
      strip.destroy();
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
    for (const strip of [...this.strips.values(), ...this.cmpStrips.values()])
      strip.destroy();
    this.strips.clear();
    this.cmpStrips.clear();
    this.rowBases.clear();
    this.rowEdits.clear();
    this.rowReadouts.clear();
    this.cmpEdits.clear();
    this.cmpReadouts.clear();
    this.cmpBases.clear();
    const model = this.model;
    const focusedName =
      document.activeElement?.classList.contains("name-edit") &&
      this.root.contains(document.activeElement);

    this.root.classList.toggle("collapsed", model.collapsed);
    if (model.collapsed) {
      // only the header line; the toolbar's buttons are still created because
      // selection code updates them
      this.fieldUis = [];
      const header = this.buildHeader();
      this.buildToolbar();
      this.root.replaceChildren(header);
      if (focusedName)
        (this.root.querySelector(".name-edit") as HTMLElement).focus();
      this.refresh();
      return;
    }

    const rows = html("div", {
      class: `rows ${this.line ? "line" : "grid"}`,
      tabindex: 0,
      role: "group",
      "aria-label": `Bits of ${model.name || "value"}. Arrow keys move, Space flips, 0 and 1 set, Shift+arrows select.`,
    });
    rows.addEventListener("keydown", (event) => this.onBitKey(event));
    this.rowsEl = rows;
    for (const lo of model.rowLos()) {
      if (this.line) {
        rows.append(this.buildLineRow(lo));
        if (model.hasCompare(lo)) rows.append(this.buildLineCompareRow(lo));
      } else {
        rows.append(this.buildRow(lo));
        if (model.hasCompare(lo)) rows.append(this.buildCompareRow(lo));
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
      ].filter((element): element is HTMLElement => element !== null),
    );
    if (focusedName)
      (this.root.querySelector(".name-edit") as HTMLElement).focus();
    this.refresh();
  }

  private buildHeader(): HTMLElement {
    const model = this.model;
    const name = html("input", {
      class: "name-edit",
      value: model.name,
      placeholder: "Name",
      spellcheck: false,
      tip: model.description
        ? `${model.description}\n\nClick to rename`
        : "Click to rename",
    });
    name.addEventListener("input", () => model.setName(name.value));
    name.addEventListener(
      "keydown",
      (event) => event.key === "Enter" && name.blur(),
    );

    this.fullBase = baseSeg(
      model.fullBase,
      (base) => model.setFullBase(base),
      "",
    );
    setTip(this.fullBase.element, "Number base of the whole value");
    this.fullEdit = new NumberInput(
      model.width,
      model.fullBase,
      (value) => void this.commit(value, { typing: this.fullEdit.element }),
      {
        allowNegative: true,
        group: true,
        className: "value-edit",
      },
    );

    const copyBtn = button({
      icon: Copy,
      label: "Copy",
      className: "outline",
      tip: "Copy the whole value to the clipboard",
    });
    copyBtn.addEventListener("click", () =>
      openMenu(
        BASE_ORDER.map((base) => ({
          label: `Copy as ${BASE_NAMES[base]}`,
          action: () => this.copy(model.value, base, model.width),
        })),
        copyBtn,
      ),
    );
    const moreButton = button({
      icon: Ellipsis,
      className: "ghost more-btn",
      tip: "More",
    });
    moreButton.addEventListener("click", () =>
      openMenu(this.cardMenu(), moreButton),
    );

    const grip = html(
      "button",
      {
        type: "button",
        class: "grip",
        tip: "Drag to reorder",
        "aria-label": "Drag to reorder",
      },
      icon(GripVertical, 16),
    );
    grip.addEventListener("pointerdown", (event) => {
      if (event.button === 0) this.events.dragStart(this, event);
    });
    const collapse = button({
      icon: model.collapsed ? ChevronRight : ChevronDown,
      className: "ghost sm collapse-btn",
      tip: model.collapsed ? "Expand" : "Collapse to the header line",
      onClick: () => this.toggleCollapsed(),
    });
    return html(
      "header",
      { class: "card-head" },
      grip,
      collapse,
      name,
      html(
        "button",
        {
          type: "button",
          class: `badge${model.width > 32 ? " wide" : ""}`,
          tip: "Change width…",
          onClick: () => this.events.resize(this),
        },
        `${model.width}-bit`,
      ),
      this.addressBadge(),
      html("div", { class: "spacer-sm" }),
      this.fullBase.element,
      this.fullEdit.element,
      copyBtn,
      moreButton,
    );
  }

  /** Where the register sits: its address (base + offset), or just the
   *  offset when the peripheral has no base address. Null outside peripherals. */
  private addressBadge(): HTMLElement | null {
    const model = this.model;
    const peripheral = this.events.peripheral(this);
    if (!peripheral) return null;
    const hex = (value: bigint) => `0x${value.toString(16).toUpperCase()}`;
    const address = addressOf(model.offset, peripheral);
    const text =
      address !== null
        ? hex(address)
        : model.offset !== null
          ? `+${hex(model.offset)}`
          : "no offset";
    const tip =
      model.offset === null
        ? `In ${peripheral.name}, without an offset. Click to set one.`
        : address !== null
          ? `${peripheral.name} ${hex(peripheral.base!)} + ${hex(model.offset)}. Click to change the offset.`
          : `Offset ${hex(model.offset)} in ${peripheral.name} (no base address). Click to change it.`;
    return html(
      "button",
      {
        type: "button",
        class: `badge addr mono${model.offset === null ? " warn" : ""}`,
        tip,
        onClick: () => this.events.editOffset(this),
      },
      text,
    );
  }

  private async editDescription() {
    const text = await prompt(
      "Description",
      `What “${this.model.name || "this value"}” is for (shown when you point at its name)`,
      this.model.description,
      PencilLine,
    );
    if (text !== null) this.model.setDescription(text.trim());
  }

  /** The "More" menu in the card header. */
  private cardMenu(): MenuItem[] {
    const model = this.model;
    return [
      {
        label: model.collapsed ? "Expand" : "Collapse",
        icon: model.collapsed ? ChevronRight : ChevronDown,
        action: () => this.toggleCollapsed(),
      },
      { label: "Snapshots", icon: Camera, submenu: this.snapshotMenu() },
      {
        label: "Peripheral",
        icon: Cpu,
        submenu: this.events.peripheralMenu(this),
      },
      {
        label: model.description ? "Edit description…" : "Add description…",
        icon: PencilLine,
        action: () => void this.editDescription(),
      },
      "sep",
      {
        label: "Move up",
        icon: ArrowUp,
        action: () => this.events.move(this, -1),
      },
      {
        label: "Move down",
        icon: ArrowDown,
        action: () => this.events.move(this, +1),
      },
      {
        label: "Duplicate",
        icon: CopyPlus,
        action: () => this.events.duplicate(this),
      },
      {
        label: "Change width…",
        icon: Ruler,
        action: () => this.events.resize(this),
      },
      "sep",
      {
        label: model.showBases ? "Hide all bases" : "Show all bases",
        icon: Binary,
        action: () => this.toggleBases(),
      },
      {
        label: this.exprOpen ? "Hide expression bar" : "Expression bar",
        icon: SquareFunction,
        action: () => this.toggleExpr(),
      },
      "sep",
      {
        label: "Apply template…",
        icon: LayoutTemplate,
        action: () => this.applyTemplate(),
      },
      {
        label: "Save fields as template…",
        icon: BookmarkPlus,
        disabled: !model.groups.length,
        action: () => this.saveAsTemplate(),
      },
      {
        label: "Export code…",
        icon: FileCode2,
        action: () => this.exportCode(),
      },
      "sep",
      {
        label: "Paste bytes…",
        icon: ClipboardPaste,
        action: () => this.pasteBytes(),
      },
      {
        label: "Copy as bytes",
        icon: Copy,
        submenu: copyBytesMenu(
          () => model.value,
          model.width,
          (text) => this.copyText(text),
        ),
      },
      {
        label: "Compare with",
        icon: GitCompareArrows,
        disabled: this.events.others(this).length === 0,
        submenu: this.events.others(this).map((otherCard) => ({
          label: `${otherCard.model.name || "(unnamed)"}  ·  ${otherCard.model.width}-bit`,
          action: () => {
            model.compareWith(otherCard.model.value);
            play("toggle");
          },
        })),
      },
      "sep",
      {
        label: "Remove value",
        icon: Trash,
        danger: true,
        action: () => this.events.remove(this),
      },
    ];
  }

  private buildToolbar(): HTMLElement {
    const model = this.model;
    const view = segmented(VIEW_UI, {
      value: model.view,
      onPick: (view) => model.setView(view),
    });
    const centerElement = this.line
      ? button({
          icon: GitCompareArrows,
          label: "Compare",
          className: `outline${model.hasCompare(0) ? " on" : ""}`,
          tip: "Show a linked compare row under the bits",
          onClick: () =>
            model.hasCompare(0) ? model.removeCompare(0) : model.addCompare(0),
        })
      : button({
          icon: ArrowUpDown,
          label: model.msbFirst ? "MSB row first" : "LSB row first",
          className: "outline",
          tip: "Toggle row order. LSB first in byte view is the little-endian memory order.",
          onClick: () => model.setMsbFirst(!model.msbFirst),
        });
    const operationsControl = segmented(OPS_UI, {
      checkable: false,
      onPick: (operation) => this.applyOp(operation),
      className: "ops",
    });
    const moreOps = button({
      icon: ChevronDown,
      className: "ghost sm more-ops",
      tip: `More operations: rotate, swap bytes, reverse, negate, AND/OR/XOR…${SEL_NOTE}`,
    });
    moreOps.dataset.keepSel = "";
    moreOps.addEventListener("click", () =>
      openMenu(
        moreOpsMenu(
          (operation, argument) => this.applyOp(operation, argument),
          this.opWidth,
          this.lookup,
        ),
        moreOps,
      ),
    );
    const expr = button({
      icon: SquareFunction,
      className: `outline expr-toggle${this.exprOpen ? " on" : ""}`,
      tip: "Expression bar: type a calculation to set the value (or the selected bits)",
      onClick: () => this.toggleExpr(),
    });
    expr.dataset.keepSel = "";
    operationsControl.element.dataset.keepSel = "";
    const bases = button({
      icon: Binary,
      label: "Bases",
      className: `outline${model.showBases ? " on" : ""}`,
      tip: "Show the value in every base (BIN · OCT · DEC · HEX)",
      onClick: () => this.toggleBases(),
    });

    this.groupBtn = button({
      icon: GroupIcon,
      label: "Group selection",
      className: "accent-ghost",
      tip: "Make the selected bits a named register field (Ctrl+G)",
      onClick: () => this.createGroupFromSelection(),
    });
    this.groupBtn.dataset.keepSel = "";
    this.clearSelBtn = button({
      icon: X,
      className: "ghost",
      tip: "Clear selection (Esc)",
      onClick: () => this.clearSelection(),
    });
    return html(
      "div",
      { class: "card-tools" },
      view.element,
      centerElement,
      bases,
      html("div", { class: "ops-wrap" }, operationsControl.element, moreOps),
      expr,
      html("div", { class: "spacer" }),
      this.selBar.element,
      this.groupBtn,
      this.clearSelBtn,
    );
  }

  private buildExprBar(): HTMLElement {
    const bar = expressionBar({
      width: () => this.opWidth,
      lookup: this.lookup,
      target: () =>
        this.selection
          ? `bits [${this.selection[1]}:${this.selection[0]}]`
          : "value",
      text: this.exprText,
      onText: (text) => {
        this.exprText = text;
      },
      apply: async (value) => {
        const next = this.selection
          ? this.model.withBits(this.selection[0], this.opWidth, value)
          : value;
        if (await this.commit(next)) play("op");
      },
      close: () => this.toggleExpr(false),
    });
    this.exprRefresh = bar.refresh;
    return bar.element;
  }

  toggleExpr(open = !this.exprOpen) {
    this.exprOpen = open;
    play("toggle");
    this.rebuild();
  }

  private rowMenuButton(lo: number, compare: boolean): HTMLButtonElement {
    const buttonElement = button({
      icon: Ellipsis,
      className: "ghost sm",
      tip: compare ? "Compare row operations" : "Row operations",
    });
    buttonElement.addEventListener("click", () =>
      openMenu(this.rowMenu(lo, compare, null), buttonElement),
    );
    return buttonElement;
  }

  private readout(): HTMLElement {
    return html("span", { class: "readout mono" });
  }

  // ------------------------------------------------------------ line view
  private buildLineRow(lo: number): HTMLElement {
    const strip = new BitStrip(this, lo, false, true);
    this.strips.set(lo, strip);
    return html(
      "div",
      { class: `row line-row${this.model.hasCompare(lo) ? " linked" : ""}` },
      strip.element,
    );
  }

  private buildLineCompareRow(lo: number): HTMLElement {
    const model = this.model;
    const base = html("span", {
      class: "muted mono small",
      tip: "Uses the value's base",
    });
    this.cmpBases.set(lo, base);
    const edit = new NumberInput(
      model.rowWidthAt(lo),
      model.fullBase,
      (value) => model.setCompare(lo, value),
      {
        group: true,
        className: "cmp-edit",
      },
    );
    this.cmpEdits.set(lo, edit);
    const readoutElement = this.readout();
    this.cmpReadouts.set(lo, readoutElement);
    const strip = new BitStrip(this, lo, true, true);
    this.cmpStrips.set(lo, strip);
    return html(
      "div",
      { class: "row cmp-row cmp-line" },
      html(
        "div",
        { class: "cmp-bar" },
        html(
          "span",
          {
            class: "cmp-label",
            tip: "Independent value compared against the bits above",
          },
          icon(GitCompareArrows, 14),
          "Compare",
        ),
        base,
        edit.element,
        readoutElement,
        html("div", { class: "spacer" }),
        button({
          icon: X,
          label: "Remove",
          className: "ghost danger sm",
          tip: "Remove this compare row",
          onClick: () => this.removed(() => model.removeCompare(lo)),
        }),
        this.rowMenuButton(lo, true),
      ),
      strip.element,
    );
  }

  // ------------------------------------------------------------ byte / nibble view
  private buildRow(lo: number): HTMLElement {
    const model = this.model;
    const hi = lo + model.rowWidthAt(lo) - 1;
    const label = html(
      "button",
      {
        type: "button",
        class: "row-label",
        tip: "Click to select this row · Shift+click to extend over consecutive rows",
      },
      html("b", {}, model.rowTitle(lo)),
      html("span", { class: "muted mono" }, `[${hi}:${lo}]`),
    );
    label.addEventListener("click", (event) =>
      this.rowLabelClicked(lo, event.shiftKey),
    );

    const strip = new BitStrip(this, lo);
    this.strips.set(lo, strip);
    const baseControl = baseSeg(
      model.rowBase(lo),
      (base) => model.setRowBase(lo, base),
      "xs",
    );
    this.rowBases.set(lo, baseControl);
    const edit = new NumberInput(
      model.rowWidthAt(lo),
      model.rowBase(lo),
      (value) =>
        void this.commit(model.withBits(lo, model.rowWidthAt(lo), value), {
          typing: edit.element,
        }),
      {
        className: `row-edit w${model.rowWidth}`,
      },
    );
    this.rowEdits.set(lo, edit);
    const readoutElement = this.readout();
    readoutElement.classList.toggle("off", !appSettings.get("show_readouts"));
    this.rowReadouts.set(lo, readoutElement);
    const compareButton = button({
      icon: GitCompareArrows,
      label: "Compare",
      className: `ghost sm${model.hasCompare(lo) ? " on" : ""}`,
      tip: "Show a linked compare row under this one",
      onClick: () =>
        model.hasCompare(lo) ? model.removeCompare(lo) : model.addCompare(lo),
    });
    return html(
      "div",
      { class: `row${model.hasCompare(lo) ? " linked" : ""}` },
      label,
      strip.element,
      baseControl.element,
      edit.element,
      readoutElement,
      compareButton,
      this.rowMenuButton(lo, false),
    );
  }

  private buildCompareRow(lo: number): HTMLElement {
    const model = this.model;
    const strip = new BitStrip(this, lo, true);
    this.cmpStrips.set(lo, strip);
    const base = html("span", {
      class: "cmp-base muted mono small",
      tip: "Uses the parent row's base",
    });
    this.cmpBases.set(lo, base);
    const edit = new NumberInput(
      model.rowWidthAt(lo),
      model.rowBase(lo),
      (value) => model.setCompare(lo, value),
      {
        className: `row-edit w${model.rowWidth}`,
      },
    );
    this.cmpEdits.set(lo, edit);
    const readoutElement = this.readout();
    this.cmpReadouts.set(lo, readoutElement);
    return html(
      "div",
      { class: "row cmp-row" },
      html(
        "span",
        {
          class: "cmp-label",
          tip: `Independent value compared against ${model.rowTitle(lo)}; it shares that row's fields`,
        },
        icon(GitCompareArrows, 14),
        "Compare",
      ),
      strip.element,
      base,
      edit.element,
      readoutElement,
      button({
        icon: X,
        label: "Remove",
        className: "ghost danger sm",
        tip: "Remove this compare row",
        onClick: () => this.removed(() => model.removeCompare(lo)),
      }),
      this.rowMenuButton(lo, true),
    );
  }

  // ------------------------------------------------------------ fields & stats
  private buildFields(): HTMLElement {
    const model = this.model;
    this.fieldUis = [];
    const head = html(
      "div",
      { class: "fields-head" },
      icon(Layers, 15, "muted"),
      html("span", { class: "fields-title" }, "Register fields"),
      model.groups.length
        ? html("span", { class: "count" }, String(model.groups.length))
        : null,
      model.groups.length
        ? null
        : html(
            "span",
            { class: "muted small hint" },
            "Drag across bits (or click a row label, then Shift+click another) and press “Group selection”. Fields may span rows; they cannot overlap.",
          ),
      html("div", { class: "spacer" }),
      button({
        icon: LayoutTemplate,
        label: "Templates",
        className: "ghost sm",
        tip: "Apply a field layout (IEEE-754, RGB565, IPv4, your own…)",
        onClick: () => this.applyTemplate(),
      }),
    );
    const list = html("div", { class: "fields-list" });
    for (const group of model.groups) list.append(this.buildFieldRow(group));
    return html(
      "div",
      { class: `fields${model.groups.length ? "" : " no-fields"}` },
      head,
      model.groups.length ? list : null,
    );
  }

  private buildFieldRow(group: Group): HTMLElement {
    const model = this.model;
    const swatch = html("button", {
      type: "button",
      class: "swatch",
      style: `--g:${group.color}`,
      tip: "Change colour",
    });
    swatch.addEventListener("click", () => this.pickColor(group, swatch));
    const name = html("input", {
      class: "field",
      value: group.name,
      placeholder: "Field name",
      spellcheck: false,
    });
    name.addEventListener("input", () =>
      model.updateGroup(group, { name: name.value }),
    );
    if (group.description) setTip(name, group.description);
    const baseControl = baseSeg(
      group.base,
      (base) => model.updateGroup(group, { base: base }),
      "xs",
    );
    const edit = new NumberInput(
      group.width,
      group.base,
      (value) =>
        void this.commit(model.withBits(group.lo, group.width, value), {
          typing: edit.element,
        }),
      {
        className: "group-edit",
      },
    );
    edit.element.style.setProperty(
      "--chars",
      String(Math.min(Math.max(group.width, 4), 34)),
    );
    const fieldUi: FieldUi = { group, edit, baseControl };

    const decoded =
      group.signed || group.formula || group.unit
        ? this.buildDecoded(group, fieldUi)
        : null;
    const named = group.named.length ? this.buildNamedPicker(group) : null;
    if (named) fieldUi.named = named;
    this.fieldUis.push(fieldUi);
    const row = html(
      "div",
      { class: `field-row${group.protected ? " protected" : ""}` },
      swatch,
      name,
      html(
        "span",
        { class: "muted mono small range" },
        group.protected ? icon(Lock, 12, "lock") : null,
        `${group.label()} · ${group.width} bit${group.width > 1 ? "s" : ""}`,
      ),
      baseControl.element,
      edit.element,
      decoded,
      named,
      html("div", { class: "spacer" }),
      button({
        icon: SlidersVertical,
        className: "ghost sm",
        tip: "Field details: description, signed, formula & unit, named values, access",
        onClick: () => this.editFieldDetails(group),
      }),
      button({
        icon: MousePointerClick,
        className: "ghost sm",
        tip: "Select this field's bits",
        onClick: () => this.setSelection(group.lo, group.hi),
      }),
      button({
        icon: Trash,
        className: "ghost danger sm",
        tip: "Remove this field",
        onClick: () => this.removed(() => model.removeGroup(group)),
      }),
    );
    fieldUi.row = row;
    row.classList.toggle("match", this.fieldMatches.has(group.name));
    return row;
  }

  /** The field's meaning: a signed number or formula result with its unit, editable when the formula can be inverted. */
  private buildDecoded(group: Group, fieldUi: FieldUi): HTMLElement {
    if (!isInvertible(group)) {
      const span = html("span", {
        class: "decoded-ro mono",
        tip: "Not linear, so it can't be typed in; edit the raw value",
      });
      fieldUi.decoded = span;
      return span;
    }
    const model = this.model;
    const input = html("input", {
      class: "field mono decoded-edit",
      spellcheck: false,
      tip: "Type a value to set the raw bits",
    });
    const commit = () => {
      if (input.dataset.dirty !== "1") return;
      input.dataset.dirty = "";
      try {
        const typedValue = parseFloatText(stripUnit(input.value, group.unit));
        const raw = rawFromNumber(group, typedValue);
        input.classList.remove("invalid");
        void this.commit(model.withBits(group.lo, group.width, raw), {
          onCancel: () => input.blur(),
        });
      } catch (error) {
        if (!(error instanceof ExprError || error instanceof ParseError))
          throw error;
        input.classList.add("invalid");
        play("error");
        toast(error.message, "error");
      }
    };
    input.addEventListener("input", () => {
      input.dataset.dirty = "1";
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commit();
      if (event.key === "Escape") {
        event.stopPropagation();
        input.dataset.dirty = "";
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      commit();
      this.refresh();
    });
    fieldUi.decoded = input;
    return html(
      "span",
      { class: "decoded" },
      input,
      group.unit ? html("span", { class: "muted small" }, group.unit) : null,
    );
  }

  /** A button that opens a menu of the field's named values. */
  private buildNamedPicker(group: Group): HTMLButtonElement {
    const model = this.model;
    const picker = html("button", {
      type: "button",
      class: "btn outline sm named-pick",
      tip: "Pick a named value",
    });
    picker.addEventListener("click", () =>
      openMenu(
        group.named.map((namedValue) => ({
          label: `${namedValue.label}  ·  ${formatInt(namedValue.value, group.base, group.width, { prefix: true })}`,
          checked: model.groupValue(group) === namedValue.value,
          action: async () => {
            const next = model.withBits(
              group.lo,
              group.width,
              namedValue.value,
            );
            if (await this.commit(next)) play("toggle");
          },
        })),
        picker,
      ),
    );
    return picker;
  }

  /** The value in every base, each line editable and copyable. */
  private buildBases(): HTMLElement | null {
    const model = this.model;
    this.baseEdits.clear();
    if (!model.showBases) return null;
    const list = html("div", { class: "bases-list" });
    for (const base of [16, 10, 8, 2] as Base[]) {
      const edit = new NumberInput(
        model.width,
        base,
        (value) => void this.commit(value, { typing: edit.element }),
        {
          allowNegative: base === 10,
          group: true,
          className: "bases-edit",
        },
      );
      this.baseEdits.set(base, edit);
      list.append(
        html(
          "div",
          { class: "bases-row" },
          html(
            "span",
            { class: "bases-name" },
            BASE_NAMES[base],
            html("small", {}, `base ${base}`),
          ),
          edit.element,
          button({
            icon: Copy,
            className: "ghost sm",
            tip: `Copy as ${BASE_NAMES[base]}`,
            onClick: () => this.copy(model.value, base, model.width),
          }),
        ),
      );
    }
    return html(
      "div",
      { class: "bases" },
      html(
        "div",
        { class: "fields-head" },
        icon(Binary, 15, "muted"),
        html("span", { class: "fields-title" }, "All bases"),
        html(
          "span",
          { class: "muted small hint" },
          "Type into any line to change the value",
        ),
        html("div", { class: "spacer" }),
        button({
          icon: X,
          className: "ghost sm",
          tip: "Hide all bases",
          onClick: () => this.toggleBases(),
        }),
      ),
      list,
    );
  }

  toggleBases() {
    play("toggle");
    this.model.setShowBases(!this.model.showBases);
  }

  private removed(action: () => void) {
    action();
    play("remove");
  }

  private buildStats(): HTMLElement {
    this.statsBar.build();
    return this.statsBar.element;
  }

  async pasteBytes() {
    const value = await pasteBytes(this.model.width);
    if (value !== null && (await this.commit(value))) play("op");
  }

  // ------------------------------------------------------------ keyboard & paint
  bitId(bit: number): string {
    return `v${this.uniqueId}-bit${bit}`;
  }

  setCursor(bit: number, focus = true) {
    const model = this.model;
    this.cursor = Math.max(0, Math.min(model.width - 1, bit));
    this.repaintStrips();
    this.rowsEl?.setAttribute("aria-activedescendant", this.bitId(this.cursor));
    if (focus) this.rowsEl?.focus({ preventScroll: true });
    document
      .getElementById(this.bitId(this.cursor))
      ?.scrollIntoView({ block: "nearest" });
  }

  /** How many bits "up" moves the cursor (rows or wrapped lines above have higher bits when MSB comes first). */
  private verticalStep(): number {
    const model = this.model;
    const strip = this.strips.values().next().value;
    const per = strip?.lineBits ?? model.rowWidth;
    const higherAbove = this.line
      ? appSettings.get("msb_left")
      : model.msbFirst;
    return higherAbove ? per : -per;
  }

  private onBitKey(event: KeyboardEvent) {
    const model = this.model;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const current = this.cursor ?? model.width - 1;
    const left = appSettings.get("msb_left") ? 1 : -1; // moving left goes to a higher bit when the MSB is on the left
    const moves: Record<string, number> = {
      ArrowLeft: left,
      ArrowRight: -left,
      ArrowUp: this.verticalStep(),
      ArrowDown: -this.verticalStep(),
    };
    let next: number | null = null;
    if (event.key in moves) next = current + moves[event.key];
    else if (event.key === "Home") next = model.width - 1;
    else if (event.key === "End") next = 0;
    if (next !== null) {
      event.preventDefault();
      // up/down past the first/last line stays put; left/right stop at the ends
      const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
      if (vertical && (next < 0 || next >= model.width)) next = current;
      next = Math.max(0, Math.min(model.width - 1, next));
      if (event.shiftKey) {
        if (this.anchor === null)
          this.anchor = this.selection
            ? this.selection[0] === current
              ? this.selection[1]
              : this.selection[0]
            : current;
        this.setSelection(this.anchor, next);
        play("select");
      } else if (this.cursor === null) next = current;
      this.setCursor(next);
      return;
    }
    if (this.cursor === null) return;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      void this.flipBit(this.cursor);
    } else if (event.key === "0" || event.key === "1") {
      event.preventDefault();
      if (model.bit(this.cursor) !== Number(event.key))
        void this.flipBit(this.cursor);
    }
  }

  paintStart() {
    this.events.batch(true);
    this.clearSelection();
  }

  paintBit(bit: number, isOn: boolean) {
    const group = this.model.groupAt(bit);
    if (group?.protected && !this.unlocked.has(group)) return; // painting never touches protected fields
    if (this.model.bit(bit) === (isOn ? 1 : 0)) return;
    this.model.setBitsValue(bit, 1, isOn ? 1n : 0n);
    play(isOn ? "bitOn" : "bitOff");
  }

  paintEnd() {
    this.events.batch(false);
  }

  /** Highlights fields that match a search (empty set clears). */
  markMatches(names: Set<string>) {
    this.fieldMatches = names;
    for (const fieldUi of this.fieldUis)
      fieldUi.row?.classList.toggle("match", names.has(fieldUi.group.name));
  }

  // ------------------------------------------------------------ collapse & snapshots
  toggleCollapsed(collapsed = !this.model.collapsed) {
    play("toggle");
    this.model.setCollapsed(collapsed);
  }

  private snapshotMenu(): MenuItem[] {
    const model = this.model;
    const formatTime = (timestamp: number) =>
      timestamp
        ? new Date(timestamp).toLocaleString(undefined, {
            dateStyle: "short",
            timeStyle: "short",
          })
        : "";
    const items: MenuItem[] = [
      {
        label: "Take snapshot…",
        icon: Camera,
        action: () => this.takeSnapshot(),
      },
    ];
    if (model.snapshots.length) items.push("sep");
    for (const snap of [...model.snapshots].reverse()) {
      items.push({
        label: `${snap.name}  ·  ${formatInt(snap.value & model.mask, 16, model.width, { prefix: true, group: true })}`,
        icon: History,
        submenu: [
          { label: formatTime(snap.at) || "Snapshot", disabled: true },
          "sep",
          {
            label: "Restore this value",
            icon: Undo2,
            action: async () => {
              if (!(await this.commit(snap.value & model.mask))) return;
              play("op");
              toast(`Restored “${snap.name}”`, "ok");
            },
          },
          {
            label: "Compare with current",
            icon: GitCompareArrows,
            action: () => {
              model.compareWith(snap.value);
              play("toggle");
            },
          },
          "sep",
          {
            label: "Delete snapshot",
            icon: Trash,
            danger: true,
            action: () => this.removed(() => model.removeSnapshot(snap)),
          },
        ],
      });
    }
    return items;
  }

  async takeSnapshot() {
    const model = this.model;
    const name = await prompt(
      "Take snapshot",
      `Name for the current value of “${model.name || "value"}”`,
      `Snapshot ${model.snapshots.length + 1}`,
      Camera,
    );
    if (name === null) return;
    const snap = model.takeSnapshot(name);
    play("group");
    toast(`Saved snapshot “${snap.name}”`, "ok");
  }

  // ------------------------------------------------------------ field features
  /** Flips a bit; for read-only / reserved fields, asks first. */
  async flipBit(bit: number) {
    const model = this.model;
    if (!(await this.commit(model.value ^ (1n << BigInt(bit))))) return;
    play(model.bit(bit) ? "bitOn" : "bitOff");
  }

  private async editFieldDetails(group: Group) {
    const details = await editField(group);
    if (details) {
      this.model.setGroupDetails(group, details);
      play("toggle");
    }
  }

  async applyTemplate() {
    const model = this.model;
    const template = await pickTemplate(
      `Apply a template to “${model.name || "value"}”`,
      "Apply",
    );
    if (!template) return;
    const widen = template.width > model.width;
    if (widen) {
      const answer = await ask(
        "Template is wider",
        `“${template.name}” is ${template.width} bits wide; this value has ${model.width}. Widen the value to ${template.width} bits?`,
        [
          { id: "cancel", label: "Cancel" },
          {
            id: "yes",
            label: `Widen to ${template.width} bits`,
            className: "primary",
          },
        ],
      );
      if (answer !== "yes") return;
    }
    if (model.groups.length) {
      // replacing named fields is only ever done with the user's explicit go-ahead
      const answer = await ask(
        "Replace fields?",
        `This removes the current field${model.groups.length > 1 ? "s" : ""} (${model.groups.map((group) => group.name).join(", ")}) ` +
          `and applies “${template.name}”. You can undo this with Ctrl+Z.`,
        [
          { id: "cancel", label: "Cancel" },
          { id: "yes", label: "Replace fields", className: "danger-btn" },
        ],
      );
      if (answer !== "yes") return;
    }
    try {
      // one undo step for the widening and the new fields
      this.events.batch(true);
      try {
        if (widen) model.setWidth(template.width);
        model.applyTemplate(template);
      } finally {
        this.events.batch(false);
      }
      play("group");
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      toast(error.message, "error");
    }
  }

  async saveAsTemplate() {
    const model = this.model;
    if (!model.groups.length) {
      toast("Create some fields first", "error");
      return;
    }
    const name = await prompt(
      "Save fields as template",
      "Template name",
      model.name || "My register",
      BookmarkPlus,
    );
    if (!name?.trim()) return;
    const existing = appSettings
      .get("templates")
      .find(
        (template) => template.name.toLowerCase() === name.trim().toLowerCase(),
      );
    if (existing) {
      const answer = await ask(
        "Replace template?",
        `You already have a template called “${existing.name}”. Replace it with these fields?`,
        [
          { id: "cancel", label: "Cancel" },
          { id: "yes", label: "Replace", className: "danger-btn" },
        ],
      );
      if (answer !== "yes") return;
    }
    saveTemplate({
      name: name.trim(),
      width: model.width,
      fields: model.groups.map((group) => group.toJSON() as never),
    });
  }

  exportCode() {
    void exportCode({
      kind: "register",
      model: this.model,
      peripheral: this.events.peripheral(this),
    });
  }

  // ================================================================ refresh
  refresh() {
    const model = this.model;
    this.fullBase.set(model.fullBase);
    this.fullEdit.setFormat(model.width, model.fullBase);
    this.fullEdit.setValue(model.value);

    for (const [lo, strip] of this.strips) {
      const base = this.line ? model.fullBase : model.rowBase(lo);
      const value = model.rowValue(lo);
      const edit = this.rowEdits.get(lo);
      if (edit) {
        this.rowBases.get(lo)!.set(base);
        edit.setFormat(model.rowWidthAt(lo), base);
        edit.setValue(value);
        this.rowReadouts.get(lo)!.textContent = this.readoutText(
          value,
          model.rowWidthAt(lo),
        );
      }
      strip.update();
      const compareStrip = this.cmpStrips.get(lo);
      if (compareStrip) {
        this.cmpBases.get(lo)!.textContent = BASE_NAMES[base];
        this.cmpEdits.get(lo)!.setFormat(model.rowWidthAt(lo), base);
        this.cmpEdits.get(lo)!.setValue(model.compareValue(lo));
        const diff = model.compareDiff(lo);
        const readoutElement = this.cmpReadouts.get(lo)!;
        if (diff) {
          const differingBits = popcount(diff);
          readoutElement.replaceChildren(
            html(
              "span",
              { class: "diff-text" },
              `Δ ${differingBits} bit${differingBits > 1 ? "s" : ""}`,
            ),
            ` · XOR ${formatInt(diff, 16, model.rowWidthAt(lo), { prefix: true, group: this.line })}`,
          );
        } else
          readoutElement.replaceChildren(
            html("span", { class: "same-text" }, "identical"),
          );
        compareStrip.update();
      }
    }
    for (const edit of this.baseEdits.values()) {
      edit.setFormat(model.width, edit.base);
      edit.setValue(model.value);
    }
    if (this.exprOpen) this.exprRefresh?.();
    for (const fieldUi of this.fieldUis) {
      const raw = model.groupValue(fieldUi.group);
      fieldUi.baseControl.set(fieldUi.group.base);
      fieldUi.edit.setFormat(fieldUi.group.width, fieldUi.group.base);
      fieldUi.edit.setValue(raw);
      if (fieldUi.decoded) {
        const decoded = decodeField(fieldUi.group, raw);
        if (fieldUi.decoded instanceof HTMLInputElement) {
          if (document.activeElement !== fieldUi.decoded) {
            fieldUi.decoded.value = decoded.error
              ? "?"
              : stripUnit(decoded.text, fieldUi.group.unit);
            fieldUi.decoded.classList.toggle("invalid", !!decoded.error);
          }
        } else
          fieldUi.decoded.textContent = decoded.error
            ? `⚠ ${decoded.error}`
            : decoded.text;
      }
      if (fieldUi.named)
        fieldUi.named.textContent = fieldUi.group.nameOf(raw) ?? "—";
    }
    this.statsBar.update();
    this.updateSelUi();
  }

  private readoutText(value: bigint, width: number): string {
    const parts = [
      formatInt(value, 16, width, { prefix: true }),
      value.toString(),
      formatInt(value, 8, width, { prefix: true }),
    ];
    if (width === 8 && value >= 0x20n && value < 0x7fn)
      parts.push(`'${String.fromCharCode(Number(value))}'`);
    return parts.join(" · ");
  }

  // ================================================================ selection
  setSelection(fromBit: number, toBit: number) {
    this.selection = [Math.min(fromBit, toBit), Math.max(fromBit, toBit)];
    this.repaintStrips();
    this.updateSelUi();
  }

  clearSelection() {
    this.anchor = null;
    this.rowAnchor = null;
    if (this.selection) {
      this.selection = null;
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
    const before = this.selection?.join();
    this.setSelection(this.anchor, bit);
    if (this.selection?.join() !== before) play("select");
  }

  extendSelection(bit: number) {
    if (this.anchor === null)
      this.anchor = this.selection ? this.selection[0] : bit;
    this.setSelection(this.anchor, bit);
  }

  private rowLabelClicked(lo: number, shift: boolean) {
    const top = (rowStart: number) =>
      rowStart + this.model.rowWidthAt(rowStart) - 1;
    if (shift && this.rowAnchor !== null) {
      const anchorRow = this.rowAnchor;
      this.setSelection(Math.min(anchorRow, lo), top(Math.max(anchorRow, lo)));
    } else {
      this.rowAnchor = lo;
      this.anchor = null;
      this.setSelection(lo, top(lo));
    }
  }

  private repaintStrips() {
    for (const strip of this.strips.values()) strip.update();
  }

  private updateSelUi() {
    this.selBar.update(this.selection);
    this.groupBtn.disabled = !this.selection;
    this.clearSelBtn.hidden = !this.selection;
  }

  // ================================================================ actions
  async createGroupFromSelection() {
    if (!this.selection) return;
    const [lo, hi] = this.selection;
    const clash = this.model.overlapping(lo, hi);
    if (clash.length) {
      play("error");
      await ask(
        "Fields cannot overlap",
        `The selection [${hi}:${lo}] overlaps ${clash.map((group) => `“${group.name}” ${group.label()}`).join(", ")}. ` +
          "Remove that field first or select a different range.",
        [{ id: "ok", label: "OK", className: "primary" }],
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
    } catch (error) {
      if (error instanceof ModelError) toast(error.message, "error");
      return;
    }
    this.clearSelection();
  }

  /** Widens or narrows a field so it covers exactly the selected bits. */
  private resizeGroupToSelection(group: Group) {
    if (!this.selection) return;
    try {
      this.model.resizeGroup(group, this.selection[0], this.selection[1]);
      play("group");
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      play("error");
      toast(error.message, "error");
      return;
    }
    this.clearSelection();
  }

  private pickColor(
    group: Group,
    anchor: HTMLElement | { x: number; y: number },
  ) {
    const custom = () => {
      const input = colorInput();
      input.value = expandColor(group.color);
      input.oninput = () =>
        this.model.updateGroup(group, { color: input.value });
      input.onchange = () => this.rebuild();
      input.click();
    };
    openMenu(
      [
        ...GROUP_COLORS.map(
          (color): MenuItem => ({
            label: color.toUpperCase(),
            swatch: color,
            action: () => {
              this.model.updateGroup(group, { color: color });
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

  private async renameGroup(group: Group) {
    const name = await prompt(
      "Rename field",
      "Field name",
      group.name,
      PencilLine,
    );
    if (name?.trim()) {
      this.model.updateGroup(group, { name: name.trim() });
      this.rebuild();
    }
  }

  private copy(value: bigint, base: Base, width: number) {
    this.copyText(formatInt(value, base, width, { prefix: true }));
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

  openRowMenu(
    lo: number,
    compare: boolean,
    bit: number | null,
    position: { x: number; y: number },
  ) {
    openMenu(this.rowMenu(lo, compare, bit), position);
  }

  private rowMenu(
    lo: number,
    compare: boolean,
    bit: number | null,
  ): MenuItem[] {
    const model = this.model;
    const rowWidth = model.rowWidthAt(lo);
    const items: MenuItem[] = [];
    if (!compare) {
      items.push({
        label: "Group selection",
        icon: GroupIcon,
        shortcut: "Ctrl+G",
        disabled: !this.selection,
        action: () => this.createGroupFromSelection(),
      });
      const group = bit !== null ? model.groupAt(bit) : undefined;
      if (group) items.push(...this.groupMenuItems(group));
      items.push("sep");
    }
    const rowOp = async (operation: Op, argument?: bigint) => {
      try {
        if (compare) {
          model.opCompare(lo, operation, argument); // compare rows aren't protected
          play("op");
          return;
        }
        const next = model.withBits(
          lo,
          rowWidth,
          applyOp(operation, model.rowValue(lo), rowWidth, argument),
        );
        if (await this.commit(next)) play("op");
      } catch (error) {
        if (!(error instanceof ModelError)) throw error;
        play("error");
        toast(error.message, "error");
      }
    };
    for (const [operation, text] of ROW_OPS)
      items.push({ label: text, action: () => rowOp(operation) });
    items.push({
      label: "More operations",
      icon: ChevronDown,
      submenu: moreOpsMenu(rowOp, rowWidth, this.lookup),
    });
    items.push(
      "sep",
      {
        label: "Copy",
        icon: Copy,
        submenu: BASE_ORDER.map(
          (base): MenuItem => ({
            label: `as ${BASE_NAMES[base]}`,
            action: () =>
              this.copy(
                compare ? model.compareValue(lo) : model.rowValue(lo),
                base,
                rowWidth,
              ),
          }),
        ),
      },
      "sep",
      ...this.compareMenuItems(lo, compare),
    );
    return items;
  }

  /** Row-menu entries for the field under the clicked bit. */
  private groupMenuItems(group: Group): MenuItem[] {
    const model = this.model;
    return [
      {
        label: `Rename “${group.name}”…`,
        icon: PencilLine,
        action: () => this.renameGroup(group),
      },
      {
        label: `Colour of “${group.name}”`,
        icon: Palette,
        submenu: GROUP_COLORS.map(
          (color): MenuItem => ({
            label: color.toUpperCase(),
            swatch: color,
            action: () => {
              model.updateGroup(group, { color: color });
              this.rebuild();
            },
          }),
        ),
      },
      {
        label: `Select “${group.name}”`,
        icon: MousePointerClick,
        action: () => this.setSelection(group.lo, group.hi),
      },
      {
        label: `Resize “${group.name}” to selection`,
        icon: MoveHorizontal,
        disabled: !this.selection,
        action: () => this.resizeGroupToSelection(group),
      },
      {
        label: `Remove “${group.name}”`,
        icon: Trash,
        danger: true,
        action: () => this.removed(() => model.removeGroup(group)),
      },
    ];
  }

  /** Row-menu entries for adding, resetting or removing the compare row. */
  private compareMenuItems(lo: number, compare: boolean): MenuItem[] {
    const model = this.model;
    const remove: MenuItem = {
      label: "Remove compare row",
      icon: X,
      danger: true,
      action: () => this.removed(() => model.removeCompare(lo)),
    };
    if (compare) {
      return [
        {
          label: "Reset to parent value",
          icon: Undo2,
          action: () => model.setCompare(lo, model.rowValue(lo)),
        },
        {
          label: "Copy compare into parent",
          icon: ArrowUp,
          action: () =>
            void this.commit(
              model.withBits(lo, model.rowWidthAt(lo), model.compareValue(lo)),
            ),
        },
        remove,
      ];
    }
    if (model.hasCompare(lo)) return [remove];
    return [
      {
        label: "Compare",
        icon: GitCompareArrows,
        action: () => model.addCompare(lo),
      },
    ];
  }

  bitTip(bit: number, lo: number, compare: boolean): string {
    const model = this.model;
    const lines: string[] = [];
    if (compare) {
      const compareBit = model.compareBit(lo, bit);
      const parentBit = model.bit(bit);
      lines.push(
        `Bit ${bit} (compare) = ${compareBit}` +
          (compareBit === parentBit ? "" : `   ≠ parent ${parentBit}`),
      );
    } else lines.push(`Bit ${bit} = ${model.bit(bit)}`);
    const group = model.groupAt(bit);
    if (group) {
      const raw = model.groupValue(group);
      const extra = [decodeField(group, raw).text, group.nameOf(raw)]
        .filter(Boolean)
        .join(" · ");
      lines.push(
        `${group.name} ${group.label()} = ${formatInt(raw, group.base, group.width, { prefix: true })}${extra ? `  (${extra})` : ""}`,
      );
      if (group.access !== "rw")
        lines.push(
          group.access === "ro" ? "🔒 read-only field" : "🔒 reserved field",
        );
      if (group.description) lines.push(group.description);
    }
    if (!compare)
      lines.push("Click: flip · Drag: select · Shift+click: extend");
    return lines.join("\n");
  }
}
