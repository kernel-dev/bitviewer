// Template picker (built-in + your own) and "save fields as template".
import { LayoutTemplate, Trash } from "lucide";
import { S } from "../app/settings";
import { BUILTIN_TEMPLATES, type Template } from "../core/templates";
import { button, h, modal, toast } from "../ui/kit";

const CHIP_COLOR = (c?: string) => c ?? "#868e96";

function preview(t: Template): HTMLElement {
  // a mini bar of the template's fields, MSB on the left
  const bar = h("div", { class: "tpl-bar" });
  const fields = [...t.fields].sort((a, b) => b.hi - a.hi);
  let next = t.width - 1;
  for (const f of fields) {
    if (f.hi < next) bar.append(h("span", { class: "tpl-gap", style: `flex:${next - f.hi}` }));
    bar.append(
      h(
        "span",
        {
          class: "tpl-field",
          style: `flex:${f.hi - f.lo + 1};--g:${CHIP_COLOR(f.color)}`,
          tip: `${f.name} [${f.hi}:${f.lo}]`,
        },
        f.hi - f.lo + 1 >= Math.max(3, t.width / 12) ? f.name : "",
      ),
    );
    next = f.lo - 1;
  }
  if (next >= 0) bar.append(h("span", { class: "tpl-gap", style: `flex:${next + 1}` }));
  return bar;
}

/** Lets the user pick a template. Resolves to it, or null when cancelled. */
export function pickTemplate(title: string, okLabel: string): Promise<Template | null> {
  return modal<Template | null>({
    title,
    icon: LayoutTemplate,
    wide: true,
    cancelValue: null,
    build: (body, close) => {
      let chosen: Template | null = null;
      const ok = button({ label: okLabel, cls: "primary", onClick: () => chosen && close(chosen) });
      ok.disabled = true;
      const list = h("div", { class: "tpl-list", role: "listbox" });
      const render = () => {
        list.replaceChildren();
        const mine = S.get("templates");
        const section = (name: string, items: Template[], removable: boolean) => {
          if (!items.length) return;
          list.append(h("h4", { class: "tpl-section" }, name));
          for (const t of items) {
            const item = h(
              "button",
              { type: "button", class: `tpl-item${chosen === t ? " on" : ""}`, role: "option" },
              h(
                "div",
                { class: "tpl-head" },
                h("b", {}, t.name),
                h(
                  "span",
                  { class: "muted mono small" },
                  `${t.width}-bit · ${t.fields.length} field${t.fields.length === 1 ? "" : "s"}`,
                ),
                h("div", { class: "spacer" }),
                removable
                  ? button({
                      icon: Trash,
                      cls: "ghost danger sm",
                      tip: "Delete this template",
                      onClick: (e) => {
                        e.stopPropagation();
                        S.set(
                          "templates",
                          S.get("templates").filter((x) => x !== t),
                        );
                        if (chosen === t) chosen = null;
                        ok.disabled = !chosen;
                        render();
                      },
                    })
                  : null,
              ),
              t.description ? h("div", { class: "muted small" }, t.description) : null,
              preview(t),
            );
            item.addEventListener("click", () => {
              chosen = t;
              ok.disabled = false;
              render();
            });
            item.addEventListener("dblclick", () => close(t));
            list.append(item);
          }
        };
        section("Your templates", mine, true);
        section("Built-in", BUILTIN_TEMPLATES, false);
      };
      render();
      body.append(list);
      return [button({ label: "Cancel", onClick: () => close(null) }), ok];
    },
  });
}

/** Saves the given fields as a user template (replacing one with the same name). */
export function saveTemplate(t: Template) {
  const others = S.get("templates").filter((x) => x.name.toLowerCase() !== t.name.toLowerCase());
  S.set("templates", [...others, t]);
  toast(`Saved template “${t.name}”`, "ok");
}
