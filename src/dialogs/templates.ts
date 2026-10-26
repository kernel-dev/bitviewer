// Template picker (built-in + your own) and "save fields as template".
import { LayoutTemplate, Trash } from "lucide";
import { BUILTIN_TEMPLATES, type Template } from "../core/templates";
import { appSettings } from "../platform/settings";
import { button, html, modal, toast } from "../ui/kit";

const CHIP_COLOR = (color?: string) => color ?? "#868e96";

function preview(template: Template): HTMLElement {
  // a mini bar of the template's fields, MSB on the left
  const bar = html("div", { class: "tpl-bar" });
  const fields = [...template.fields].sort(
    (first, second) => second.hi - first.hi,
  );
  let next = template.width - 1;
  for (const field of fields) {
    if (field.hi < next)
      bar.append(
        html("span", { class: "tpl-gap", style: `flex:${next - field.hi}` }),
      );
    bar.append(
      html(
        "span",
        {
          class: "tpl-field",
          style: `flex:${field.hi - field.lo + 1};--g:${CHIP_COLOR(field.color)}`,
          tip: `${field.name} [${field.hi}:${field.lo}]`,
        },
        field.hi - field.lo + 1 >= Math.max(3, template.width / 12)
          ? field.name
          : "",
      ),
    );
    next = field.lo - 1;
  }
  if (next >= 0)
    bar.append(html("span", { class: "tpl-gap", style: `flex:${next + 1}` }));
  return bar;
}

/** Lets the user pick a template. Resolves to it, or null when cancelled. */
export function pickTemplate(
  title: string,
  okLabel: string,
): Promise<Template | null> {
  return modal<Template | null>({
    title,
    icon: LayoutTemplate,
    wide: true,
    cancelValue: null,
    build: (body, close) => {
      let chosen: Template | null = null;
      const confirmButton = button({
        label: okLabel,
        className: "primary",
        onClick: () => chosen && close(chosen),
      });
      confirmButton.disabled = true;
      const list = html("div", { class: "tpl-list", role: "listbox" });
      const render = () => {
        list.replaceChildren();
        const userTemplates = appSettings.get("templates");
        const section = (
          name: string,
          items: Template[],
          removable: boolean,
        ) => {
          if (!items.length) return;
          list.append(html("h4", { class: "tpl-section" }, name));
          for (const template of items) {
            const item = html(
              "button",
              {
                type: "button",
                class: `tpl-item${chosen === template ? " on" : ""}`,
                role: "option",
              },
              html(
                "div",
                { class: "tpl-head" },
                html("b", {}, template.name),
                html(
                  "span",
                  { class: "muted mono small" },
                  `${template.width}-bit · ${template.fields.length} field${template.fields.length === 1 ? "" : "s"}`,
                ),
                html("div", { class: "spacer" }),
                removable
                  ? button({
                      icon: Trash,
                      className: "ghost danger sm",
                      tip: "Delete this template",
                      onClick: (event) => {
                        event.stopPropagation();
                        appSettings.set(
                          "templates",
                          appSettings
                            .get("templates")
                            .filter(
                              (savedTemplate) => savedTemplate !== template,
                            ),
                        );
                        if (chosen === template) chosen = null;
                        confirmButton.disabled = !chosen;
                        render();
                      },
                    })
                  : null,
              ),
              template.description
                ? html("div", { class: "muted small" }, template.description)
                : null,
              preview(template),
            );
            item.addEventListener("click", () => {
              chosen = template;
              confirmButton.disabled = false;
              render();
            });
            item.addEventListener("dblclick", () => close(template));
            list.append(item);
          }
        };
        section("Your templates", userTemplates, true);
        section("Built-in", BUILTIN_TEMPLATES, false);
      };
      render();
      body.append(list);
      return [
        button({ label: "Cancel", onClick: () => close(null) }),
        confirmButton,
      ];
    },
  });
}

/** Saves the given fields as a user template (replacing one with the same name). */
export function saveTemplate(template: Template) {
  const others = appSettings
    .get("templates")
    .filter(
      (savedTemplate) =>
        savedTemplate.name.toLowerCase() !== template.name.toLowerCase(),
    );
  appSettings.set("templates", [...others, template]);
  toast(`Saved template “${template.name}”`, "ok");
}
