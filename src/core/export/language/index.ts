// The export template language, parsed by hand (no eval).
//
// A template is the code you want out, with two additions:
//
//   ${expr | filter}      is replaced by a value
//   @for / @if / @set ... lines that start with "@" are instructions
//
//   @name C macros        metadata: label shown in the dialog
//   @ext h                metadata: file extension
//   @about one line       metadata: description under the picker
//   @scope peripheral     metadata: what it exports, "register" (default) or "peripheral"
//   @# a comment
//   @for field in fields      repeat the lines up to @end (@else = when the list is empty)
//   @if field.signed          @elif / @else / @end
//   @set integer_suffix = "ULL"
//   @@text                a literal line starting with "@"
//
// Inside ${ }: numbers, "strings", true / false, names (field.width), + -, == != < <= > >=,
// and / or / not, parentheses, and filters: upper lower pad(n) padl(n) join(sep) reverse default(x)
// lead(text) rust_ident.
// A line starting with "@" followed by anything else (e.g. @property) is plain output.

// Files: types.ts (the syntax tree), expression.ts (${ } expressions),
// compile.ts (lines and @ directives), render.ts (running a compiled template),
// filters.ts and values.ts (how values print, compare and combine).

import { compileTemplate } from "./compile";
import { renderTemplate } from "./render";

export { compileTemplate } from "./compile";
export { FILTER_NAMES } from "./filters";
export { renderTemplate } from "./render";

export {
  type Compiled,
  Num,
  TemplateError,
  type TemplateMeta,
  type TemplateScope,
} from "./types";

/** Compiles and renders in one go. Throws TemplateError. */
export function renderSource(
  source: string,
  context: Record<string, unknown>,
): string {
  return renderTemplate(compileTemplate(source), context);
}
