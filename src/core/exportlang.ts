// The export template language, parsed by hand (no eval).
//
// A template is the code you want out, with two additions:
//
//   ${expr | filter}      is replaced by a value
//   @for / @if / @set ... lines that start with "@" are instructions
//
//   @name C macros        metadata: label shown in the dialog
//   @ext h                metadata: file extension
//   @about one line       metadata: description under the picker
//   @scope peripheral     metadata: what it exports, "register" (default) or "peripheral"
//   @# a comment
//   @for field in fields      repeat the lines up to @end (@else = when the list is empty)
//   @if field.signed          @elif / @else / @end
//   @set integer_suffix = "ULL"
//   @@text                a literal line starting with "@"
//
// Inside ${ }: numbers, "strings", true / false, names (field.width), + -, == != < <= > >=,
// and / or / not, parentheses, and filters: upper lower pad(n) padl(n) join(sep) reverse default(x)
// lead(text) rust_ident.
// A line starting with "@" followed by anything else (e.g. @property) is plain output.

export class TemplateError extends Error {
  constructor(
    readonly reason: string,
    readonly line = 0,
  ) {
    super(line ? `Line ${line}: ${reason}` : reason);
  }
}

/** A number a template can print in several spellings. `${x}` prints it as hex; `${x.bin}`, `.dec` and `.oct` are there too. */
export class Num {
  readonly #big: bigint; // private, so templates only see hex, bin, dec and oct

  constructor(
    big: bigint,
    readonly hex: string,
    readonly bin: string,
    readonly dec: string,
    readonly oct: string,
  ) {
    this.#big = big;
  }

  get big(): bigint {
    return this.#big;
  }

  /** `bits` is how many binary digits to pad to. */
  static of(value: bigint, bits: number): Num {
    return new Num(
      value,
      `0x${value.toString(16).toUpperCase()}`,
      `0b${value.toString(2).padStart(bits, "0")}`,
      value.toString(10),
      `0o${value.toString(8)}`,
    );
  }
}

export type TemplateScope = "register" | "peripheral";

export interface TemplateMeta {
  name?: string;
  extension?: string;
  about?: string;
  /** "register": one value; "peripheral": a block of registers. */
  scope?: TemplateScope;
}

type Ex =
  | { kind: "lit"; value: string | number | boolean }
  | { kind: "path"; path: string[] }
  | { kind: "not" | "neg"; operand: Ex }
  | { kind: "bin"; operator: string; left: Ex; right: Ex }
  | { kind: "filter"; input: Ex; name: string; argumentExpressions: Ex[] };

type Part = string | { expression: Ex };
type Node =
  | { kind: "text"; line: number; parts: Part[] }
  | {
      kind: "for";
      line: number;
      variable: string;
      list: Ex;
      body: Node[];
      orelse: Node[];
    }
  | { kind: "if"; line: number; branches: { cond: Ex | null; body: Node[] }[] }
  | { kind: "set"; line: number; name: string; expression: Ex };

export interface Compiled {
  meta: TemplateMeta;
  body: Node[];
}

// ------------------------------------------------------------------ expressions
type Tok = { kind: "num" | "str" | "name" | "op" | "end"; text: string };
const WORDS = new Set(["and", "or", "not"]);

function tokenizeExpression(source: string, line: number): Tok[] {
  const out: Tok[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (/\s/.test(character)) {
      cursor++;
      continue;
    }
    if (character === '"') {
      let text = "";
      let scan = cursor + 1;
      for (;;) {
        if (scan >= source.length)
          throw new TemplateError('Missing closing " in a string', line);
        const scannedCharacter = source[scan];
        if (scannedCharacter === "\\") {
          const escaped = source[scan + 1] ?? "";
          text += escaped === "n" ? "\n" : escaped;
          scan += 2;
        } else if (scannedCharacter === '"') break;
        else {
          text += scannedCharacter;
          scan++;
        }
      }
      out.push({ kind: "str", text });
      cursor = scan + 1;
      continue;
    }
    const rest = source.slice(cursor);
    const numberMatch = /^(0x[0-9a-f]+|\d+(\.\d+)?)/i.exec(rest);
    if (numberMatch) {
      out.push({ kind: "num", text: numberMatch[0] });
      cursor += numberMatch[0].length;
      continue;
    }
    const name = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*/.exec(rest);
    if (name) {
      out.push({ kind: "name", text: name[0] });
      cursor += name[0].length;
      continue;
    }
    const two = source.slice(cursor, cursor + 2);
    if (["==", "!=", "<=", ">="].includes(two)) {
      out.push({ kind: "op", text: two });
      cursor += 2;
      continue;
    }
    if ("<>+-()|,".includes(character)) {
      out.push({ kind: "op", text: character });
      cursor++;
      continue;
    }
    throw new TemplateError(`Unexpected "${character}"`, line);
  }
  out.push({ kind: "end", text: "" });
  return out;
}

