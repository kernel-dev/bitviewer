// What an SVD import produces: a device with peripherals, registers, fields
// and enumerated values.

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
  peripheralBase: bigint;
  peripheralDescription: string;
  address: bigint;
  size: number;
  access: string;
  resetValue: bigint;
  fields: SvdField[];

  /** Fields left out, and why (overlaps, outside the register…). */
  warnings: string[];

  /** Where the register sits in the file, for putting a selection back in
   *  file order (see inFileOrder). */
  order: readonly number[];
}

/** A register as the file describes it: one register, or an array of copies
 *  when the register, a cluster around it or its peripheral has a dim. Copies
 *  are only made when asked for, so an array of any size is cheap to read. */
export interface SvdRegisterArray {
  /** Path inside the peripheral, arrays shown with their indices: "CH[0-1].CFG". */
  label: string;

  description: string;
  size: number;

  /** Number of copies: 1 for a plain register. */
  count: number;

  /** The fields every copy has. */
  fields: SvdField[];

  /** Fields left out, and why. */
  warnings: string[];

  /** Copy `position` (0 … count-1). With nested arrays the innermost one
   *  changes fastest: CH0.CFG0, CH0.CFG1, CH1.CFG0… */
  at(position: number): SvdRegister;
}

export interface SvdPeripheral {
  /** With its indices when the peripheral is an array: "TIM[2-5]". */
  name: string;

  description: string;
  groupName: string;

  /** Base address of the first copy. */
  baseAddress: bigint;

  /** Copies of the peripheral: 1 unless it has a dim. */
  count: number;

  /** Each covers every copy of the peripheral. */
  registers: SvdRegisterArray[];
}

export interface SvdDevice {
  name: string;
  description: string;
  peripherals: SvdPeripheral[];

  /** Problems that didn't stop the import (e.g. a register wider than 512 bits). */
  warnings: string[];
}
