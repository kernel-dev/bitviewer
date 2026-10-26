// Paste a value as bytes, and the "Copy as bytes" menu entries.
import { ClipboardPaste } from "lucide";
import { formatInt, ParseError } from "../core/format/integers";
import {
  type ByteOrder,
  type ByteStyle,
  bytesToValue,
  formatBytes,
  parseBytes,
  valueToBytes,
} from "../core/format/interpretations";
import { button, html, type MenuItem, modal, segmented } from "../ui/kit";

/** Asks for bytes and returns the value they make, or null when cancelled. */
export function pasteBytes(
  width: number,
  initial = "",
): Promise<bigint | null> {
  return modal<bigint | null>({
    title: "Paste bytes",
    icon: ClipboardPaste,
    wide: true,
    cancelValue: null,
    build: (body, close) => {
      let order: ByteOrder = "be";
      let result: bigint | null = null;
      const area = html("textarea", {
        class: "field mono bytes-area",
        rows: 3,
        spellcheck: false,
        placeholder:
          "DE AD BE EF   ·   {0xDE, 0xAD}   ·   deadbeef   ·   b'\\xde\\xad'",
      });
      area.value = initial;
      const preview = html("div", { class: "expr-preview mono" });
      const confirmButton = button({
        label: "Set value",
        className: "primary",
        onClick: () => result !== null && close(result),
      });
      const refresh = () => {
        result = null;
        area.classList.remove("invalid");
        if (!area.value.trim()) {
          preview.replaceChildren(
            html(
              "span",
              { class: "muted" },
              `Up to ${Math.ceil(width / 8)} bytes`,
            ),
          );
        } else {
          try {
            const bytes = parseBytes(area.value);
            result = bytesToValue(bytes, width, order);
            preview.replaceChildren(
              html("span", { class: "expr-eq" }, "= "),
              formatInt(result, 16, width, { prefix: true, group: true }),
              html(
                "span",
                { class: "muted" },
                ` · ${bytes.length} byte${bytes.length === 1 ? "" : "s"}`,
              ),
            );
          } catch (error) {
            if (!(error instanceof ParseError)) throw error;
            area.classList.add("invalid");
            preview.replaceChildren(
              html("span", { class: "expr-error" }, error.message),
            );
          }
        }
        confirmButton.disabled = result === null;
      };
      const orderSeg = segmented(
        [
          {
            value: "be" as const,
            label: "Big-endian",
            tip: "First byte is the most significant",
          },
          {
            value: "le" as const,
            label: "Little-endian",
            tip: "First byte is the least significant (memory order on x86/ARM)",
          },
        ],
        {
          value: order,
          onPick: (byteOrder) => {
            order = byteOrder;
            refresh();
          },
        },
      );
      area.addEventListener("input", refresh);
      area.addEventListener("keydown", (event) => {
        if (
          event.key === "Enter" &&
          (event.ctrlKey || event.metaKey) &&
          result !== null
        )
          close(result);
      });
      body.append(
        html("label", { class: "modal-label" }, "Bytes"),
        area,
        preview,
        html("div", { class: "modal-label" }, "Byte order"),
        orderSeg.element,
      );
      refresh();
      requestAnimationFrame(() => area.focus());
      return [
        button({ label: "Cancel", onClick: () => close(null) }),
        confirmButton,
      ];
    },
  });
}

/** Submenu entries copying `value()` as bytes in several notations. */
export function copyBytesMenu(
  value: () => bigint,
  width: number,
  copy: (text: string) => void,
): MenuItem[] {
  const item = (
    label: string,
    style: ByteStyle,
    order: ByteOrder,
  ): MenuItem => ({
    label,
    action: () => copy(formatBytes(valueToBytes(value(), width, order), style)),
  });
  return [
    item("Hex bytes, big-endian", "hex", "be"),
    item("Hex bytes, little-endian", "hex", "le"),
    "sep",
    item("C array, big-endian", "c", "be"),
    item("C array, little-endian", "c", "le"),
    "sep",
    item("Python bytes, big-endian", "py", "be"),
    item("Python bytes, little-endian", "py", "le"),
  ];
}