function parseExpression(source: string, line: number): Ex {
  const tokens = tokenizeExpression(source, line);
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];
  const isWord = (word: string) =>
    peek().kind === "name" && peek().text === word;
  const isOp = (operator: string) =>
    peek().kind === "op" && peek().text === operator;
  const fail = (token: Tok): never => {
    throw new TemplateError(
      token.kind === "end"
        ? "The expression ends too early"
        : `Unexpected "${token.text}"`,
      line,
    );
  };

  const parsePrimary = (): Ex => {
    const token = next();
    if (token.kind === "num") return { kind: "lit", value: Number(token.text) };
    if (token.kind === "str") return { kind: "lit", value: token.text };
    if (token.kind === "name" && !WORDS.has(token.text)) {
      if (token.text === "true" || token.text === "false")
        return { kind: "lit", value: token.text === "true" };
      return { kind: "path", path: token.text.split(".") };
    }
    if (token.kind === "op" && token.text === "(") {
      const expression = parsePipe();
      const close = next();
      if (close.text !== ")") fail(close);
      return expression;
    }
    return fail(token);
  };
  const parseUnary = (): Ex => {
    if (isOp("-")) {
      next();
      return { kind: "neg", operand: parseUnary() };
    }
    return parsePrimary();
  };
  const parseSum = (): Ex => {
    let left = parseUnary();
    while (isOp("+") || isOp("-"))
      left = { kind: "bin", operator: next().text, left, right: parseUnary() };
    return left;
  };
  const parseComparison = (): Ex => {
    const left = parseSum();
    if (
      peek().kind === "op" &&
      ["==", "!=", "<", "<=", ">", ">="].includes(peek().text)
    ) {
      return { kind: "bin", operator: next().text, left, right: parseSum() };
    }
    return left;
  };
  const parseNot = (): Ex => {
    if (isWord("not")) {
      next();
      return { kind: "not", operand: parseNot() };
    }
    return parseComparison();
  };
  const parseAnd = (): Ex => {
    let left = parseNot();
    while (isWord("and")) {
      next();
      left = { kind: "bin", operator: "and", left, right: parseNot() };
    }
    return left;
  };
  const parseOr = (): Ex => {
    let left = parseAnd();
    while (isWord("or")) {
      next();
      left = { kind: "bin", operator: "or", left, right: parseAnd() };
    }
    return left;
  };
  function parsePipe(): Ex {
    let left = parseOr();
    while (isOp("|")) {
      next();
      const token = next();
      if (token.kind !== "name" || token.text.includes(".")) fail(token);
      const argumentExpressions: Ex[] = [];
      if (isOp("(")) {
        next();
        if (!isOp(")")) {
          argumentExpressions.push(parseOr());
          while (isOp(",")) {
            next();
            argumentExpressions.push(parseOr());
          }
        }
        const close = next();
        if (close.text !== ")") fail(close);
      }
      left = {
        kind: "filter",
        input: left,
        name: token.text,
        argumentExpressions,
      };
    }
    return left;
  }

  if (peek().kind === "end")
    throw new TemplateError("Missing expression", line);
  const parsed = parsePipe();
  if (peek().kind !== "end") fail(peek());
  return parsed;
}

// ------------------------------------------------------------------ compiling
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

// ------------------------------------------------------------------ rendering
const MAX_OUTPUT = 1_000_000;
const MAX_LOOP = 100_000;

const MAX_PAD = 1000;

function padWidth(filterArguments: unknown[], line: number): number {
  const width = Number(unwrap(filterArguments[0] ?? 0));
  if (!(width >= 0 && width <= MAX_PAD))
    throw new TemplateError(`pad needs a width from 0 to ${MAX_PAD}`, line);
  return width;
}

const padFiller = (filterArguments: unknown[]) =>
  filterArguments[1] === undefined ? " " : valueToText(filterArguments[1]);

