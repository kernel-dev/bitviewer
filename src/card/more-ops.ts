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
import type { Op } from "../core/model";
import { type ExprResult, exprField, type Lookup } from "../ui/expr-field";
import { button, html, type MenuItem, modal, segmented } from "../ui/kit";

export type ApplyOp = (operation: Op, argument?: bigint) => void;

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
function askArgument(
  operation: Op,
  width: number,
  lookup: Lookup,
): Promise<{ operation: Op; argument: bigint } | null> {
  const isShift = ["shl", "shr", "asr", "rol", "ror"].includes(operation);
  return modal<{ operation: Op; argument: bigint } | null>({
    title: isShift
      ? "Shift / rotate by…"
      : (OP_LABELS[operation] ?? "Operation"),
    icon: Sigma,
    cancelValue: null,
    build: (body, close) => {
      let chosen = operation;
      const confirmButton = button({
        label: "Apply",
        className: "primary",
        onClick: () => submit(),
      });

      const field = exprField({
        width: () => (isShift ? 16 : width),
        lookup,
        placeholder: isShift ? "e.g. 4" : "e.g. 0xFF00 or mask(8) << 4",
        value: isShift ? "1" : "",
        onEnter: () => submit(),

        onChange: (result) => {
          confirmButton.disabled = !result;
        },
      });

      const submit = () => {
        const result: ExprResult | null = field.result();
        if (result) close({ operation: chosen, argument: result.value });
      };

      if (isShift) {
        const kinds = segmented(
          (["shl", "shr", "asr", "rol", "ror"] as Op[]).map(
            (shiftOperation) => ({
              value: shiftOperation,
              label:
                {
                  shl: "≪ SHL",
                  shr: "≫ SHR",
                  asr: "≫ ASR",
                  rol: "⟲ ROL",
                  ror: "⟳ ROR",
                }[shiftOperation as string] ?? shiftOperation,
              tip: OP_LABELS[shiftOperation],
            }),
          ),
          { value: operation, onPick: (picked) => (chosen = picked) },
        );
        body.append(
          html("div", { class: "modal-label" }, "Operation"),
          kinds.element,
        );
      }

      body.append(
        html(
          "label",
          { class: "modal-label" },
          isShift
            ? "Number of bits"
            : `Mask (${width} bits) — numbers, expressions, or names of values and fields`,
        ),
        field.element,
      );
      field.refresh();
      return [
        button({ label: "Cancel", onClick: () => close(null) }),
        confirmButton,
      ];
    },
  });
}

/** Menu entries for the extra operations. `apply` runs on the value, row or selection. */
export function moreOpsMenu(
  apply: ApplyOp,
  width: number,
  lookup: Lookup,
): MenuItem[] {
  const ask = (operation: Op) => async () => {
    const answer = await askArgument(operation, width, lookup);
    if (answer) apply(answer.operation, answer.argument);
  };

  return [
    { label: "Rotate left", icon: RotateCcw, action: () => apply("rol") },
    { label: "Rotate right", icon: RotateCw, action: () => apply("ror") },
    {
      label: "Arithmetic shift right",
      icon: ChevronsRight,
      action: () => apply("asr"),
    },
    { label: "Shift / rotate by…", icon: ChevronsLeft, action: ask("shl") },
    "sep",
    {
      label: "Swap bytes",
      icon: ArrowLeftRight,
      disabled: width % 8 !== 0 || width < 16,
      action: () => apply("bswap"),
    },
    {
      label: "Reverse bits",
      icon: FlipHorizontal2,
      action: () => apply("brev"),
    },
    "sep",
    {
      label: "Negate (two's complement)",
      icon: Minus,
      action: () => apply("neg"),
    },
    { label: "Increment", icon: Plus, action: () => apply("inc") },
    { label: "Decrement", icon: Minus, action: () => apply("dec") },
    "sep",
    { label: "AND with…", action: ask("and") },
    { label: "OR with…", action: ask("or") },
    { label: "XOR with…", action: ask("xor") },
  ];
}
