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

import { MAX_WIDTH } from "../model";
import {
  allNamed,
  findBase,
  type Inherited,
  inherit,
  merged,
  text,
} from "./tree";
import {
  type SvdDevice,
  type SvdEnum,
  SvdError,
  type SvdField,
  type SvdPeripheral,
  type SvdRegister,
} from "./types";
import { enumValues, expandDim, parseSvdNumber } from "./values";
import { child, children, childText, parseXml, type XmlElement } from "./xml";

/** Reads a CMSIS-SVD file. Throws SvdError (or XmlError for broken XML). */
export function parseSvd(source: string): SvdDevice {
  const root = parseXml(source);
  if (root.name !== "device")
    throw new SvdError(
      `This is not a CMSIS-SVD file (it starts with <${root.name}>, not <device>)`,
    );

  return new SvdReader(root).device();
}

/** A list that is only collected when first needed. */
const lazy = <T>(make: () => T) => {
  let cached: T | undefined;
  return () => (cached ??= make());
};

/** Reads one device: peripherals, then their registers (clusters flattened
 *  into dotted paths), then fields and their enumerated values. */
class SvdReader {
  /** Problems that don't stop the import. */
  private warnings: string[] = [];
  // every element of a kind, for derivedFrom references across parents
  private allRegisters = lazy(() => allNamed(this.root, "register"));
  private allClusters = lazy(() => allNamed(this.root, "cluster"));
  private allFields = lazy(() => allNamed(this.root, "field"));
  private allEnums = lazy(() => allNamed(this.root, "enumeratedValues"));

  constructor(private root: XmlElement) {}

  device(): SvdDevice {
    const root = this.root;
    const deviceProps = inherit(root, {
      size: 32,
      access: "read-write",
      resetValue: 0n,
      resetMask: null,
    });
    const peripheralElements = children(
      child(root, "peripherals"),
      "peripheral",
    );
    const peripherals: SvdPeripheral[] = [];

    for (const raw of peripheralElements) {
      const element = merged(
        raw,
        findBase(raw.attributes.derivedFrom, peripheralElements, () => []),
      );
      const props = inherit(element, deviceProps);
      const baseAddress =
        parseSvdNumber(childText(element, "baseAddress")) ?? 0n;

      for (const copy of expandDim(
        element,
        text(element, "name"),
        this.warnings,
      )) {
        const step = parseSvdNumber(childText(element, "dimIncrement")) ?? 0n;
        const address = baseAddress + BigInt(copy.index) * step;
        const registers: SvdRegister[] = [];
        const registersElement = child(element, "registers");
        if (registersElement)
          this.readRegisters(
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
      warnings: this.warnings,
    };
  }

  /** Registers of a peripheral or cluster, with clusters flattened into paths. */
  private readRegisters(
    container: XmlElement,
    peripheralName: string,
    pathPrefix: string,
    baseAddress: bigint,
    props: Inherited,
    out: SvdRegister[],
  ): void {
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
          isCluster ? this.allClusters : this.allRegisters,
        ),
      );
      const ownProps = inherit(element, props);
      const offset = parseSvdNumber(childText(element, "addressOffset")) ?? 0n;
      const step = parseSvdNumber(childText(element, "dimIncrement")) ?? 0n;
      const baseName = text(element, "name");
      for (const copy of expandDim(element, baseName, this.warnings)) {
        const address = baseAddress + offset + BigInt(copy.index) * step;
        const path = `${pathPrefix}.${copy.name}`;

        if (isCluster) {
          this.readRegisters(
            element,
            peripheralName,
            path,
            address,
            ownProps,
            out,
          );
          continue;
        }

        if (ownProps.size < 1 || ownProps.size > MAX_WIDTH) {
          this.warnings.push(
            `${path}: ${ownProps.size} bits is outside 1–${MAX_WIDTH}; skipped`,
          );
          continue;
        }

        const registerWarnings: string[] = [];
        const fields = fitFields(
          this.readFields(element, ownProps.access, registerWarnings),
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
  }

  private readFields(
    register: XmlElement,
    access: string,
    registerWarnings: string[],
  ): SvdField[] {
    const fieldElements = children(child(register, "fields"), "field");
    const out: SvdField[] = [];

    for (const raw of fieldElements) {
      const field = merged(
        raw,
        findBase(raw.attributes.derivedFrom, fieldElements, this.allFields),
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
      const enums = this.readEnums(field);

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
  }

  private readEnums(field: XmlElement): SvdEnum[] {
    const out: SvdEnum[] = [];
    const seen = new Set<bigint>();

    for (const list of children(field, "enumeratedValues")) {
      const resolved = merged(
        list,
        findBase(list.attributes.derivedFrom, [], this.allEnums),
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
  }
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
