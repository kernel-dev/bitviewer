// Expressions inside ${ } and after @if / @for / @set: tokenizer and a
// recursive-descent parser. Precedence, loosest first: | filters, or, and,
// not, comparisons, + -, unary -.

import { type Ex, TemplateError } from "./types";

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

export function parseExpression(source: string, line: number): Ex {
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
