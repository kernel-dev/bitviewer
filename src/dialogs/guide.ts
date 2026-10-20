// The in-app guide: renders the markdown pages in docs/guide (the same files
// GitHub shows) with their screenshots.
import { BookOpen } from "lucide";
import { button, h, modal } from "../ui/kit";

const sources = import.meta.glob<string>("../../docs/guide/*.md", { eager: true, query: "?raw", import: "default" });
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
  .sort((a, b) => a.file.localeCompare(b.file));

type Child = string | Node;

/** `code`, **bold** and [links](page.md) inside a line of text. */
function inline(src: string, open: (file: string) => void): Child[] {
  const out: Child[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push(src.slice(last, m.index));
    if (m[1] !== undefined) out.push(h("code", {}, m[1]));
    else if (m[2] !== undefined) out.push(h("strong", {}, m[2]));
    else {
      const file = m[4];
      const a = h("a", { href: "#", class: "guide-link" }, m[3]);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        open(file);
      });
      out.push(a);
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

/** Renders the small markdown subset the guide uses: headings, paragraphs, lists, tables and images. */
export function renderMarkdown(md: string, open: (file: string) => void): HTMLElement[] {
  const out: HTMLElement[] = [];
  const lines = md.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if (/^#{1,3} /.test(line)) {
      const level = line.indexOf(" ");
      out.push(h(level === 1 ? "h3" : "h4", {}, ...inline(line.slice(level + 1), open)));
      i++;
    } else if (/^!\[/.test(line)) {
      const m = /^!\[([^\]]*)\]\(([^)]+)\)/.exec(line);
      const url = m ? images[`../../docs/guide/${m[2]}`] : undefined;
      if (m && url) out.push(h("figure", {}, h("img", { src: url, alt: m[1] }), h("figcaption", {}, m[1])));
      i++;
    } else if (/^\|/.test(line)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\|/.test(lines[i]); i++) {
        if (!/^\|[\s|:-]+\|$/.test(lines[i])) rows.push(cells(lines[i]));
      }
      const [head, ...body] = rows;
      out.push(
        h(
          "table",
          { class: "guide-table" },
          head.some(Boolean) ? h("thead", {}, h("tr", {}, ...head.map((c) => h("th", {}, ...inline(c, open))))) : null,
          h("tbody", {}, ...body.map((r) => h("tr", {}, ...r.map((c) => h("td", {}, ...inline(c, open)))))),
        ),
      );
    } else if (/^(- |\d+\. )/.test(line)) {
      const ordered = /^\d/.test(line);
      const items: HTMLElement[] = [];
      for (; i < lines.length && /^(- |\d+\. )/.test(lines[i]); i++) {
        items.push(h("li", {}, ...inline(lines[i].replace(/^(- |\d+\. )/, ""), open)));
      }
      out.push(h(ordered ? "ol" : "ul", {}, ...items));
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^(#|!\[|\||- |\d+\. )/.test(lines[i]); i++) para.push(lines[i]);
      out.push(h("p", {}, ...inline(para.join(" "), open)));
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
      const nav = h("nav", { class: "guide-nav" });
      const page = h("article", { class: "guide-page" });
      const show = (f: string) => {
        const p = GUIDE_PAGES.find((x) => x.file === f) ?? GUIDE_PAGES[0];
        nav.replaceChildren(
          ...GUIDE_PAGES.map((x) =>
            h("button", { class: `guide-tab${x === p ? " on" : ""}`, onClick: () => show(x.file) }, x.title),
          ),
        );
        page.replaceChildren(...renderMarkdown(p.text, show));
        page.scrollTop = 0;
      };
      show(file ?? GUIDE_PAGES[0].file);
      body.append(h("div", { class: "guide" }, nav, page));
      return [button({ label: "Close", cls: "primary", onClick: () => close() })];
    },
  });
}
