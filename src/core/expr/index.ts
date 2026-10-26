// A small expression language, parsed by hand (no eval):
//
//   numbers   42  0x2A  0b101010  0o52  1_000  (and 1.5 / 2e-3 in real mode)
//   names     CTRL  x  {Value 1}  `Value 1`   (braces/backticks allow spaces)
//   operators ( )  unary - + ~ !  **  * / %  + -  << >>  &  ^  |
//   calls     min(a, b)  max  abs  bit(n)  mask(n)  popcount(x)
//             real mode also: round floor ceil sqrt pow log log2 log10 exp
//
// Integer mode works on BigInt (exact at 512 bits); real mode on numbers,
// used for field unit formulas such as `x * 0.5 - 40`.
//
// parse.ts turns text into a tree; integer.ts and real.ts evaluate it.

export { evalInt } from "./integer";
export { type Expr, ExprError, namesIn, parseExpr } from "./parse";
export { evalReal, linearity } from "./real";
