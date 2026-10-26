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
