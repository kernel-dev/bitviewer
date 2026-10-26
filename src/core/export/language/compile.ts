// Turns template source into a tree: text lines with ${ } parts, and the
// @for / @if / @set blocks. Metadata lines (@name, @ext, @about, @scope) are
// collected separately. Errors carry the line number.

import { parseExpression } from "./expression";
import {
  type Compiled,
  type Ex,
  type Node,
  type Part,
  TemplateError,
  type TemplateMeta,
} from "./types";

function parseText(lineText: string, line: number): Node {
  const parts: Part[] = [];
  let pendingText = "";
  let cursor = 0;
  while (cursor < lineText.length) {
    if (lineText.startsWith("$${", cursor)) {
      pendingText += "${";
      cursor += 3;
    } else if (lineText.startsWith("${", cursor)) {
      let scan = cursor + 2;
      let inStr = false;

      for (; scan < lineText.length; scan++) {
        const character = lineText[scan];
        if (inStr) {
          if (character === "\\") scan++;
          else if (character === '"') inStr = false;
        } else if (character === '"') inStr = true;
        else if (character === "}") break;
      }

      if (scan >= lineText.length)
        throw new TemplateError("Missing } to close ${", line);

      if (pendingText) parts.push(pendingText);
      pendingText = "";
      parts.push({
        expression: parseExpression(lineText.slice(cursor + 2, scan), line),
      });
      cursor = scan + 1;
    } else pendingText += lineText[cursor++];
  }

  if (pendingText || !parts.length) parts.push(pendingText);
  return { kind: "text", line, parts };
}

// A directive word must be followed by a space or the end of the line, so "@name-of-thing" stays output.
const DIRECTIVE =
  /^(#|(?:name|ext|about|scope|for|if|elif|else|end|set)(?=\s|$))(.*)$/;

type Frame =
  | { kind: "root"; currentNodes: Node[] }
  | {
      kind: "for";
      node: Extract<Node, { kind: "for" }>;
      currentNodes: Node[];
      inElse: boolean;
    }
  | {
      kind: "if";
      node: Extract<Node, { kind: "if" }>;
      currentNodes: Node[];
      sawElse: boolean;
    };

export function compileTemplate(source: string): Compiled {
  const meta: TemplateMeta = {};
  const root: Frame = { kind: "root", currentNodes: [] };
  const stack: Frame[] = [root];
  const top = () => stack[stack.length - 1];
  const lines = source.replace(/\r/g, "").split("\n");

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("@@")) {
      top().currentNodes.push(parseText(raw.replace("@@", "@"), lineNumber));
      return;
    }

    const match = trimmed.startsWith("@")
      ? DIRECTIVE.exec(trimmed.slice(1))
      : null;

    if (!match) {
      top().currentNodes.push(parseText(raw, lineNumber));
      return;
    }

    const word = match[1];
    const argument = match[2].trim();
    if (word === "#") return;

    if (word === "scope") {
      if (argument !== "register" && argument !== "peripheral")
        throw new TemplateError(
          "Write it as: @scope register, or @scope peripheral",
          lineNumber,
        );

      meta.scope = argument;
      return;
    }

    if (word === "name" || word === "ext" || word === "about") {
      meta[word === "ext" ? "extension" : word] = argument;
      return;
    }

    if (word === "for") {
      const forMatch = /^([A-Za-z_]\w*)\s+in\s+(.+)$/.exec(argument);
      if (!forMatch)
        throw new TemplateError("Write it as: @for item in list", lineNumber);

      const node = {
        kind: "for" as const,
        line: lineNumber,
        variable: forMatch[1],
        list: parseExpression(forMatch[2], lineNumber),
        body: [],
        orelse: [],
      };
      top().currentNodes.push(node);
      stack.push({ kind: "for", node, currentNodes: node.body, inElse: false });
      return;
    }

    if (word === "if") {
      const node = {
        kind: "if" as const,
        line: lineNumber,
        branches: [
          {
            cond: parseExpression(argument, lineNumber) as Ex | null,
            body: [] as Node[],
          },
        ],
      };
      top().currentNodes.push(node);
      stack.push({
        kind: "if",
        node,
        currentNodes: node.branches[0].body,
        sawElse: false,
      });
      return;
    }

    if (word === "set") {
      const setMatch = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(argument);
      if (!setMatch)
        throw new TemplateError("Write it as: @set name = value", lineNumber);

      top().currentNodes.push({
        kind: "set",
        line: lineNumber,
        name: setMatch[1],
        expression: parseExpression(setMatch[2], lineNumber),
      });
      return;
    }

    // elif / else / end
    const frame = top();

    if (word === "end") {
      if (argument)
        throw new TemplateError("@end takes nothing after it", lineNumber);

      if (frame.kind === "root")
        throw new TemplateError(
          "@end without a matching @for or @if",
          lineNumber,
        );

      stack.pop();
    } else if (word === "else") {
      if (argument)
        throw new TemplateError("@else takes nothing after it", lineNumber);

      if (frame.kind === "for") {
        if (frame.inElse)
          throw new TemplateError("@for already has an @else", lineNumber);

        frame.inElse = true;
        frame.currentNodes = frame.node.orelse;
      } else if (frame.kind === "if") {
        if (frame.sawElse)
          throw new TemplateError("@if already has an @else", lineNumber);

        frame.sawElse = true;
        const branch = { cond: null, body: [] as Node[] };
        frame.node.branches.push(branch);
        frame.currentNodes = branch.body;
      } else
        throw new TemplateError(
          "@else without a matching @if or @for",
          lineNumber,
        );
    } else {
      // elif
      if (frame.kind !== "if")
        throw new TemplateError("@elif without a matching @if", lineNumber);

      if (frame.sawElse)
        throw new TemplateError("@elif can't come after @else", lineNumber);

      const branch = {
        cond: parseExpression(argument, lineNumber) as Ex | null,
        body: [] as Node[],
      };
      frame.node.branches.push(branch);
      frame.currentNodes = branch.body;
    }
  });

  if (stack.length > 1) {
    const openFrame = stack[stack.length - 1] as Exclude<
      Frame,
      { kind: "root" }
    >;
    throw new TemplateError(
      `@${openFrame.kind} is never closed with @end`,
      openFrame.node.line,
    );
  }

  return { meta, body: root.currentNodes };
}
