// CMSIS-SVD import: reads a System View Description (the XML register
// description chip vendors publish for Arm Cortex-M parts) into registers
// with fields, named values and reset values.
//
// Supported: device / peripheral / cluster / register / field nesting,
// inherited register properties (size, access, resetValue, resetMask),
// derivedFrom on peripherals, clusters, registers, fields and
// enumeratedValues, dim arrays (dim, dimIncrement, dimIndex, %s and [%s]),
// the three ways of giving a field's bits (bitOffset/bitWidth, lsb/msb,
// bitRange), and enumerated values with don't-care bits (#1x0, 0b1x0).
//
// Spec: https://open-cmsis-pack.github.io/svd-spec/main/

import { GROUP_COLORS, MAX_WIDTH } from "./model";
import type { Template, TemplateField } from "./templates";
import { child, children, childText, parseXml, type XmlElement } from "./xml";

export class SvdError extends Error {}

export interface SvdEnum {
  value: bigint;
  name: string;
  description: string;
}

export interface SvdField {
  name: string;
  description: string;
  lsb: number;
  msb: number;
  /** SVD access, e.g. "read-only", "read-write", "write-only". */
  access: string;
  enums: SvdEnum[];
}

export interface SvdRegister {
  /** Peripheral, clusters and register joined with ".", e.g. "USART1.CR1". */
  path: string;
  name: string;
  description: string;
  peripheral: string;
  address: bigint;
  size: number;
  access: string;
  resetValue: bigint;
  fields: SvdField[];
  /** Fields left out, and why (overlaps, outside the register…). */
  warnings: string[];
}

export interface SvdPeripheral {
  name: string;
  description: string;
  groupName: string;
  baseAddress: bigint;
  registers: SvdRegister[];
}

export interface SvdDevice {
  name: string;
  description: string;
  peripherals: SvdPeripheral[];
  /** Problems that didn't stop the import (e.g. a register wider than 512 bits). */
  warnings: string[];
}

/** Register properties that are inherited down the tree. */
interface Inherited {
  size: number;
  access: string;
  resetValue: bigint;
  resetMask: bigint | null;
}

const MAX_DIM = 1024; // per array, so a typo can't ask for millions of registers
const MAX_DONT_CARE = 8; // enumerated values like #1xxx expand to at most 256 values

/** A number as SVD writes them: 0x1F, 0X1F, #11111 (binary) or 31. Optional
 *  k / M / G / T suffix (kilo… tera, ×1024). Returns null when not a number. */
export function parseSvdNumber(text: string | undefined): bigint | null {
  if (text === undefined) return null;
  const match = /^\+?(0x[0-9a-f]+|#[01]+|0b[01]+|\d+)([kmgt])?$/i.exec(
    text.trim(),
  );
  if (!match) return null;
  const digits = match[1];
  let value =
    digits[0] === "#"
      ? BigInt(`0b${digits.slice(1)}`)
      : /^0b/i.test(digits)
        ? BigInt(`0b${digits.slice(2)}`)
        : BigInt(digits.toLowerCase());
  if (match[2])
    value <<= BigInt(10 * ("kmgt".indexOf(match[2].toLowerCase()) + 1));
  return value;
}

/** Enumerated value text: a number, or binary with x don't-care bits ("#1x0",
 *  "0b1x0") which stands for every value it matches. */
