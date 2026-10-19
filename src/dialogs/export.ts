// "Export code…": C macros / C struct / Rust / Python for a value's fields.
import { Copy, Download, FileCode2 } from "lucide";
import { basename, copyText, joinPath, pickSavePath, writeText } from "../app/platform";
import { S } from "../app/settings";
import { generate, ident, LANG_EXT, LANG_NAMES, type Lang } from "../core/codegen";
import type { ValueModel } from "../core/model";
import { button, h, modal, segmented, toast, toggleSwitch } from "../ui/kit";
import { play } from "../ui/sound";

let lastLang: Lang = "c";

export function exportCode(m: ValueModel): Promise<void> {
  return modal<void>({
    title: `Export code for “${m.name || "value"}”`,
    icon: FileCode2,
    wide: true,
    cancelValue: undefined,
    build: (body, close) => {
      let lang = lastLang;
      let includeValue = true;
      const prefix = h("input", { class: "field mono", value: ident(m.name || "REG"), spellcheck: false });
      const pre = h("pre", { class: "code-preview mono" });
      const render = () => {
        pre.textContent = generate(lang, m, { prefix: prefix.value || "REG", includeValue });
      };
      const langs = segmented(
        (Object.keys(LANG_NAMES) as Lang[]).map((l) => ({ value: l, label: LANG_NAMES[l] })),
        {
          value: lang,
          onPick: (l) => {
            lang = l;
            lastLang = l;
            render();
          },
        },
      );
      prefix.addEventListener("input", render);
      const copy = () =>
        copyText(pre.textContent ?? "").then(
          () => {
            play("copy");
            toast("Code copied", "ok");
          },
          () => toast("Could not access the clipboard", "error"),
        );
      const save = async () => {
        const name = `${(prefix.value || "reg").toLowerCase()}.${LANG_EXT[lang]}`;
        const dir = S.get("last_dir");
        const path = await pickSavePath(dir ? joinPath(dir, name) : name);
        if (!path) return;
        try {
          await writeText(path, pre.textContent ?? "");
          toast(`Saved ${basename(path)}`, "ok");
        } catch (e) {
          toast(`Could not save: ${e instanceof Error ? e.message : e}`, "error");
        }
      };
      body.append(
        h(
          "div",
          { class: "export-opts" },
          langs.el,
          h("label", { class: "export-opt" }, h("span", { class: "muted" }, "Prefix"), prefix),
          h(
            "label",
            { class: "export-opt" },
            toggleSwitch(includeValue, (v) => {
              includeValue = v;
              render();
            }),
            h("span", { class: "muted" }, "Include current value"),
          ),
        ),
        pre,
      );
      if (!m.groups.length) {
        pre.before(h("p", { class: "expr-note" }, "This value has no fields yet, so only the value is exported."));
      }
      render();
      return [
        button({ icon: Download, label: "Save as file…", cls: "outline", onClick: save }),
        button({ icon: Copy, label: "Copy", cls: "primary", onClick: () => copy().then(() => close()) }),
      ];
    },
  });
}
