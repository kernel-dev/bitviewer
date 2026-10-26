// A card's menus: "More" in the header, its Snapshots submenu, and the row
// menu (the ⋯ button of a row, or a right-click on a bit).

import {
  ArrowDown,
  ArrowUp,
  Binary,
  BookmarkPlus,
  Camera,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Cpu,
  FileCode2,
  GitCompareArrows,
  Group as GroupIcon,
  History,
  LayoutTemplate,
  MousePointerClick,
  MoveHorizontal,
  Palette,
  PencilLine,
  Ruler,
  SquareFunction,
  Trash,
  Undo2,
  X,
} from "lucide";
import { BASE_NAMES, BASE_ORDER, formatInt } from "../core/format/integers";
import {
  applyOp,
  GROUP_COLORS,
  type Group,
  ModelError,
  type Op,
} from "../core/model";
import { copyBytesMenu } from "../dialogs/bytes";
import { type MenuItem, toast } from "../ui/kit";
import { play } from "../ui/sound";
import {
  editDescription,
  renameGroup,
  resizeGroupToSelection,
} from "./actions";
import type { ValueCard } from "./card";
import { moreOpsMenu } from "./more-ops";
import { copyToClipboard, copyValue, removed } from "./widgets";

const ROW_OPS: [Op, string][] = [
  ["invert", "Invert bits"],
  ["clear", "Clear (all 0)"],
  ["set", "Set (all 1)"],
  ["shl", "Shift left ≪ 1"],
  ["shr", "Shift right ≫ 1"],
];

/** The "More" menu in the card header. */
export function cardMenu(card: ValueCard): MenuItem[] {
  const model = card.model;
  return [
    {
      label: model.collapsed ? "Expand" : "Collapse",
      icon: model.collapsed ? ChevronRight : ChevronDown,
      action: () => card.toggleCollapsed(),
    },
    { label: "Snapshots", icon: Camera, submenu: snapshotMenu(card) },
    {
      label: "Peripheral",
      icon: Cpu,
      submenu: card.events.peripheralMenu(card),
    },
    {
      label: model.description ? "Edit description…" : "Add description…",
      icon: PencilLine,
      action: () => void editDescription(card),
    },
    "sep",
    {
      label: "Move up",
      icon: ArrowUp,
      action: () => card.events.move(card, -1),
    },
    {
      label: "Move down",
      icon: ArrowDown,
      action: () => card.events.move(card, +1),
    },
    {
      label: "Duplicate",
      icon: CopyPlus,
      action: () => card.events.duplicate(card),
    },
    {
      label: "Change width…",
      icon: Ruler,
      action: () => card.events.resize(card),
    },
    "sep",
    {
      label: model.showBases ? "Hide all bases" : "Show all bases",
      icon: Binary,
      action: () => card.toggleBases(),
    },
    {
      label: card.exprOpen ? "Hide expression bar" : "Expression bar",
      icon: SquareFunction,
      action: () => card.toggleExpr(),
    },
    "sep",
    {
      label: "Apply template…",
      icon: LayoutTemplate,
      action: () => card.applyTemplate(),
    },
    {
      label: "Save fields as template…",
      icon: BookmarkPlus,
      disabled: !model.groups.length,
      action: () => card.saveAsTemplate(),
    },
    {
      label: "Export code…",
      icon: FileCode2,
      action: () => card.exportCode(),
    },
    "sep",
    {
      label: "Paste bytes…",
      icon: ClipboardPaste,
      action: () => card.pasteBytes(),
    },
    {
      label: "Copy as bytes",
      icon: Copy,
      submenu: copyBytesMenu(() => model.value, model.width, copyToClipboard),
    },
    {
      label: "Compare with…",
      icon: GitCompareArrows,
      action: () => void card.compareWith(),
    },
    "sep",
    {
      label: "Remove value",
      icon: Trash,
      danger: true,
      action: () => card.events.remove(card),
    },
  ];
}

/** Take a snapshot, then one entry per snapshot (newest first) to restore,
 *  compare with or delete it. */
function snapshotMenu(card: ValueCard): MenuItem[] {
  const model = card.model;
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
      action: () => card.takeSnapshot(),
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
            if (!(await card.commit(snap.value & model.mask))) return;
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
          action: () => removed(() => model.removeSnapshot(snap)),
        },
      ],
    });
  }
  return items;
}

/** The menu of the row starting at `lo` (or of its compare row). `bit` is the
 *  bit that was right-clicked, if any: its field gets entries too. */
export function rowMenu(
  card: ValueCard,
  lo: number,
  compare: boolean,
  bit: number | null,
): MenuItem[] {
  const model = card.model;
  const rowWidth = model.rowWidthAt(lo);
  const items: MenuItem[] = [];
  if (!compare) {
    items.push({
      label: "Group selection",
      icon: GroupIcon,
      shortcut: "Ctrl+G",
      disabled: !card.selection,
      action: () => card.createGroupFromSelection(),
    });
    const group = bit !== null ? model.groupAt(bit) : undefined;
    if (group) items.push(...groupMenuItems(card, group));
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
      if (await card.commit(next)) play("op");
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
    submenu: moreOpsMenu(rowOp, rowWidth, card.lookup),
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
            copyValue(
              compare ? model.compareValue(lo) : model.rowValue(lo),
              base,
              rowWidth,
            ),
        }),
      ),
    },
    "sep",
    ...compareMenuItems(card, lo, compare),
  );
  return items;
}

/** Row-menu entries for the field under the clicked bit. */
function groupMenuItems(card: ValueCard, group: Group): MenuItem[] {
  const model = card.model;
  return [
    {
      label: `Rename “${group.name}”…`,
      icon: PencilLine,
      action: () => renameGroup(card, group),
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
            card.rebuild();
          },
        }),
      ),
    },
    {
      label: `Select “${group.name}”`,
      icon: MousePointerClick,
      action: () => card.setSelection(group.lo, group.hi),
    },
    {
      label: `Resize “${group.name}” to selection`,
      icon: MoveHorizontal,
      disabled: !card.selection,
      action: () => resizeGroupToSelection(card, group),
    },
    {
      label: `Remove “${group.name}”`,
      icon: Trash,
      danger: true,
      action: () => removed(() => model.removeGroup(group)),
    },
  ];
}

/** Row-menu entries for adding, resetting or removing the compare row. */
function compareMenuItems(
  card: ValueCard,
  lo: number,
  compare: boolean,
): MenuItem[] {
  const model = card.model;
  const remove: MenuItem = {
    label: "Remove compare row",
    icon: X,
    danger: true,
    action: () => removed(() => model.removeCompare(lo)),
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
          void card.commit(
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
