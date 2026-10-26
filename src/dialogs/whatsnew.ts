// "Bit Viewer X.Y.Z Changes": this version's entry from CHANGELOG.md, bundled
// into the app. Shown once after an update, and from Help › What's new.
import { ScrollText } from "lucide";
import changelogText from "../../CHANGELOG.md?raw";
import { findRelease } from "../core/changelog";
import { button, html, modal } from "../ui/kit";
import { VERSION } from "./help";

/** `code`, **bold** and [links](url) from a changelog line, as safe DOM nodes (links keep only their text). */
export function inlineMarkdown(text: string): (Node | string)[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/)
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith("`")) return html("code", {}, part.slice(1, -1));
      if (part.startsWith("**")) return html("strong", {}, part.slice(2, -2));
      const link = /^\[([^\]]+)\]\(/.exec(part);
      return link ? link[1] : part;
    });
}

/** Shows the changes of `version`. Resolves false (without a dialog) if the changelog has no entry for it. */
export async function showWhatsNew(version = VERSION): Promise<boolean> {
  const release = findRelease(changelogText, version);
  if (!release) return false;
  await modal<void>({
    title: `Bit Viewer ${version} Changes`,
    icon: ScrollText,
    wide: true,
    cancelValue: undefined,
    build: (body, close) => {
      const notes = html("div", { class: "whatsnew" });
      if (release.date)
        notes.append(html("p", { class: "muted" }, `Released ${release.date}`));
      for (const section of release.sections) {
        if (section.title) notes.append(html("h3", {}, section.title));
        notes.append(
          html(
            "ul",
            {},
            ...section.items.map((item) =>
              html("li", {}, ...inlineMarkdown(item)),
            ),
          ),
        );
      }
      body.append(notes);
      return [
        button({
          label: "Close",
          className: "primary",
          onClick: () => close(),
        }),
      ];
    },
  });
  return true;
}
