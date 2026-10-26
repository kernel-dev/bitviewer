// An SVD register as a field layout template, so it can be added as a value
// or saved to the user's templates.

import { GROUP_COLORS } from "../model";
import type { Template, TemplateField } from "../templates";
import type { SvdField, SvdRegister } from "./types";

/** An address as eight hex digits: 0x40011000. */
export const hexAddress = (address: bigint) =>
  `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;

/** Field access in Bit Viewer terms: read-only stays read-only, fields called
 *  RESERVED are reserved, everything else (including write-only) is rw. */
function fieldAccess(field: SvdField): TemplateField["access"] {
  if (/^reserved/i.test(field.name)) return "reserved";
  return field.access === "read-only" ? "ro" : "rw";
}

/** A register as a field template (the same shape the app saves). */
export function registerTemplate(
  register: SvdRegister,
  deviceName: string,
): Template {
  const fields = [...register.fields].sort(
    (first, second) => second.msb - first.msb,
  );
  return {
    name: `${deviceName} ${register.path}`,
    width: register.size,
    description: [
      `${hexAddress(register.address)}`,
      register.description,
      `reset ${hexAddress(register.resetValue).replace(/^0x0+(?=.)/, "0x")}`,
    ]
      .filter(Boolean)
      .join(" · "),
    fields: fields.map((field, index) => ({
      lo: field.lsb,
      hi: field.msb,
      name: field.name,
      color: GROUP_COLORS[index % GROUP_COLORS.length],
      description: field.description || undefined,
      access: fieldAccess(field),
      named: field.enums.length
        ? field.enums.map((item) => ({
            value: item.value.toString(),
            label: item.name,
          }))
        : undefined,
    })),
  };
}
