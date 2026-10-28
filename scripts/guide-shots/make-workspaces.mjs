// Writes the workspaces the guide's screenshots are staged in
// (docs/guide/shots/*.bitview). Run it again after changing the registers:
//   node scripts/guide-shots/make-workspaces.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = join(import.meta.dirname, "..", "..", "docs", "guide", "shots");
mkdirSync(out, { recursive: true });

const colors = ["#f59f00", "#2fb344", "#ae3ec9", "#15aabf", "#4c6ef5", "#82c91e", "#f76707", "#e64980"];
const hex = (n) => "0x" + BigInt(n).toString(16).toUpperCase();
const field = (lo, hi, name, description, extra = {}, index = 0) => ({
  lo,
  hi,
  name,
  color: colors[index % colors.length],
  base: hi > lo ? 16 : 2,
  description,
  ...extra,
});
const named = (...labels) => ({ named: labels.map((label, value) => ({ value: String(value), label })) });
const fields = (list) => list.map((args, index) => field(...args.slice(0, 4), args[4] ?? {}, index));
const value = (name, width, bits, groups, extra = {}) => ({
  name,
  width,
  value: hex(bits),
  view: "line",
  msb_first: true,
  full_base: 16,
  default_row_base: 16,
  show_bases: false,
  collapsed: false,
  snapshots: [],
  row_bases: {},
  compares: {},
  hidden_compares: {},
  groups,
  ...extra,
});
const workspace = (values, peripherals = []) => JSON.stringify({ app: "bitviewer", version: 1, values, peripherals }, null, 2);

const ctrlFields = fields([
  [0, 0, "EN", "Turns the UART on", named("Off", "On")],
  [1, 3, "MODE", "Operating mode", named("Off", "Asynchronous", "Synchronous", "IrDA")],
  [4, 5, "PARITY", "Parity bit", named("None", "Even", "Odd")],
  [6, 6, "STOP", "Stop bits", named("1 bit", "2 bits")],
  [8, 8, "TXIE", "Interrupt when the transmit buffer empties", named("Off", "On")],
  [9, 9, "RXIE", "Interrupt when a byte arrives", named("Off", "On")],
  [12, 13, "FIFO", "Receive FIFO trigger level", named("1 byte", "4 bytes", "8 bytes", "14 bytes")],
  [16, 19, "STATUS", "Line status (read-only)", { access: "ro" }],
]);
const uart = (collapsed) => {
  const reg = (name, offset, description, width, bits, groups) =>
    value(name, width, bits, groups, { block: name.startsWith("GPIOA") ? "GPIOA" : "UART0", offset: hex(offset), description, collapsed });
  const moder = [];
  for (let pin = 15; pin >= 0; pin--) moder.push([2 * pin, 2 * pin + 1, `MODER${pin}`, `Mode of pin PA${pin}`, named("Input", "Output", "Alternate", "Analog")]);
  const odr = [];
  for (let pin = 15; pin >= 0; pin--) odr.push([pin, pin, `ODR${pin}`, `Output level of pin PA${pin}`, named("Low", "High")]);
  return workspace(
    [
      reg("UART0.CTRL", 0x0, "Control register", 32, 0x2303, ctrlFields),
      reg("UART0.BAUD", 0x4, "Baud rate divider", 32, 0x683, fields([
        [0, 3, "DIV_FRACTION", "Fraction of the divider, in sixteenths"],
        [4, 15, "DIV_MANTISSA", "Integer part of the divider"],
      ])),
      reg("UART0.DATA", 0x8, "Data register", 32, 0x41, fields([[0, 7, "DATA", "The byte to send, or the last one received"]])),
      reg("UART0.STATUS", 0xc, "Status register", 32, 0xc0, fields([
        [0, 0, "PE", "Parity error", { access: "ro" }],
        [1, 1, "FE", "Framing error", { access: "ro" }],
        [3, 3, "ORE", "Overrun: a byte arrived before the last one was read", { access: "ro" }],
        [5, 5, "RXNE", "A byte is waiting in DATA", { access: "ro" }],
        [6, 6, "TC", "Transmission complete", { access: "ro" }],
        [7, 7, "TXE", "DATA can take the next byte", { access: "ro" }],
      ])),
      reg("GPIOA.MODER", 0x0, "Port mode register", 32, 0xa8000400, fields(moder)),
      reg("GPIOA.ODR", 0x14, "Output data register", 32, 0x20, fields(odr)),
    ],
    [
      { name: "UART0", base: "0x40011000", description: "Universal asynchronous receiver-transmitter" },
      { name: "GPIOA", base: "0x40020000", description: "General-purpose I/O, port A" },
    ],
  );
};

writeFileSync(join(out, "uart.bitview"), uart(false));
writeFileSync(join(out, "peripheral.bitview"), uart(true));
writeFileSync(
  join(out, "compare.bitview"),
  workspace([value("CONFIG", 32, 0x2303, ctrlFields, { compares: { 0: "0x2343" }, description: "A UART configuration, compared with another" })]),
);
writeFileSync(
  join(out, "float.bitview"),
  workspace([
    value("PI", 32, 0x40490fdb, fields([
      [0, 22, "FRACTION", "Fraction (mantissa without its leading 1)"],
      [23, 30, "EXPONENT", "Exponent, biased by 127"],
      [31, 31, "SIGN", "Sign: 1 is negative"],
    ]), { description: "π as an IEEE-754 float32" }),
  ]),
);
writeFileSync(
  join(out, "timer.bitview"),
  workspace([
    value("TIMER.CFG", 64, 0x0021_0000_3e80_0f43n, fields([
      [0, 0, "ENABLE", "Starts the timer", named("Off", "On")],
      [1, 2, "MODE", "Counting mode", named("Up", "Down", "Up and down")],
      [4, 15, "PRESCALE", "Clock divider, minus one"],
      [16, 47, "RELOAD", "Count to reload when the timer wraps"],
      [48, 48, "IRQ_EN", "Interrupt on wrap", named("Off", "On")],
      [52, 55, "CHANNEL", "Output channel"],
    ]), { description: "Timer configuration" }),
  ]),
);
console.log("wrote", out);
