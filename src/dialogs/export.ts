// "Export code…": generates source for a value's fields, or for a whole
// peripheral, from an export template (built-in or the user's own) and lets
// the user copy or save it.
import { Copy, Download, FileCode2, Pencil, Plus } from "lucide";
import {
  BUILTIN_EXPORTS,
  customExport,
  defaultPrefix,
  type ExportTemplate,
  ident,
  NEW_PERIPHERAL_TEMPLATE_SOURCE,
  NEW_TEMPLATE_SOURCE,
  renderExport,
  renderPeripheralExport,
  TemplateError,
  usesWords,
} from "../core/export/codegen";
import type { TemplateScope } from "../core/export/language";
import type { ValueModel } from "../core/model";
import type { Peripheral } from "../core/workspace";
import {
  basename,
  copyText,
  joinPath,
  pickSavePath,
  writeText,
} from "../platform/native";
import { appSettings } from "../platform/settings";
import { button, html, modal, segmented, toast, toggleSwitch } from "../ui/kit";
import { play } from "../ui/sound";
import { editExportTemplate } from "./export-editor";

/** What is being exported: one value (perhaps a register of a peripheral), or a whole peripheral. */
export type ExportTarget =
  | { kind: "register"; model: ValueModel; peripheral?: Peripheral }
  | { kind: "peripheral"; peripheral: Peripheral; models: ValueModel[] };

const templatesFor = (scope: TemplateScope): ExportTemplate[] =>
  [
    ...BUILTIN_EXPORTS,
    ...appSettings.get("export_templates").map(customExport),
  ].filter((template) => template.scope === scope);

