// The "More operations" menu and the dialog that asks for an amount or mask.
import {
  ArrowLeftRight,
  ChevronsLeft,
  ChevronsRight,
  FlipHorizontal2,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  Sigma,
} from "lucide";
import { type ExprResult, exprField, type Lookup } from "./exprfield";
import type { Op } from "./model";
import { button, h, type MenuItem, modal, segmented } from "./ui";

export type ApplyOp = (op: Op, arg?: bigint) => void;

const OP_LABELS: Partial<Record<Op, string>> = {
  shl: "Shift left",
  shr: "Shift right",
  asr: "Arithmetic shift right",
  rol: "Rotate left",
  ror: "Rotate right",
  and: "AND with mask",
  or: "OR with mask",
  xor: "XOR with mask",
};

/** Asks for a shift/rotate amount or an and/or/xor operand. */
function askArgument(op: Op, width: number, lookup: Lookup): Promise<{ op: Op; arg: bigint } | null> {
  const isShift = ["shl", "shr", "asr", "rol", "ror"].includes(op);
  return modal<{ op: Op; arg: bigint } | null>({
    title: isShift ? "Shift / rotate by…" : (OP_LABELS[op] ?? "Operation"),
    icon: Sigma,
    cancelValue: null,
    build: (body, close) => {
      let chosen = op;
      const ok = button({ label: "Apply", cls: "primary", onClick: () => submit() });
      const field = exprField({
        width: () => (isShift ? 16 : width),
        lookup,
        placeholder: isShift ? "e.g. 4" : "e.g. 0xFF00 or mask(8) << 4",
        value: isShift ? "1" : "",
        onEnter: () => submit(),
        onChange: (r) => {
          ok.disabled = !r;
        },
      });
      const submit = () => {
        const r: ExprResult | null = field.result();
        if (r) close({ op: chosen, arg: r.value });
      };
      if (isShift) {
        const kinds = segmented(
          (["shl", "shr", "asr", "rol", "ror"] as Op[]).map((o) => ({
            value: o,
            label: { shl: "≪ SHL", shr: "≫ SHR", asr: "≫ ASR", rol: "⟲ ROL", ror: "⟳ ROR" }[o as string] ?? o,
            tip: OP_LABELS[o],
          })),
          { value: op, onPick: (o) => (chosen = o) },
        );
        body.append(h("div", { class: "modal-label" }, "Operation"), kinds.el);
      }
      body.append(
        h(
          "label",
          { class: "modal-label" },
          isShift ? "Number of bits" : `Mask (${width} bits) — numbers, expressions, or names of values and fields`,
        ),
        field.el,
      );
      field.refresh();
      return [button({ label: "Cancel", onClick: () => close(null) }), ok];
    },
  });
}

/** Menu entries for the extra operations. `apply` runs on the value, row or selection. */
export function moreOpsMenu(apply: ApplyOp, width: number, lookup: Lookup): MenuItem[] {
  const ask = (op: Op) => async () => {
    const r = await askArgument(op, width, lookup);
    if (r) apply(r.op, r.arg);
  };
  return [
    { label: "Rotate left", icon: RotateCcw, action: () => apply("rol") },
    { label: "Rotate right", icon: RotateCw, action: () => apply("ror") },
    { label: "Arithmetic shift right", icon: ChevronsRight, action: () => apply("asr") },
    { label: "Shift / rotate by…", icon: ChevronsLeft, action: ask("shl") },
    "sep",
    {
      label: "Swap bytes",
      icon: ArrowLeftRight,
      disabled: width % 8 !== 0 || width < 16,
      action: () => apply("bswap"),
    },
    { label: "Reverse bits", icon: FlipHorizontal2, action: () => apply("brev") },
    "sep",
    { label: "Negate (two's complement)", icon: Minus, action: () => apply("neg") },
    { label: "Increment", icon: Plus, action: () => apply("inc") },
    { label: "Decrement", icon: Minus, action: () => apply("dec") },
    "sep",
    { label: "AND with…", action: ask("and") },
    { label: "OR with…", action: ask("or") },
    { label: "XOR with…", action: ask("xor") },
  ];
}
