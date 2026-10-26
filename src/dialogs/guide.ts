// The in-app guide: renders the markdown pages in docs/guide (the same files
// GitHub shows) with their screenshots.
import { BookOpen } from "lucide";
import { button, html, modal } from "../ui/kit";

const sources = import.meta.glob<string>("../../docs/guide/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});
const images = import.meta.glob<string>("../../docs/guide/img/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

export interface GuidePage {
  file: string; // e.g. "02-expressions.md"
  title: string;
  text: string;
}

export const GUIDE_PAGES: GuidePage[] = Object.entries(sources)
  .map(([path, text]) => ({
    file: path.slice(path.lastIndexOf("/") + 1),
    title: /^# (.+)$/m.exec(text)?.[1] ?? path,
    text,
  }))
  .sort((first, second) => first.file.localeCompare(second.file));

type Child = string | Node;

/** `code`, **bold** and [links](page.md) inside a line of text. */
function inline(source: string, open: (file: string) => void): Child[] {
  const out: Child[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (match.index > last) out.push(source.slice(last, match.index));
    if (match[1] !== undefined) out.push(html("code", {}, match[1]));
    else if (match[2] !== undefined) out.push(html("strong", {}, match[2]));
    else if (/^https?:\/\//.test(match[4])) {
      // the app has no browser to open web pages in, so show the address
      out.push(
        html("span", { class: "guide-url" }, `${match[3]} (${match[4]})`),
      );
    } else {
      const file = match[4];
      const anchor = html("a", { href: "#", class: "guide-link" }, match[3]);
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        open(file);
      });
      out.push(anchor);
    }
    last = match.index + match[0].length;
  }
  if (last < source.length) out.push(source.slice(last));
  return out;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));

/** Renders the small markdown subset the guide uses: headings, paragraphs, lists, tables, code blocks and images. */
export function renderMarkdown(
  markdown: string,
  open: (file: string) => void,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  const lines = markdown.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++)
        code.push(lines[i]);
      i++; // the closing fence
      out.push(html("pre", { class: "guide-code mono" }, code.join("\n")));
    } else if (/^#{1,3} /.test(line)) {
      const level = line.indexOf(" ");
      out.push(
        html(
          level === 1 ? "h3" : "h4",
          {},
          ...inline(line.slice(level + 1), open),
        ),
      );
      i++;
    } else if (/^!\[/.test(line)) {
      const match = /^!\[([^\]]*)\]\(([^)]+)\)/.exec(line);
      const url = match ? images[`../../docs/guide/${match[2]}`] : undefined;
      if (match && url)
        out.push(
          html(
            "figure",
            {},
            html("img", { src: url, alt: match[1] }),
            html("figcaption", {}, match[1]),
          ),
        );
      i++;
    } else if (/^\|/.test(line)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\|/.test(lines[i]); i++) {
        if (!/^\|[\s|:-]+\|$/.test(lines[i])) rows.push(cells(lines[i]));
      }
      const [headerRow, ...body] = rows;
      out.push(
        html(
          "table",
          { class: "guide-table" },
          headerRow.some(Boolean)
            ? html(
                "thead",
                {},
                html(
                  "tr",
                  {},
                  ...headerRow.map((cell) =>
                    html("th", {}, ...inline(cell, open)),
                  ),
                ),
              )
            : null,
          html(
            "tbody",
            {},
            ...body.map((row) =>
              html(
                "tr",
                {},
                ...row.map((cell) => html("td", {}, ...inline(cell, open))),
              ),
            ),
          ),
        ),
      );
    } else if (/^(- |\d+\. )/.test(line)) {
      const ordered = /^\d/.test(line);
      const items: HTMLElement[] = [];
      for (; i < lines.length && /^(- |\d+\. )/.test(lines[i]); i++) {
        items.push(
          html("li", {}, ...inline(lines[i].replace(/^(- |\d+\. )/, ""), open)),
        );
      }
      out.push(html(ordered ? "ol" : "ul", {}, ...items));
    } else {
      const paragraphLines: string[] = [];
      for (
        ;
        i < lines.length &&
        lines[i].trim() &&
        !/^(#|```|!\[|\||- |\d+\. )/.test(lines[i]);
        i++
      )
        paragraphLines.push(lines[i]);
      out.push(html("p", {}, ...inline(paragraphLines.join(" "), open)));
    }
  }
  return out;
}

/** Opens the guide, optionally on a page (file name such as "02-expressions.md"). */
export function showGuide(file?: string): Promise<void> {
  return modal<void>({
    title: "Guide",
    icon: BookOpen,
    wide: true,
    cancelValue: undefined,
    build: (body, close) => {
      body.parentElement?.classList.add("guide-modal");
      const navigation = html("nav", { class: "guide-nav" });
      const page = html("article", { class: "guide-page" });
      const show = (file: string) => {
        const selected =
          GUIDE_PAGES.find((page) => page.file === file) ?? GUIDE_PAGES[0];
        navigation.replaceChildren(
          ...GUIDE_PAGES.map((page) =>
            html(
              "button",
              {
                class: `guide-tab${page === selected ? " on" : ""}`,
                onClick: () => show(page.file),
              },
              page.title,
            ),
          ),
        );
        page.replaceChildren(...renderMarkdown(selected.text, show));
        page.scrollTop = 0;
      };
      show(file ?? GUIDE_PAGES[0].file);
      body.append(html("div", { class: "guide" }, navigation, page));
      return [
        button({
          label: "Close",
          className: "primary",
          onClick: () => close(),
        }),
      ];
    },
  });
}
