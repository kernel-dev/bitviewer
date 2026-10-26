// A small XML reader: elements, attributes, text, CDATA and the standard
// entities. Enough for CMSIS-SVD files, with no DOM, so it runs in unit tests
// too. Comments, the XML declaration, processing instructions and DOCTYPE are
// skipped; namespaces are kept as part of the name (e.g. "xs:element").

export class XmlError extends Error {
  constructor(
    readonly reason: string,
    readonly line: number,
  ) {
    super(`Line ${line}: ${reason}`);
  }
}

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** The element's own text (not its children's), entities decoded. */
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string, lineOf: () => number): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      if (!(code >= 0 && code <= 0x10ffff))
        throw new XmlError(`Bad character reference ${whole}`, lineOf());
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[entity];
    if (named === undefined)
      throw new XmlError(`Unknown entity ${whole}`, lineOf());
    return named;
  });
}

const NAME = /[A-Za-z_:][-\w.:]*/y;
const ATTRIBUTE = /\s+([A-Za-z_:][-\w.:]*)\s*=\s*("([^"]*)"|'([^']*)')/y;

/** Parses a document and returns its root element. Throws XmlError. */
export function parseXml(source: string): XmlElement {
  let cursor = 0;
  // line numbers are only worked out when an error needs one
  const lineOf = (at = cursor) => source.slice(0, at).split("\n").length;
  const fail = (reason: string, at = cursor): never => {
    throw new XmlError(reason, lineOf(at));
  };

  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  const textParts: string[][] = [];

  const addText = (text: string) => {
    if (stack.length) textParts[textParts.length - 1].push(text);
    else if (text.trim()) fail("Text outside the root element");
  };

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open < 0) {
      addText(decodeEntities(source.slice(cursor), lineOf));
      break;
    }
    if (open > cursor)
      addText(decodeEntities(source.slice(cursor, open), () => lineOf(open)));
    cursor = open;

    if (source.startsWith("<!--", cursor)) {
      const end = source.indexOf("-->", cursor + 4);
      if (end < 0) fail("A comment is never closed");
      cursor = end + 3;
    } else if (source.startsWith("<![CDATA[", cursor)) {
      const end = source.indexOf("]]>", cursor + 9);
      if (end < 0) fail("A CDATA section is never closed");
      addText(source.slice(cursor + 9, end));
      cursor = end + 3;
    } else if (source.startsWith("<?", cursor)) {
      const end = source.indexOf("?>", cursor + 2);
      if (end < 0) fail("A <? … ?> instruction is never closed");
      cursor = end + 2;
    } else if (source.startsWith("<!", cursor)) {
      // DOCTYPE (an internal subset in [ … ] may contain ">")
      let depth = 0;
      let scan = cursor + 2;
      for (; scan < source.length; scan++) {
        const character = source[scan];
        if (character === "[") depth++;
        else if (character === "]") depth--;
        else if (character === ">" && depth <= 0) break;
      }
      if (scan >= source.length) fail("A <! … > declaration is never closed");
      cursor = scan + 1;
    } else if (source[cursor + 1] === "/") {
      NAME.lastIndex = cursor + 2;
      const match = NAME.exec(source);
      if (!match) fail("Expected a tag name after </");
      const name = match![0];
      const end = source.indexOf(">", NAME.lastIndex);
      if (end < 0 || source.slice(NAME.lastIndex, end).trim())
        fail(`Bad closing tag </${name}`);
      const element = stack.pop();
      if (!element) fail(`</${name}> without an opening tag`);
      if (element!.name !== name) fail(`</${name}> closes <${element!.name}>`);
      element!.text = textParts.pop()!.join("");
      cursor = end + 1;
    } else {
      NAME.lastIndex = cursor + 1;
      const match = NAME.exec(source);
      if (!match) fail("Expected a tag name after <");
      const element: XmlElement = {
        name: match![0],
        attributes: {},
        children: [],
        text: "",
      };
      let scan = NAME.lastIndex;
      for (;;) {
        ATTRIBUTE.lastIndex = scan;
        const attribute = ATTRIBUTE.exec(source);
        if (!attribute) break;
        element.attributes[attribute[1]] = decodeEntities(
          attribute[3] ?? attribute[4],
          () => lineOf(scan),
        );
        scan = ATTRIBUTE.lastIndex;
      }
      while (/\s/.test(source[scan] ?? "")) scan++;
      const selfClosing = source.startsWith("/>", scan);
      if (!selfClosing && source[scan] !== ">")
        fail(
          `Unexpected "${source[scan] ?? "end of file"}" in <${element.name}>`,
          scan,
        );
      cursor = scan + (selfClosing ? 2 : 1);

      if (stack.length) stack[stack.length - 1].children.push(element);
      else if (root) fail("A second root element");
      else root = element;
      if (!selfClosing) {
        stack.push(element);
        textParts.push([]);
      }
    }
  }
  if (stack.length)
    fail(`<${stack[stack.length - 1].name}> is never closed`, source.length);
  if (!root) fail("No elements found", 0);
  return root!;
}

/** The first child element called `name`. */
export function child(
  element: XmlElement | undefined,
  name: string,
): XmlElement | undefined {
  return element?.children.find((candidate) => candidate.name === name);
}

/** All child elements called `name`. */
export function children(
  element: XmlElement | undefined,
  name: string,
): XmlElement[] {
  return element?.children.filter((candidate) => candidate.name === name) ?? [];
}

/** Trimmed text of the first child called `name`, or undefined. */
export function childText(
  element: XmlElement | undefined,
  name: string,
): string | undefined {
  const found = child(element, name);
  return found ? found.text.trim() : undefined;
}
