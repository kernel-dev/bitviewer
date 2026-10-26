// Bitwise operations on a value or a part of it (a row, a selection).

import { maxValue } from "../format/integers";
import { ModelError } from "./validate";

/** Operations on a value / row. Shifts and rotates take an amount (default 1);
 *  and / or / xor take an operand. */
export type Op =
  | "invert"
  | "clear"
  | "set"
  | "shl"
  | "shr"
  | "asr"
  | "rol"
  | "ror"
  | "bswap"
  | "brev"
  | "neg"
  | "inc"
  | "dec"
  | "and"
  | "or"
  | "xor";

/** Applies `op` to a `width`-bit value. `arg` is the shift/rotate amount
 *  (default 1) or the and/or/xor operand. */
export function applyOp(
  operation: Op,
  value: bigint,
  width: number,
  argument = 1n,
): bigint {
  const mask = maxValue(width);
  const widthBig = BigInt(width);
  value &= mask;

  const amount = () => {
    if (argument < 0n) throw new ModelError("The amount can't be negative");
    return argument;
  };

  switch (operation) {
    case "invert":
      return ~value & mask;
    case "clear":
      return 0n;
    case "set":
      return mask;
    case "shl":
      return amount() >= widthBig ? 0n : (value << argument) & mask;
    case "shr":
      return amount() >= widthBig ? 0n : value >> argument;

    case "asr": {
      const shift = amount() >= widthBig ? widthBig - 1n : argument;
      const signed =
        (value >> (widthBig - 1n)) & 1n ? value - (1n << widthBig) : value;
      return (signed >> shift) & mask;
    }

    case "rol":
    case "ror": {
      const rotation = amount() % widthBig;
      if (rotation === 0n) return value;
      const left = operation === "rol" ? rotation : widthBig - rotation;
      return ((value << left) | (value >> (widthBig - left))) & mask;
    }

    case "bswap": {
      if (width % 8)
        throw new ModelError(
          "Swapping bytes needs a width that is a whole number of bytes",
        );

      let out = 0n;

      for (let i = 0n; i < widthBig / 8n; i++)
        out = (out << 8n) | ((value >> (i * 8n)) & 0xffn);

      return out;
    }

    case "brev": {
      let out = 0n;

      for (let i = 0n; i < widthBig; i++)
        out = (out << 1n) | ((value >> i) & 1n);

      return out;
    }

    case "neg":
      return -value & mask;
    case "inc":
      return (value + 1n) & mask;
    case "dec":
      return (value - 1n) & mask;
    case "and":
      return value & argument & mask;
    case "or":
      return (value | argument) & mask;
    case "xor":
      return (value ^ argument) & mask;
  }

  throw new ModelError(`Unknown operation ${operation}`);
}