// Rust keywords (strict and reserved, up to the 2024 edition).
const RUST_KEYWORDS = new Set(
  (
    "as async await break const continue crate dyn else enum extern false fn for " +
    "if impl in let loop match mod move mut pub ref return self Self static struct " +
    "super trait true type unsafe use where while abstract become box do final gen " +
    "macro override priv try typeof unsized virtual yield"
  ).split(" "),
);
// These can't be raw identifiers (r#self is an error), so they get a trailing _.
const RUST_NOT_RAW = new Set(["crate", "self", "super", "Self"]);

const FILTERS: Record<
  string,
  (value: unknown, argumentValues: unknown[], line: number) => unknown
> = {
  upper: (value) => valueToText(value).toUpperCase(),
  lower: (value) => valueToText(value).toLowerCase(),
  pad: (value, filterArguments, line) =>
    valueToText(value).padEnd(
      padWidth(filterArguments, line),
      padFiller(filterArguments),
    ),
  padl: (value, filterArguments, line) =>
    valueToText(value).padStart(
      padWidth(filterArguments, line),
      padFiller(filterArguments),
    ),
  join: (value, filterArguments, line) => {
    if (!Array.isArray(value))
      throw new TemplateError("join needs a list", line);
    return value
      .map(valueToText)
      .join(
        filterArguments[0] === undefined
          ? ", "
          : valueToText(filterArguments[0]),
      );
  },
  reverse: (value, _filterArguments, line) => {
    if (!Array.isArray(value))
      throw new TemplateError("reverse needs a list", line);
    return [...value].reverse();
  },
  lead: (value, filterArguments) => {
    const text = valueToText(value);
    return text ? valueToText(filterArguments[0] ?? " ") + text : "";
  },
  rust_ident: (value) => {
    const text = valueToText(value);
    if (!RUST_KEYWORDS.has(text)) return text;
    return RUST_NOT_RAW.has(text) ? `${text}_` : `r#${text}`;
  },
  default: (value, filterArguments) =>
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && !value.length)
      ? filterArguments[0]
      : value,
};
export const FILTER_NAMES = Object.keys(FILTERS);

function valueToText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (value instanceof Num) return value.hex;
  if (typeof value === "object")
    throw new TemplateError(
      "Can't print a list or object; pick a property or use | join",
    );
  return String(value);
}

/** Numbers from the export data arrive as Num; maths and comparisons see them as plain numbers. */
const unwrap = (value: unknown) => (value instanceof Num ? value.big : value);
const isNumeric = (value: unknown) =>
  typeof unwrap(value) === "number" || typeof unwrap(value) === "bigint";

function truthy(value: unknown): boolean {
  const plain = unwrap(value);
  return Array.isArray(plain) ? plain.length > 0 : !!plain;
}

function sameValue(left: unknown, right: unknown): boolean {
  const [a, b] = [unwrap(left), unwrap(right)];
  if (typeof a === "bigint" && typeof b === "bigint") return a === b;
  return isNumeric(a) && isNumeric(b) ? Number(a) === Number(b) : a === b;
}

/** Orders two numbers or two strings; anything else is an error. */
function compare(
  left: unknown,
  right: unknown,
  operator: string,
  line: number,
): boolean {
  const [a, b] = [unwrap(left), unwrap(right)] as [
    number | string,
    number | string,
  ];
  const kind = (value: unknown) => (isNumeric(value) ? "number" : typeof value);
  if (kind(a) !== kind(b))
    throw new TemplateError(
      `Can't compare ${kind(a)} with ${kind(b)} using ${operator}`,
      line,
    );
  if (operator === "<") return a < b;
  if (operator === "<=") return a <= b;
  if (operator === ">") return a > b;
  return a >= b;
}

