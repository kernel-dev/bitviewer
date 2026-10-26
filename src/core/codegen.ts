// Code export. Every output, built-in or the user's own, is an export template
// (see exportlang.ts) rendered against the data from exportdata.ts.

import {
  defaultPrefix,
  type ExportOptions,
  exportContext,
  ident,
  peripheralContext,
} from "./exportdata";
import {
  compileTemplate,
  renderTemplate,
  type TemplateMeta,
  type TemplateScope,
} from "./exportlang";
import cMacros from "./exports/c-macros.tpl?raw";
import cPeripheral from "./exports/c-peripheral.tpl?raw";
import cPeripheralMacros from "./exports/c-peripheral-macros.tpl?raw";
import cStruct from "./exports/c-struct.tpl?raw";
import python from "./exports/python.tpl?raw";
import rust from "./exports/rust.tpl?raw";
import rustPeripheral from "./exports/rust-peripheral.tpl?raw";
import type { ValueModel } from "./model";
import type { Peripheral } from "./workspace";

export { TemplateError } from "./exportlang";
export { defaultPrefix, type ExportOptions, ident };

/** A template the dialog can offer: a built-in one or one the user wrote. */
export interface ExportTemplate {
  id: string; // stable key: "c", "cstruct", … for built-ins, "custom:<name>" otherwise
  name: string;
  extension: string; // file extension without the dot
  about: string;
  source: string;
  builtin: boolean;
  /** What it exports: one value, or a whole peripheral. */
  scope: TemplateScope;
}

/** What the user's own templates look like when saved in settings. */
export interface SavedExportTemplate {
  name: string;
  extension: string;
  source: string;
}

function builtin(id: string, source: string): ExportTemplate {
  const meta: TemplateMeta = compileTemplate(source).meta;
  return {
    id,
    name: meta.name ?? id,
    extension: meta.extension ?? "txt",
    about: meta.about ?? "",
    source,
    builtin: true,
    scope: meta.scope ?? "register",
  };
}

export const BUILTIN_EXPORTS: ExportTemplate[] = [
  builtin("c", cMacros),
  builtin("cstruct", cStruct),
  builtin("rust", rust),
  builtin("python", python),
  builtin("cperipheral", cPeripheral),
  builtin("cperipheralmacros", cPeripheralMacros),
  builtin("rustperipheral", rustPeripheral),
];

/** Built-in ids, for callers that pick one by name. */
export type Lang =
  | "c"
  | "cstruct"
  | "rust"
  | "python"
  | "cperipheral"
  | "cperipheralmacros"
  | "rustperipheral";

/** The dialog's view of a template saved in settings. */
export function customExport(template: SavedExportTemplate): ExportTemplate {
  let meta: TemplateMeta = {};
  try {
    meta = compileTemplate(template.source).meta;
  } catch {
    /* a broken template can still be opened and fixed in the editor */
  }
  return {
    id: `custom:${template.name.toLowerCase()}`,
    name: template.name,
    extension: (template.extension || meta.extension || "txt").replace(
      /^\./,
      "",
    ),
    about: meta.about ?? "Your own template.",
    source: template.source,
    builtin: false,
    scope: meta.scope ?? "register",
  };
}

/** Renders any template source. Throws TemplateError with a line number when it is wrong. */
export function renderExport(
  source: string,
  model: ValueModel,
  options: ExportOptions,
): string {
  return renderTemplate(compileTemplate(source), exportContext(model, options));
}

/** What a peripheral export works on. */
export interface PeripheralTarget {
  peripheral: Peripheral;
  models: ValueModel[];
}

/** Renders a peripheral-scope template. Throws TemplateError. */
export function renderPeripheralExport(
  source: string,
  target: PeripheralTarget,
  options: Pick<ExportOptions, "prefix" | "includeValue">,
): string {
  return renderTemplate(
    compileTemplate(source),
    peripheralContext(target.peripheral, target.models, options),
  );
}

/** Renders one of the built-in templates by id. */
export function generate(
  language: Lang,
  model: ValueModel,
  options: ExportOptions,
): string {
  const template = BUILTIN_EXPORTS.find(
    (candidate) => candidate.id === language,
  );
  if (!template) throw new Error(`Unknown built-in export "${language}"`);
  return renderExport(template.source, model, options);
}

/** True when a template reads the register words, so the register width matters to it. */
export function usesWords(source: string): boolean {
  return /\b(words|word_count|platform)\b/.test(source);
}

/** A starting point for a new peripheral template. */
export const NEW_PERIPHERAL_TEMPLATE_SOURCE = `@name My peripheral template
@ext txt
@scope peripheral
@about Describe what this produces.
@# Lines starting with @ are instructions; everything else is output.
\${name} at \${base}
@for register in registers
\${register.id} at offset \${register.offset}
@end
`;

/** A starting point for a new template. */
export const NEW_TEMPLATE_SOURCE = `@name My template
@ext txt
@about Describe what this produces.
@# Lines starting with @ are instructions; everything else is output.
\${name}: \${width}-bit register
@for field in fields
\${field.id} = bits \${field.range}
@end
`;
