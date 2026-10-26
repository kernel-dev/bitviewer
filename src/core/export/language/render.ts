// Runs a compiled template against the export data. Output size and loop
// counts are capped, so a runaway template stops with a message instead of
// freezing the app.

import { FILTER_NAMES, FILTERS } from "./filters";
import type { Compiled, Ex, Node } from "./types";
import { TemplateError } from "./types";
import {
  compare,
  isNumeric,
  sameValue,
  truthy,
  unwrap,
  valueToText,
} from "./values";

const MAX_OUTPUT = 1_000_000;
const MAX_LOOP = 100_000;

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