export function exportCode(target: ExportTarget): Promise<void> {
  const scope: TemplateScope = target.kind;
  return modal<void>({
    title:
      target.kind === "register"
        ? `Export code for “${target.model.name || "value"}”`
        : `Export code for peripheral “${target.peripheral.name}”`,
    icon: FileCode2,
    wide: true,
    cancelValue: undefined,
    build: (body, close) => {
      body.parentElement?.classList.add("guide-modal");
      const first = () => templatesFor(scope)[0];
      let current =
        templatesFor(scope).find(
          (template) => template.id === appSettings.get("export_last"),
        ) ?? first();
      let includeValue = true;
      let accessors = true;
      let platform: 32 | 64 = 32; // only for this export, not remembered

      const picker = html("div", { class: "export-templates" });
      const prefix = html("input", {
        class: "field mono",
        value:
          target.kind === "register"
            ? defaultPrefix(target.model)
            : ident(target.peripheral.name, "PERIPH"),
        spellcheck: false,
      });
      const help = html("p", { class: "muted small export-help" });
      const error = html("p", { class: "expr-error export-error" });
      const preview = html("pre", { class: "code-preview mono" });
      const widthOpt = html(
        "label",
        {
          class: "export-opt",
          tip: "Values wider than this are split into several words of this size",
        },
        html("span", { class: "muted" }, "Register width"),
      );
      const widthSeg = segmented<number>(
        [
          { value: 32, label: "32-bit" },
          { value: 64, label: "64-bit" },
        ],
        {
          value: platform,
          onPick: (value) => {
            platform = value === 64 ? 64 : 32;
            render();
          },
        },
      );
      widthOpt.append(widthSeg.element);
      const valueOpt = html(
        "label",
        { class: "export-opt" },
        toggleSwitch(includeValue, (value) => {
          includeValue = value;
          render();
        }),
        html("span", { class: "muted" }, "Current value"),
      );
      const accessorsOpt = html(
        "label",
        {
          class: "export-opt",
          tip: "Read and replace helpers for each field, not just masks",
        },
        toggleSwitch(accessors, (value) => {
          accessors = value;
          render();
        }),
        html("span", { class: "muted" }, "Get / set helpers"),
      );

      /** Renders any source for this target (also used by the template editor's preview). */
      const renderSource = (source: string) =>
        target.kind === "register"
          ? renderExport(source, target.model, {
              prefix: prefix.value || "REG",
              includeValue,
              accessors,
              platform,
              peripheral: target.peripheral,
            })
          : renderPeripheralExport(source, target, {
              prefix: prefix.value || "PERIPH",
              includeValue,
            });

      const render = () => {
        // only show the options this template reads
        widthOpt.hidden = !usesWords(current.source);
        valueOpt.hidden = !/\binclude_value\b/.test(current.source);
        accessorsOpt.hidden = !/\baccessors\b/.test(current.source);
        help.textContent = current.about;
        try {
          preview.textContent = renderSource(current.source);
          error.textContent = "";
          preview.hidden = false;
        } catch (caught) {
          error.textContent =
            caught instanceof TemplateError
              ? caught.message
              : `Unexpected error: ${caught instanceof Error ? caught.message : String(caught)}`;
          preview.hidden = true;
        }
      };

      const buildPicker = () => {
        const list = templatesFor(scope);
        if (!list.some((template) => template.id === current.id))
          current = first();
        const seg = segmented(
          list.map((template) => ({
            value: template.id,
            label: template.name,
            tip: template.builtin ? undefined : "Your template",
          })),
          {
            value: current.id,
            onPick: (id) => {
              current = list.find((template) => template.id === id) ?? current;
              appSettings.set("export_last", current.id);
              buildPicker();
              render();
            },
          },
        );
        picker.replaceChildren(
          seg.element,
          button({
            icon: Plus,
            className: "ghost sm",
            tip: "New template",
            onClick: () => void edit(true),
          }),
          button({
            icon: Pencil,
            className: "ghost sm",
            tip: current.builtin
              ? "Customise a copy of this template"
              : "Edit this template",
            onClick: () => void edit(false),
          }),
        );
      };

      /** Opens the template editor for a new template, or for the current one (a copy when it is built in). */
      const edit = async (fresh: boolean) => {
        const base = fresh
          ? {
              title: "New export template",
              source:
                scope === "peripheral"
                  ? NEW_PERIPHERAL_TEMPLATE_SOURCE
                  : NEW_TEMPLATE_SOURCE,
            }
          : current.builtin
            ? {
                title: `Customise a copy of “${current.name}”`,
                source: current.source.replace(
                  /^@name .*$/m,
                  `@name ${current.name} (custom)`,
                ),
              }
            : {
                title: `Edit template “${current.name}”`,
                source: current.source,
              };
        const editing = !fresh && !current.builtin;
        const others = appSettings
          .get("export_templates")
          .filter((template) => !editing || template.name !== current.name);
        const taken = others.map((template) => template.name.toLowerCase());
        const result = await editExportTemplate(renderSource, base, {
          existing: editing,
          taken,
          scope,
        });
        if (!result) return;
        if ("deleted" in result) {
          appSettings.set("export_templates", others);
          current = first();
        } else {
          appSettings.set("export_templates", [...others, result.saved]);
          current = customExport(result.saved);
          toast(`Saved template “${result.saved.name}”`, "ok");
        }
        appSettings.set("export_last", current.id);
        buildPicker();
        render();
      };

      prefix.addEventListener("input", render);
      const copy = () =>
        copyText(preview.textContent ?? "").then(
          () => {
            play("copy");
            toast("Code copied", "ok");
          },
          () => toast("Could not access the clipboard", "error"),
        );
      const save = async () => {
        const name = `${(prefix.value || "reg").toLowerCase()}.${current.extension}`;
        const directory = appSettings.get("last_dir");
        const path = await pickSavePath(
          directory ? joinPath(directory, name) : name,
        );
        if (!path) return;
        try {
          await writeText(path, preview.textContent ?? "");
          toast(`Saved ${basename(path)}`, "ok");
        } catch (error) {
          toast(
            `Could not save: ${error instanceof Error ? error.message : error}`,
            "error",
          );
        }
      };

      body.append(
        picker,
        html(
          "div",
          { class: "export-opts" },
          html(
            "label",
            {
              class: "export-opt",
              tip: "Put in front of every generated name, e.g. CTRL_MODE_MASK",
            },
            html("span", { class: "muted" }, "Name prefix"),
            prefix,
          ),
          widthOpt,
          valueOpt,
          accessorsOpt,
        ),
        help,
        error,
        preview,
      );
      if (target.kind === "register" && !target.model.groups.length) {
        preview.before(
          html(
            "p",
            { class: "expr-note" },
            "This value has no fields yet, so only the value is exported.",
          ),
        );
      }
      buildPicker();
      render();
      return [
        button({
          icon: Download,
          label: "Save as file…",
          className: "outline",
          onClick: save,
        }),
        button({
          icon: Copy,
          label: "Copy",
          className: "primary",
          onClick: () => void copy(),
        }),
        button({
          label: "Close",
          className: "outline",
          onClick: () => close(),
        }),
      ];
    },
  });
}