function enumValues(text: string): bigint[] | null {
  const binary = /^(?:#|0b)([01x]+)$/i.exec(text.trim());
  if (!binary || !/x/i.test(binary[1])) {
    const value = parseSvdNumber(text);
    return value === null ? null : [value];
  }
  const pattern = binary[1].toLowerCase();
  const free = [...pattern].filter((digit) => digit === "x").length;
  if (free > MAX_DONT_CARE) return null;
  const values: bigint[] = [];
  for (let combination = 0; combination < 1 << free; combination++) {
    let bit = free;
    const digits = [...pattern].map((digit) =>
      digit === "x" ? String((combination >> --bit) & 1) : digit,
    );
    values.push(BigInt(`0b${digits.join("")}`));
  }
  return values;
}

/** dimIndex as a list: "0-7", "A-D" or "a,b,c". Defaults to 0 … dim-1. */
function dimIndices(dim: number, indexText: string | undefined): string[] {
  if (indexText) {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(indexText);
    if (range) {
      const first = Number(range[1]);
      return Array.from({ length: dim }, (_, index) => String(first + index));
    }
    const letters = /^\s*([A-Z])\s*-\s*([A-Z])\s*$/.exec(indexText);
    if (letters) {
      const first = letters[1].charCodeAt(0);
      return Array.from({ length: dim }, (_, index) =>
        String.fromCharCode(first + index),
      );
    }
    const list = indexText.split(",").map((part) => part.trim());
    if (list.length === dim) return list;
  }
  return Array.from({ length: dim }, (_, index) => String(index));
}

/** One element, or its copies when it is a dim array: [name, offset step index]. */
function expandDim(
  element: XmlElement,
  name: string,
  warnings: string[],
): { name: string; index: number }[] {
  const dim = Number(parseSvdNumber(childText(element, "dim")) ?? 0n);
  if (!dim) return [{ name: name.replace(/\[%s\]|%s/g, ""), index: 0 }];
  if (dim > MAX_DIM) {
    warnings.push(
      `${name}: dim ${dim} is more than ${MAX_DIM}; only the first ${MAX_DIM} are read`,
    );
  }
  const count = Math.min(dim, MAX_DIM);
  const indices = dimIndices(count, childText(element, "dimIndex"));
  return indices.map((index, position) => ({
    // "[%s]" marks a C array (CCR[4]); as separate values it becomes CCR0 … CCR3
    name: name.replace(/\[%s\]/g, index).replace(/%s/g, index),
    index: position,
  }));
}

function inherit(element: XmlElement, parent: Inherited): Inherited {
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
function merged(element: XmlElement, base: XmlElement | undefined): XmlElement {
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
function findBase(
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
function allNamed(root: XmlElement, name: string): XmlElement[] {
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

function text(element: XmlElement, name: string): string {
  return (childText(element, name) ?? "").replace(/\s+/g, " ").trim();
}

/** Reads a CMSIS-SVD file. Throws SvdError (or XmlError for broken XML). */
export function parseSvd(source: string): SvdDevice {
  const root = parseXml(source);
  if (root.name !== "device")
    throw new SvdError(
      `This is not a CMSIS-SVD file (it starts with <${root.name}>, not <device>)`,
    );
  const warnings: string[] = [];
  const deviceProps = inherit(root, {
    size: 32,
    access: "read-write",
    resetValue: 0n,
    resetMask: null,
  });
  const peripheralElements = children(child(root, "peripherals"), "peripheral");
  const lazy = <T>(make: () => T) => {
    let cached: T | undefined;
    return () => (cached ??= make());
  };
  const allRegisters = lazy(() => allNamed(root, "register"));
  const allClusters = lazy(() => allNamed(root, "cluster"));
  const allFields = lazy(() => allNamed(root, "field"));
  const allEnums = lazy(() => allNamed(root, "enumeratedValues"));

  const readEnums = (field: XmlElement): SvdEnum[] => {
    const out: SvdEnum[] = [];
    const seen = new Set<bigint>();
    for (const list of children(field, "enumeratedValues")) {
      const resolved = merged(
        list,
        findBase(list.attributes.derivedFrom, [], allEnums),
      );
      for (const item of children(resolved, "enumeratedValue")) {
        const valueText = childText(item, "value");
        if (valueText === undefined) continue; // isDefault entries have no value
        const values = enumValues(valueText);
        if (!values) continue;
        for (const value of values) {
          if (seen.has(value)) continue; // read and write lists often repeat
          seen.add(value);
          out.push({
            value,
            name: text(item, "name") || valueText,
            description: text(item, "description"),
          });
        }
      }
    }
    return out;
  };

  const readFields = (
    register: XmlElement,
    access: string,
    registerWarnings: string[],
  ): SvdField[] => {
    const fieldElements = children(child(register, "fields"), "field");
    const out: SvdField[] = [];
    for (const raw of fieldElements) {
      const field = merged(
        raw,
        findBase(raw.attributes.derivedFrom, fieldElements, allFields),
      );
      const baseName = text(field, "name");
      let lsb: number | null = null;
      let width: number | null = null;
      const bitRange = /^\[(\d+):(\d+)\]$/.exec(
        childText(field, "bitRange") ?? "",
      );
      if (bitRange) {
        lsb = Number(bitRange[2]);
        width = Number(bitRange[1]) - lsb + 1;
      } else if (child(field, "lsb") && child(field, "msb")) {
        lsb = Number(parseSvdNumber(childText(field, "lsb")));
        width = Number(parseSvdNumber(childText(field, "msb"))) - lsb + 1;
      } else if (child(field, "bitOffset")) {
        lsb = Number(parseSvdNumber(childText(field, "bitOffset")));
        width = Number(parseSvdNumber(childText(field, "bitWidth")) ?? 1n);
      }
      if (lsb === null || width === null || !(width >= 1) || !(lsb >= 0)) {
        registerWarnings.push(`${baseName}: no usable bit position`);
        continue;
      }
      const step = Number(
        parseSvdNumber(childText(field, "dimIncrement")) ?? 0n,
      );
      const enums = readEnums(field);
      for (const copy of expandDim(field, baseName, registerWarnings)) {
        const fieldLsb = lsb + copy.index * step;
        out.push({
          name: copy.name,
          description: text(field, "description"),
          lsb: fieldLsb,
          msb: fieldLsb + width - 1,
          access: childText(field, "access") ?? access,
          enums,
        });
      }
    }
    return out;
  };

  /** Registers of a peripheral or cluster, with clusters flattened into paths. */
  const readRegisters = (
    container: XmlElement,
    peripheralName: string,
    pathPrefix: string,
    baseAddress: bigint,
    props: Inherited,
    out: SvdRegister[],
  ) => {
    const items = container.children.filter(
      (item) => item.name === "register" || item.name === "cluster",
    );
    for (const raw of items) {
      const isCluster = raw.name === "cluster";
      const element = merged(
        raw,
        findBase(
          raw.attributes.derivedFrom,
          items,
          isCluster ? allClusters : allRegisters,
        ),
      );
      const ownProps = inherit(element, props);
      const offset = parseSvdNumber(childText(element, "addressOffset")) ?? 0n;
      const step = parseSvdNumber(childText(element, "dimIncrement")) ?? 0n;
      const baseName = text(element, "name");
      for (const copy of expandDim(element, baseName, warnings)) {
        const address = baseAddress + offset + BigInt(copy.index) * step;
        const path = `${pathPrefix}.${copy.name}`;
        if (isCluster) {
          readRegisters(element, peripheralName, path, address, ownProps, out);
          continue;
        }
        if (ownProps.size < 1 || ownProps.size > MAX_WIDTH) {
          warnings.push(
            `${path}: ${ownProps.size} bits is outside 1–${MAX_WIDTH}; skipped`,
          );
          continue;
        }
        const registerWarnings: string[] = [];
        const fields = fitFields(
          readFields(element, ownProps.access, registerWarnings),
          ownProps.size,
          registerWarnings,
        );
        const sizeMask = (1n << BigInt(ownProps.size)) - 1n;
        out.push({
          path,
          name: copy.name,
          description: text(element, "description"),
          peripheral: peripheralName,
          address,
          size: ownProps.size,
          access: ownProps.access,
          resetValue:
            ownProps.resetValue & (ownProps.resetMask ?? sizeMask) & sizeMask,
          fields,
          warnings: registerWarnings,
        });
      }
    }
  };

  const peripherals: SvdPeripheral[] = [];
  for (const raw of peripheralElements) {
    const element = merged(
      raw,
      findBase(raw.attributes.derivedFrom, peripheralElements, () => []),
    );
    const props = inherit(element, deviceProps);
    const baseAddress = parseSvdNumber(childText(element, "baseAddress")) ?? 0n;
    for (const copy of expandDim(element, text(element, "name"), warnings)) {
      const step = parseSvdNumber(childText(element, "dimIncrement")) ?? 0n;
      const address = baseAddress + BigInt(copy.index) * step;
      const registers: SvdRegister[] = [];
      const registersElement = child(element, "registers");
      if (registersElement)
        readRegisters(
          registersElement,
          copy.name,
          copy.name,
          address,
          props,
          registers,
        );
      peripherals.push({
        name: copy.name,
        description: text(element, "description"),
        groupName: text(element, "groupName"),
        baseAddress: address,
        registers,
      });
    }
  }
  return {
    name: text(root, "name") || "Device",
    description: text(root, "description"),
    peripherals,
    warnings,
  };
}

/** Drops fields that stick out of the register or overlap an earlier one
 *  (Bit Viewer fields can't overlap; some SVDs describe the same bits twice). */
function fitFields(
  fields: SvdField[],
  size: number,
  warnings: string[],
): SvdField[] {
  const kept: SvdField[] = [];
  for (const field of fields) {
    if (field.msb >= size) {
      warnings.push(
        `${field.name} [${field.msb}:${field.lsb}] is outside the ${size}-bit register`,
      );
      continue;
    }
    const clash = kept.find(
      (other) => !(other.msb < field.lsb || other.lsb > field.msb),
    );
    if (clash) {
      warnings.push(`${field.name} overlaps ${clash.name}, so it was left out`);
      continue;
    }
    kept.push(field);
  }
  return kept;
}

const hexAddress = (address: bigint) =>
  `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;

/** Field access in Bit Viewer terms: read-only stays read-only, fields called
 *  RESERVED are reserved, everything else (including write-only) is rw. */
function fieldAccess(field: SvdField): TemplateField["access"] {
  if (/^reserved/i.test(field.name)) return "reserved";
  return field.access === "read-only" ? "ro" : "rw";
}

/** A register as a field template (the same shape the app saves). */
export function registerTemplate(
  register: SvdRegister,
  deviceName: string,
): Template {
  const fields = [...register.fields].sort(
    (first, second) => second.msb - first.msb,
  );
  return {
    name: `${deviceName} ${register.path}`,
    width: register.size,
    description: [
      `${hexAddress(register.address)}`,
      register.description,
      `reset ${hexAddress(register.resetValue).replace(/^0x0+(?=.)/, "0x")}`,
    ]
      .filter(Boolean)
      .join(" · "),
    fields: fields.map((field, index) => ({
      lo: field.lsb,
      hi: field.msb,
      name: field.name,
      color: GROUP_COLORS[index % GROUP_COLORS.length],
      description: field.description || undefined,
      access: fieldAccess(field),
      named: field.enums.length
        ? field.enums.map((item) => ({
            value: item.value.toString(),
            label: item.name,
          }))
        : undefined,
    })),
  };
}

export { hexAddress };
