// Field layout templates: built-in presets plus the user's own (saved in
// settings). A template is a width and a list of fields in workspace JSON form.
export interface TemplateField {
  lo: number;
  hi: number;
  name: string;
  color?: string;
  base?: number;
  signed?: boolean;
  formula?: string;
  unit?: string;
  named?: { value: string; label: string }[];
  description?: string;
  access?: "rw" | "ro" | "reserved";
}

export interface Template {
  name: string;
  width: number;
  description?: string;
  fields: TemplateField[];
  builtin?: boolean;
}

const C = {
  orange: "#f59f00",
  green: "#2fb344",
  purple: "#ae3ec9",
  cyan: "#15aabf",
  blue: "#4c6ef5",
  lime: "#82c91e",
  red: "#f76707",
  gray: "#868e96",
};

export const BUILTIN_TEMPLATES: Template[] = [
  {
    name: "IEEE-754 float32",
    width: 32,
    description: "Single precision: sign, 8-bit exponent (bias 127), 23-bit fraction",
    fields: [
      { lo: 31, hi: 31, name: "SIGN", color: C.orange, base: 2, description: "1 = negative" },
      { lo: 23, hi: 30, name: "EXPONENT", color: C.green, base: 10, formula: "x - 127", description: "Biased by 127" },
      { lo: 0, hi: 22, name: "FRACTION", color: C.purple, base: 16, description: "Mantissa without the hidden 1" },
    ],
  },
  {
    name: "IEEE-754 float64",
    width: 64,
    description: "Double precision: sign, 11-bit exponent (bias 1023), 52-bit fraction",
    fields: [
      { lo: 63, hi: 63, name: "SIGN", color: C.orange, base: 2, description: "1 = negative" },
      {
        lo: 52,
        hi: 62,
        name: "EXPONENT",
        color: C.green,
        base: 10,
        formula: "x - 1023",
        description: "Biased by 1023",
      },
      { lo: 0, hi: 51, name: "FRACTION", color: C.purple, base: 16, description: "Mantissa without the hidden 1" },
    ],
  },
  {
    name: "IEEE-754 float16 (half)",
    width: 16,
    description: "Half precision: sign, 5-bit exponent (bias 15), 10-bit fraction",
    fields: [
      { lo: 15, hi: 15, name: "SIGN", color: C.orange, base: 2 },
      { lo: 10, hi: 14, name: "EXPONENT", color: C.green, base: 10, formula: "x - 15", description: "Biased by 15" },
      { lo: 0, hi: 9, name: "FRACTION", color: C.purple, base: 16 },
    ],
  },
  {
    name: "bfloat16",
    width: 16,
    description: "Brain float: the top 16 bits of a float32",
    fields: [
      { lo: 15, hi: 15, name: "SIGN", color: C.orange, base: 2 },
      { lo: 7, hi: 14, name: "EXPONENT", color: C.green, base: 10, formula: "x - 127", description: "Biased by 127" },
      { lo: 0, hi: 6, name: "FRACTION", color: C.purple, base: 16 },
    ],
  },
  {
    name: "RGB565 colour",
    width: 16,
    fields: [
      { lo: 11, hi: 15, name: "R", color: C.red, base: 10, formula: "x * 255 / 31" },
      { lo: 5, hi: 10, name: "G", color: C.green, base: 10, formula: "x * 255 / 63" },
      { lo: 0, hi: 4, name: "B", color: C.blue, base: 10, formula: "x * 255 / 31" },
    ],
  },
  {
    name: "ARGB8888 colour",
    width: 32,
    fields: [
      { lo: 24, hi: 31, name: "A", color: C.gray, base: 16 },
      { lo: 16, hi: 23, name: "R", color: C.red, base: 16 },
      { lo: 8, hi: 15, name: "G", color: C.green, base: 16 },
      { lo: 0, hi: 7, name: "B", color: C.blue, base: 16 },
    ],
  },
  {
    name: "IPv4 address",
    width: 32,
    fields: [
      { lo: 24, hi: 31, name: "OCTET1", color: C.orange, base: 10 },
      { lo: 16, hi: 23, name: "OCTET2", color: C.green, base: 10 },
      { lo: 8, hi: 15, name: "OCTET3", color: C.purple, base: 10 },
      { lo: 0, hi: 7, name: "OCTET4", color: C.cyan, base: 10 },
    ],
  },
  {
    name: "UTF-8 lead byte",
    width: 8,
    description: "How many bytes a UTF-8 sequence has, from its first byte",
    fields: [
      {
        lo: 5,
        hi: 7,
        name: "PREFIX",
        color: C.orange,
        base: 2,
        named: [
          { value: "0", label: "ASCII (1 byte)" },
          { value: "1", label: "ASCII (1 byte)" },
          { value: "2", label: "ASCII (1 byte)" },
          { value: "3", label: "ASCII (1 byte)" },
          { value: "4", label: "continuation byte" },
          { value: "5", label: "continuation byte" },
          { value: "6", label: "2-byte sequence" },
          { value: "7", label: "3- or 4-byte sequence" },
        ],
      },
      { lo: 0, hi: 4, name: "PAYLOAD", color: C.purple, base: 2 },
    ],
  },
].map((t) => ({ ...t, builtin: true }));

/** Checks the shape of a stored template; returns null if it isn't usable. */
export function validTemplate(t: any): Template | null {
  if (!t || typeof t.name !== "string" || !Number.isInteger(t.width) || !Array.isArray(t.fields)) return null;
  const fields = t.fields.filter(
    (f: any) => f && Number.isInteger(f.lo) && Number.isInteger(f.hi) && typeof f.name === "string",
  );
  return {
    name: t.name,
    width: t.width,
    description: typeof t.description === "string" ? t.description : undefined,
    fields,
  };
}