export function renderTemplate(
  compiled: Compiled,
  context: Record<string, unknown>,
): string {
  const scopes: Map<string, unknown>[] = [new Map()];
  const out: string[] = [];
  let size = 0;
  let loops = 0;

  const lookup = (name: string, line: number): unknown => {
    for (let i = scopes.length - 1; i >= 0; i--)
      if (scopes[i].has(name)) return scopes[i].get(name);
    if (Object.hasOwn(context, name)) return context[name];
    throw new TemplateError(`Unknown name "${name}"`, line);
  };

  const readProperty = (
    record: unknown,
    key: string,
    line: number,
    path: string,
  ): unknown => {
    if (
      (Array.isArray(record) || typeof record === "string") &&
      key === "length"
    )
      return record.length;
    if (record && typeof record === "object" && !Array.isArray(record)) {
      if (Object.hasOwn(record, key))
        return (record as Record<string, unknown>)[key];
      const keys = Object.keys(record).join(", ");
      throw new TemplateError(
        `"${path}" has no "${key}" (it has: ${keys})`,
        line,
      );
    }
    throw new TemplateError(`"${path}" has no "${key}"`, line);
  };

  const evaluate = (expression: Ex, line: number): unknown => {
    switch (expression.kind) {
      case "lit":
        return expression.value;
      case "path": {
        let value = lookup(expression.path[0], line);
        for (let i = 1; i < expression.path.length; i++)
          value = readProperty(
            value,
            expression.path[i],
            line,
            expression.path.slice(0, i).join("."),
          );
        return value;
      }
      case "not":
        return !truthy(evaluate(expression.operand, line));
      case "neg":
        return -Number(unwrap(evaluate(expression.operand, line)));
      case "filter": {
        const filter = FILTERS[expression.name];
        if (!filter)
          throw new TemplateError(
            `Unknown filter "${expression.name}" (try ${FILTER_NAMES.join(", ")})`,
            line,
          );
        return filter(
          evaluate(expression.input, line),
          expression.argumentExpressions.map((argument) =>
            evaluate(argument, line),
          ),
          line,
        );
      }
      case "bin": {
        if (expression.operator === "and") {
          const left = evaluate(expression.left, line);
          return truthy(left) ? evaluate(expression.right, line) : left;
        }
        if (expression.operator === "or") {
          const left = evaluate(expression.left, line);
          return truthy(left) ? left : evaluate(expression.right, line);
        }
        const leftValue = evaluate(expression.left, line);
        const rightValue = evaluate(expression.right, line);
        switch (expression.operator) {
          case "==":
            return sameValue(leftValue, rightValue);
          case "!=":
            return !sameValue(leftValue, rightValue);
          case "+": {
            if (isNumeric(leftValue) && isNumeric(rightValue))
              return Number(unwrap(leftValue)) + Number(unwrap(rightValue));
            const text = valueToText(leftValue) + valueToText(rightValue);
            if (text.length > MAX_OUTPUT)
              throw new TemplateError("The text is too long", line);
            return text;
          }
          case "-":
            return Number(unwrap(leftValue)) - Number(unwrap(rightValue));
          default:
            return compare(leftValue, rightValue, expression.operator, line);
        }
      }
    }
  };

  /** Errors raised without a line number (e.g. printing a list) get this node's line. */
  const run = (nodes: Node[]) => {
    for (const node of nodes) {
      try {
        runNode(node);
      } catch (error) {
        if (error instanceof TemplateError && !error.line)
          throw new TemplateError(error.reason, node.line);
        if (error instanceof RangeError)
          throw new TemplateError("The output is too large", node.line);
        throw error;
      }
    }
  };
  const runNode = (node: Node) => {
    if (node.kind === "text") {
      const rendered = node.parts
        .map((part) =>
          typeof part === "string"
            ? part
            : valueToText(evaluate(part.expression, node.line)),
        )
        .join("");
      size += rendered.length + 1;
      if (size > MAX_OUTPUT)
        throw new TemplateError("The output is too large", node.line);
      out.push(rendered.trimEnd());
    } else if (node.kind === "set") {
      const value = evaluate(node.expression, node.line);
      // A new name goes to the outermost scope, so it outlives the loop it was first set in.
      const home =
        [...scopes].reverse().find((scope) => scope.has(node.name)) ??
        scopes[0];
      home.set(node.name, value);
    } else if (node.kind === "if") {
      for (const branch of node.branches) {
        if (branch.cond === null || truthy(evaluate(branch.cond, node.line))) {
          run(branch.body);
          break;
        }
      }
    } else {
      const list = evaluate(node.list, node.line);
      if (!Array.isArray(list))
        throw new TemplateError("@for needs a list to loop over", node.line);
      if (!list.length) run(node.orelse);
      list.forEach((item, index) => {
        if (++loops > MAX_LOOP)
          throw new TemplateError("Too many loop iterations", node.line);
        scopes.push(
          new Map<string, unknown>([
            [node.variable, item],
            [
              "loop",
              {
                index: index + 1,
                first: index === 0,
                last: index === list.length - 1,
                count: list.length,
              },
            ],
          ]),
        );
        run(node.body);
        scopes.pop();
      });
    }
  };
  run(compiled.body);
  return `${out.join("\n").trimEnd()}\n`;
}

/** Compiles and renders in one go. Throws TemplateError. */
export function renderSource(
  source: string,
  context: Record<string, unknown>,
): string {
  return renderTemplate(compileTemplate(source), context);
}
