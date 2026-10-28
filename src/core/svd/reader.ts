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
// Register arrays (a dim on the peripheral, a cluster or the register) stay
// one SvdRegisterArray; its copies are made only when asked for, so arrays
// of any size, nested or not, are cheap to read.
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
  type SvdRegisterArray,
} from "./types";
import {
  arrayName,
  copyName,
  type Dim,
  enumValues,
  parseSvdNumber,
  readDim,
} from "./values";
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

/** One step of a register's path: its peripheral, a cluster, or the register
 *  itself, each possibly an array. */
interface Level {
  name: string;
  dim: Dim;
  /** addressOffset (0 for the peripheral, whose base is kept apart). */
  offset: bigint;
  /** Position among its siblings in the file. */
  position: number;
}

/** The peripheral's details every copy of its registers needs. */
interface PeripheralInfo {
  baseAddress: bigint;
  description: string;
}

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

    for (const [position, raw] of peripheralElements.entries()) {
      const element = merged(
        raw,
        findBase(raw.attributes.derivedFrom, peripheralElements, () => []),
      );
      const props = inherit(element, deviceProps);
      const name = text(element, "name");
      const dim = readDim(element, name, this.warnings);
      if (!dim) continue;

      const info: PeripheralInfo = {
        baseAddress: parseSvdNumber(childText(element, "baseAddress")) ?? 0n,
        description: text(element, "description"),
      };
      const registers: SvdRegisterArray[] = [];
      const registersElement = child(element, "registers");
      if (registersElement)
        this.readRegisters(
          registersElement,
          info,
          [{ name, dim, offset: 0n, position }],
          props,
          registers,
        );

      peripherals.push({
        name: arrayName(name, dim),
        description: info.description,
        groupName: text(element, "groupName"),
        baseAddress: info.baseAddress,
        count: dim.count,
        registers,
      });
    }

    return {
      name: text(root, "name") || "Device",
      description: text(root, "description"),
      peripherals,
      warnings: this.warnings,
    };
  }

  /** Registers of a peripheral or cluster, with clusters flattened into
   *  paths. `levels` are the peripheral and clusters around them. */
  private readRegisters(
    container: XmlElement,
    peripheral: PeripheralInfo,
    levels: Level[],
    props: Inherited,
    out: SvdRegisterArray[],
  ): void {
    const items = container.children.filter(
      (item) => item.name === "register" || item.name === "cluster",
    );
    const labelOf = (path: Level[]) =>
      path.map((level) => arrayName(level.name, level.dim)).join(".");

    for (const [position, raw] of items.entries()) {
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
      const name = text(element, "name");
      const dim = readDim(element, `${labelOf(levels)}.${name}`, this.warnings);
      if (!dim) continue;

      const path: Level[] = [
        ...levels,
        {
          name,
          dim,
          offset: parseSvdNumber(childText(element, "addressOffset")) ?? 0n,
          position,
        },
      ];
      const label = labelOf(path);

      if (isCluster) {
        this.readRegisters(element, peripheral, path, ownProps, out);
        continue;
      }

      if (ownProps.size < 1 || ownProps.size > MAX_WIDTH) {
        this.warnings.push(
          `${label}: ${ownProps.size} bits is outside 1–${MAX_WIDTH}; skipped`,
        );
        continue;
      }

      const copies = path.reduce(
        (total, level) => total * BigInt(level.dim.count),
        1n,
      );
      if (copies > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.warnings.push(
          `${label}: ${copies} copies are too many to count; skipped`,
        );
        continue;
      }

      // every copy has the same fields, so they are read once
      const warnings: string[] = [];
      const fields = fitFields(
        this.readFields(element, ownProps.access, ownProps.size, warnings),
        ownProps.size,
        warnings,
      );
      const sizeMask = (1n << BigInt(ownProps.size)) - 1n;

      out.push(
        registerArray(path, peripheral, {
          label: labelOf(path.slice(1)),
          description: text(element, "description"),
          size: ownProps.size,
          count: Number(copies),
          fields,
          warnings,
          access: ownProps.access,
          resetValue:
            ownProps.resetValue & (ownProps.resetMask ?? sizeMask) & sizeMask,
        }),
      );
    }
  }

  private readFields(
    register: XmlElement,
    access: string,
    size: number,
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

      const dim = readDim(field, baseName, registerWarnings);
      if (!dim) continue;
      const step = Number(dim.step);

      // A register has at most 512 bits, so only the first copies of a big
      // field array can fit; the rest would be outside it or on top of the
      // first, and aren't made at all.
      const fit =
        step > 0
          ? Math.min(dim.count, Math.max(1, Math.ceil((size - lsb) / step)))
          : 1;
      if (fit < dim.count)
        registerWarnings.push(
          `${arrayName(baseName, dim)}: ${dim.count - fit} more ${
            step > 0
              ? `copies would be outside the ${size}-bit register`
              : "copies would overlap the first"
          }, so they were left out`,
        );

      const enums = this.readEnums(field);

      for (let index = 0; index < fit; index++) {
        const fieldLsb = lsb + index * step;
        out.push({
          name: copyName(baseName, dim.index(index)),
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

/** A register (or array of them) at the end of `path`: its copies are worked
 *  out from the position, one level at a time. */
function registerArray(
  path: Level[],
  peripheral: PeripheralInfo,
  shared: Omit<SvdRegisterArray, "at"> & { access: string; resetValue: bigint },
): SvdRegisterArray {
  const { access, resetValue, ...array } = shared;

  const at = (position: number): SvdRegister => {
    if (!Number.isInteger(position) || position < 0 || position >= array.count)
      throw new RangeError(`${array.label} has no copy ${position}`);

    // the innermost level changes fastest
    const indices = new Array<number>(path.length);
    let rest = position;
    for (let level = path.length - 1; level >= 0; level--) {
      const count = path[level].dim.count;
      indices[level] = rest % count;
      rest = Math.floor(rest / count);
    }

    const names = path.map((level, depth) =>
      copyName(level.name, level.dim.index(indices[depth])),
    );
    const peripheralBase =
      peripheral.baseAddress + BigInt(indices[0]) * path[0].dim.step;
    let address = peripheralBase;
    for (let depth = 1; depth < path.length; depth++)
      address +=
        path[depth].offset + BigInt(indices[depth]) * path[depth].dim.step;

    return {
      path: names.join("."),
      name: names[names.length - 1],
      description: array.description,
      peripheral: names[0],
      peripheralBase,
      peripheralDescription: peripheral.description,
      address,
      size: array.size,
      access,
      resetValue,
      fields: array.fields,
      warnings: array.warnings,
      order: path.flatMap((level, depth) => [level.position, indices[depth]]),
    };
  };

  return { ...array, at };
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
