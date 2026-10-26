// The filters after | in an expression: ${name | upper}, ${list | join(", ")}.

import { TemplateError } from "./types";
import { unwrap, valueToText } from "./values";

const MAX_PAD = 1000;

function padWidth(filterArguments: unknown[], line: number): number {
  const width = Number(unwrap(filterArguments[0] ?? 0));
  if (!(width >= 0 && width <= MAX_PAD))
    throw new TemplateError(`pad needs a width from 0 to ${MAX_PAD}`, line);
  return width;
}

const padFiller = (filterArguments: unknown[]) =>
  filterArguments[1] === undefined ? " " : valueToText(filterArguments[1]);

// Rust keywords (strict and reserved, up to the 2024 edition).
const RUST_KEYWORDS = new Set(
  (
    "as async await break const continue crate dyn else enum extern false fn for " +
    "if impl in let loop match mod move mut pub ref return self Self static struct " +
    "super trait true type unsafe use where while abstract become box do final gen " +
    "macro override priv try typeof unsized virtual yield"
  ).split(" "),
);
// These can't be raw identifiers (r#self is an error), so they get a trailing _.
const RUST_NOT_RAW = new Set(["crate", "self", "super", "Self"]);

export const FILTERS: Record<
  string,
  (value: unknown, argumentValues: unknown[], line: number) => unknown
> = {
  upper: (value) => valueToText(value).toUpperCase(),
  lower: (value) => valueToText(value).toLowerCase(),
  pad: (value, filterArguments, line) =>
    valueToText(value).padEnd(
      padWidth(filterArguments, line),
      padFiller(filterArguments),
    ),
  padl: (value, filterArguments, line) =>
    valueToText(value).padStart(
      padWidth(filterArguments, line),
      padFiller(filterArguments),
    ),
  join: (value, filterArguments, line) => {
    if (!Array.isArray(value))
      throw new TemplateError("join needs a list", line);
    return value
      .map(valueToText)
      .join(
        filterArguments[0] === undefined
          ? ", "
          : valueToText(filterArguments[0]),
      );
  },
  reverse: (value, _filterArguments, line) => {
    if (!Array.isArray(value))
      throw new TemplateError("reverse needs a list", line);
    return [...value].reverse();
  },
  lead: (value, filterArguments) => {
    const text = valueToText(value);
    return text ? valueToText(filterArguments[0] ?? " ") + text : "";
  },
  rust_ident: (value) => {
    const text = valueToText(value);
    if (!RUST_KEYWORDS.has(text)) return text;
    return RUST_NOT_RAW.has(text) ? `${text}_` : `r#${text}`;
  },
  default: (value, filterArguments) =>
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && !value.length)
      ? filterArguments[0]
      : value,
};
export const FILTER_NAMES = Object.keys(FILTERS);
