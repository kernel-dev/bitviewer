// Editor for a code export template: the template text and a live preview of
// what it produces for the value or peripheral being exported. The template's
// own @name, @ext and @scope lines give it its label, file extension and kind.
import { Pencil } from "lucide";
import {
  BUILTIN_EXPORTS,
  type SavedExportTemplate,
  TemplateError,
} from "../core/export/codegen";
import { compileTemplate, type TemplateScope } from "../core/export/language";
import { button, html, modal } from "../ui/kit";

export type EditResult =
  | { saved: SavedExportTemplate }
  | { deleted: true }
  | null;

const CHEAT_COMMON = `\${expr}            print a value, e.g. \${field.id | upper}
@for field in fields     repeat up to @end   (@else = when empty)
@if field.signed         @elif / @else / @end
@set integer_suffix = "ULL"       remember a value
@name  @ext  @about  label, file extension, description
@scope peripheral    a template for a whole peripheral (default: register)
@# note              comment   (@@ prints a literal @)
`;

const CHEAT_REGISTER = `
top level: name prefix width value include_value accessors uint_bits
           platform fields words description
           has_address address has_offset offset block address_bits
a field:   id name lo hi width range value mask shifted_mask access
           signed formula unit description comment note named
a word:    name suffix title lo hi width storage value items`;

const CHEAT_PERIPHERAL = `
top level: name prefix description has_base base address_bits
           include_value registers layout unplaced size name_width
a register: id name description width bytes has_offset offset
           has_address address type array rust_type value fields
           (and everything a register template sees)
layout:    gap, member or overlap items in offset order; gaps have
           id bytes offset range, all have declaration`;

const CHEAT_END = `
numbers:   \${value} prints hex; \${value.hex} .bin .dec .oct
filters:   upper lower pad(n) padl(n) join(sep) reverse default(x)
           lead(text): text before the value, when there is one
           rust_ident (escapes Rust keywords: type → r#type)`;

/** Opens the editor. `preview` renders a source for what is being exported.
 *  Resolves to the template to save, `deleted`, or null when cancelled. */
export function editExportTemplate(
  preview: (source: string) => string,
  start: { title: string; source: string },
  options: {
    existing: boolean;
    /** Lowercase names of the user's other templates. */
    taken: string[];
    /** What the dialog exports; the template must be of the same kind. */
    scope: TemplateScope;
  },
): Promise<EditResult> {
  let currentSource = () => start.source;
  return modal<EditResult>({
    title: start.title,
    icon: Pencil,
    wide: true,
    cancelValue: null,
    hasChanges: () => currentSource() !== start.source,
    build: (body, close) => {
      body.parentElement?.classList.add("guide-modal");
      const source = html("textarea", {
        class: "field mono tpl-source",
        spellcheck: false,
        wrap: "off",
        autofocus: true,
      });
      source.value = start.source;
      currentSource = () => source.value;
      const status = html("p", { class: "muted small tpl-status" });
      const error = html("p", { class: "expr-error export-error" });
      const output = html("pre", { class: "code-preview mono tpl-preview" });
      const save = button({ label: "Save", className: "primary" });
      let saved: SavedExportTemplate | null = null;

      const render = () => {
        saved = null;
        status.textContent = "";
        try {
          const meta = compileTemplate(source.value).meta;
          const scope = meta.scope ?? "register";
          if (scope !== options.scope)
            throw new TemplateError(
              options.scope === "peripheral"
                ? "This exports a peripheral: keep the line @scope peripheral"
                : "This exports one value: remove the @scope peripheral line, or edit it from a peripheral's Export code",
            );
          output.textContent = preview(source.value);
          const name = meta.name?.trim() ?? "";
          if (!name)
            throw new TemplateError(
              "Give it a name with a line such as: @name My template",
            );
          if (
            BUILTIN_EXPORTS.some(
              (template) => template.name.toLowerCase() === name.toLowerCase(),
            )
          ) {
            throw new TemplateError(
              `“${name}” is a built-in template; change its @name line to save your own`,
            );
          }
          if (options.taken.includes(name.toLowerCase())) {
            throw new TemplateError(
              `You already have a template called “${name}”; pick another @name`,
            );
          }
          const extension =
            (meta.extension ?? "txt").replace(/^\./, "") || "txt";
          saved = { name, extension, source: source.value };
          status.textContent = `Saves as “${name}”, files end in .${extension}`;
          error.textContent = "";
        } catch (caught) {
          // anything else is a bug, but show it rather than leave a stale preview
          error.textContent =
            caught instanceof TemplateError
              ? caught.message
              : `Unexpected error: ${caught instanceof Error ? caught.message : String(caught)}`;
        }
        save.disabled = !saved;
        output.classList.toggle("stale", !saved);
      };
      source.addEventListener("input", render);
      save.addEventListener("click", () => {
        if (saved) close({ saved });
      });

      const cheat =
        CHEAT_COMMON +
        (options.scope === "peripheral" ? CHEAT_PERIPHERAL : CHEAT_REGISTER) +
        CHEAT_END;
      body.append(
        html(
          "details",
          { class: "tpl-cheat" },
          html("summary", { class: "muted small" }, "Syntax cheat sheet"),
          html("pre", { class: "mono small" }, cheat),
        ),
        source,
        status,
        error,
        html(
          "p",
          { class: "muted small" },
          options.scope === "peripheral"
            ? "Preview for this peripheral:"
            : "Preview for this value:",
        ),
        output,
      );
      render();
      const buttons = [
        button({ label: "Cancel", onClick: () => close(null) }),
        save,
      ];
      if (options.existing) {
        buttons.unshift(
          button({
            label: "Delete",
            className: "outline danger",
            onClick: () => close({ deleted: true }),
          }),
        );
      }
      return buttons;
    },
  });
}
