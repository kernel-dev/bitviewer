// Walking the SVD element tree: properties inherited from parents, and
// elements derived from others (derivedFrom).

import { parseSvdNumber } from "./values";
import { childText, type XmlElement } from "./xml";

/** Register properties that are inherited down the tree. */
export interface Inherited {
  size: number;
  access: string;
  resetValue: bigint;
  resetMask: bigint | null;
}

export function inherit(element: XmlElement, parent: Inherited): Inherited {
  const size = parseSvdNumber(childText(element, "size"));
  const resetValue = parseSvdNumber(childText(element, "resetValue"));
  const resetMask = parseSvdNumber(childText(element, "resetMask"));
  return {
    size: size === null ? parent.size : Number(size),
    access: childText(element, "access") ?? parent.access,
    resetValue: resetValue ?? parent.resetValue,
    resetMask: resetMask ?? parent.resetMask,
  };
}

/** An element with the children of the one it is derived from, for those it
 *  doesn't give itself (the derived element's own children win). */
export function merged(
  element: XmlElement,
  base: XmlElement | undefined,
): XmlElement {
  if (!base) return element;
  const own = new Set(element.children.map((item) => item.name));
  return {
    ...element,
    children: [
      ...base.children.filter((item) => !own.has(item.name)),
      ...element.children,
    ],
  };
}

/** Finds the element `derivedFrom` names: first among `siblings`, then by its
 *  last dotted part anywhere in `everything`. */
export function findBase(
  reference: string | undefined,
  siblings: XmlElement[],
  everything: () => XmlElement[],
): XmlElement | undefined {
  if (!reference) return undefined;
  const last = reference.split(".").pop()!.trim();
  const byName = (candidate: XmlElement) =>
    childText(candidate, "name") === last;
  return siblings.find(byName) ?? everything().find(byName);
}

/** Every element called `name` under `root`, at any depth. */
export function allNamed(root: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];

  const visit = (element: XmlElement) => {
    for (const item of element.children) {
      if (item.name === name) out.push(item);
      visit(item);
    }
  };

  visit(root);
  return out;
}

/** The text of a child element, with whitespace runs collapsed. */
export function text(element: XmlElement, name: string): string {
  return (childText(element, name) ?? "").replace(/\s+/g, " ").trim();
}
