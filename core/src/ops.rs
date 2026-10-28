//! Bitwise operations on a value or a part of it (a row, a selection).

use super::ModelError;
use super::integers::{Bits, mask};

/// Operations on a value / row. Shifts and rotates take an amount (default 1);
/// and / or / xor take an operand.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Op {
    Invert,
    Clear,
    Set,
    Shl,
    Shr,
    Asr,
    Rol,
    Ror,
    Bswap,
    Brev,
    Neg,
    Inc,
    Dec,
    And,
    Or,
    Xor,
}

/// Applies `op` to a `width`-bit value. `argument` is the shift/rotate amount
/// (1 when None) or the and/or/xor operand.
pub fn apply_op(op: Op, value: Bits, width: usize, argument: Option<Bits>) -> Result<Bits, ModelError> {
    let full = mask(width);
    let value = value & full;
    let operand = argument.unwrap_or(Bits::from(1u8));
    // a shift amount that fits a usize, capped at the width (anything above
    // shifts everything out anyway)
    let amount = || -> usize { if operand >= Bits::from(width) { width } else { operand.to::<usize>() } };

    Ok(match op {
        Op::Invert => !value & full,
        Op::Clear => Bits::ZERO,
        Op::Set => full,
        Op::Shl => {
            let shift = amount();
            if shift >= width { Bits::ZERO } else { (value << shift) & full }
        }
        Op::Shr => {
            let shift = amount();
            if shift >= width { Bits::ZERO } else { value >> shift }
        }
        Op::Asr => {
            let shift = amount().min(width - 1);
            let shifted = value >> shift;
            if value.bit(width - 1) {
                // fill the vacated top bits with the sign
                shifted | (full ^ (full >> shift))
            } else {
                shifted
            }
        }
        Op::Rol | Op::Ror => {
            let rotation = (operand % Bits::from(width)).to::<usize>();
            if rotation == 0 {
                value
            } else {
                let left = if op == Op::Rol { rotation } else { width - rotation };
                ((value << left) | (value >> (width - left))) & full
            }
        }
        Op::Bswap => {
            if !width.is_multiple_of(8) {
                return Err(ModelError::new("Swapping bytes needs a width that is a whole number of bytes"));
            }
            let mut out = Bits::ZERO;
            for byte in 0..width / 8 {
                out = (out << 8) | ((value >> (byte * 8)) & Bits::from(0xFFu8));
            }
            out
        }
        Op::Brev => {
            let mut out = Bits::ZERO;
            for index in 0..width {
                if value.bit(index) {
                    out.set_bit(width - 1 - index, true);
                }
            }
            out
        }
        Op::Neg => value.wrapping_neg() & full,
        Op::Inc => value.wrapping_add(Bits::from(1u8)) & full,
        Op::Dec => value.wrapping_sub(Bits::from(1u8)) & full,
        Op::And => value & operand & full,
        Op::Or => (value | operand) & full,
        Op::Xor => (value ^ operand) & full,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(op: Op, value: u64, width: usize, argument: Option<u64>) -> u64 {
        apply_op(op, Bits::from(value), width, argument.map(Bits::from)).unwrap().to::<u64>()
    }

    #[test]
    fn shifts_and_rotates() {
        assert_eq!(run(Op::Shl, 0b1001, 4, None), 0b0010);
        assert_eq!(run(Op::Shr, 0b1001, 4, Some(3)), 0b0001);
        assert_eq!(run(Op::Shl, 0xFF, 8, Some(9)), 0);
        assert_eq!(run(Op::Asr, 0x80, 8, Some(3)), 0xF0);
        assert_eq!(run(Op::Asr, 0x40, 8, Some(3)), 0x08);
        assert_eq!(run(Op::Asr, 0x80, 8, Some(100)), 0xFF);
        assert_eq!(run(Op::Rol, 0b1001, 4, None), 0b0011);
        assert_eq!(run(Op::Ror, 0b1001, 4, None), 0b1100);
        assert_eq!(run(Op::Rol, 0b1001, 4, Some(4)), 0b1001);
    }

    #[test]
    fn whole_value_operations() {
        assert_eq!(run(Op::Invert, 0x0F, 8, None), 0xF0);
        assert_eq!(run(Op::Bswap, 0x1234, 16, None), 0x3412);
        assert!(apply_op(Op::Bswap, Bits::ZERO, 12, None).is_err());
        assert_eq!(run(Op::Brev, 0b0001, 4, None), 0b1000);
        assert_eq!(run(Op::Neg, 1, 8, None), 0xFF);
        assert_eq!(run(Op::Dec, 0, 8, None), 0xFF);
        assert_eq!(run(Op::Inc, 0xFF, 8, None), 0);
        assert_eq!(run(Op::Xor, 0xF0, 8, Some(0xFF)), 0x0F);
    }

    #[test]
    fn works_at_512_bits() {
        let top = Bits::from(1u8) << 511;
        assert_eq!(apply_op(Op::Rol, top, 512, None).unwrap(), Bits::from(1u8));
        assert_eq!(apply_op(Op::Neg, Bits::from(1u8), 512, None).unwrap(), Bits::MAX);
    }
}
