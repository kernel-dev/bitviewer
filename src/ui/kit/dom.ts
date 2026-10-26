// Building elements: html("div", { class, tip, onClick… }, ...children),
// Lucide icons and buttons.

import { createElement, type IconNode } from "lucide";
import { setTip } from "./tooltip";

type Child = Node | string | number | null | undefined | false;

type Props = Record<string, any> & {
  class?: string;
  style?: string;
  tip?: string | (() => string);
};

export function html<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  properties: Props = {},
  ...children: Child[]
) {
  const element = document.createElement(tagName);

  for (const [attributeName, value] of Object.entries(properties)) {
    if (value === undefined || value === null || value === false) continue;

    if (attributeName === "class") element.className = value;
    else if (attributeName === "style") element.setAttribute("style", value);
    else if (attributeName === "tip") setTip(element, value);
    else if (attributeName.startsWith("on") && typeof value === "function")
      element.addEventListener(attributeName.slice(2).toLowerCase(), value);
    else if (attributeName === "dataset") Object.assign(element.dataset, value);
    else if (attributeName in element && typeof value !== "string")
      (element as any)[attributeName] = value;
    else
      element.setAttribute(attributeName, value === true ? "" : String(value));
  }

  append(element, children);

  return element;
}

export function append(element: Element, children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;

    element.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
}

export function icon(node: IconNode, size = 16, className = ""): SVGElement {
  const svg = createElement(node, {
    width: size,
    height: size,
    "stroke-width": 2,
    class: `ico ${className}`,
  });

  svg.setAttribute("aria-hidden", "true");

  return svg;
}

/** Button with an optional icon and label. */
export function button(options: {
  icon?: IconNode;
  label?: string;
  tip?: string;
  className?: string;
  onClick?: (event: MouseEvent) => void;
  size?: number;
}): HTMLButtonElement {
  const buttonElement = html("button", {
    class: `btn ${options.className ?? ""}`,
    type: "button",
    tip: options.tip,
  });

  if (options.icon)
    buttonElement.append(icon(options.icon, options.size ?? 16));

  if (options.label) buttonElement.append(html("span", {}, options.label));

  if (options.onClick) buttonElement.addEventListener("click", options.onClick);

  if (!options.label) {
    buttonElement.classList.add("icon-only");
    if (options.tip)
      buttonElement.setAttribute(
        "aria-label",
        options.tip.replace(/\s*\(.*\)$/, ""),
      ); // drop "(Ctrl+X)"
  }

  return buttonElement;
}
