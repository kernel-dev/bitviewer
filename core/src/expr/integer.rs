//! Integer evaluation on BigInt: exact at any width, with limits so a request
//! like 2 ** 1e9 fails with a message instead of freezing the app.

use num_bigint::{BigInt, Sign};
use num_traits::{One, Signed, ToPrimitive, Zero};

use super::{Expr, ExprError};

/// Guards against 2 ** 1e9 style requests.
pub const MAX_BITS: u64 = 4096;

fn guard_bits(value: BigInt) -> Result<BigInt, ExprError> {
    if value.bits() > MAX_BITS { Err(ExprError::new(format!("The result is too large (over {MAX_BITS} bits)"))) } else { Ok(value) }
}

/// A shift amount or bit number: a whole number from 0 to MAX_BITS.
pub fn small_int(value: &BigInt, description: &str) -> Result<usize, ExprError> {
    match value.to_u64() {
        Some(small) if small <= MAX_BITS => Ok(small as usize),
        _ => Err(ExprError::new(format!("{description} must be between 0 and {MAX_BITS}"))),
    }
}

pub fn eval_int(expression: &Expr, lookup: &dyn Fn(&str) -> Option<BigInt>) -> Result<BigInt, ExprError> {
    let evaluate = |expression: &Expr| eval_int(expression, lookup);
    match expression {
        Expr::Num { integer, text, .. } => integer.clone().ok_or_else(|| ExprError::new(format!("{text} is not a whole number"))),

        Expr::Name(name) => lookup(name).ok_or_else(|| ExprError::new(format!("Unknown name \"{name}\""))),

        Expr::Unary(operator, operand) => {
            let operand = evaluate(operand)?;
            Ok(match operator {
                '-' => -operand,
                '+' => operand,
                '~' => !operand,
                _ => BigInt::from(u8::from(operand.is_zero())), // !
            })
        }

        Expr::Binary(operator, left, right) => {
            let left = evaluate(left)?;
            let right = evaluate(right)?;
            match *operator {
                "+" => guard_bits(left + right),
                "-" => guard_bits(left - right),
                "*" => guard_bits(left * right),
                "/" | "%" if right.is_zero() => Err(ExprError::new("Division by zero")),
                // truncating, like JavaScript's BigInt
                "/" => Ok(left / right),
                "%" => Ok(left % right),
                "**" => {
                    if right.sign() == Sign::Minus {
                        return Err(ExprError::new("Negative exponents don't give whole numbers"));
                    }
                    let magnitude = left.abs();
                    let exponent = right.to_u64().unwrap_or(u64::MAX);
                    if magnitude > BigInt::one() && exponent.saturating_mul(magnitude.bits()) > MAX_BITS {
                        return Err(ExprError::new(format!("The result is too large (over {MAX_BITS} bits)")));
                    }
                    if magnitude <= BigInt::one() {
                        // 0, 1 and -1 to any power, without looping on a huge exponent
                        return Ok(if exponent == 0 {
                            BigInt::one()
                        } else if left.sign() == Sign::Minus && exponent % 2 == 1 {
                            -BigInt::one()
                        } else {
                            magnitude
                        });
                    }
                    Ok(num_traits::pow(left, exponent as usize))
                }
                "<<" => guard_bits(left << small_int(&right, "Shift amount")?),
                // flooring for negative numbers, like JavaScript's BigInt
                ">>" => Ok(left >> small_int(&right, "Shift amount")?),
                "&" => Ok(left & right),
                "|" => Ok(left | right),
                "^" => Ok(left ^ right),
                other => Err(ExprError::new(format!("Unknown operator {other}"))),
            }
        }

        Expr::Call(function, arguments) => {
            let values: Vec<BigInt> = arguments.iter().map(evaluate).collect::<Result<_, _>>()?;
            let count = |expected: usize| -> Result<(), ExprError> {
                if values.len() == expected {
                    Ok(())
                } else {
                    Err(ExprError::new(format!("{function}() takes {expected} argument{}", if expected > 1 { "s" } else { "" })))
                }
            };
            match function.as_str() {
                "min" | "max" => {
                    let best = if function == "min" { values.iter().min() } else { values.iter().max() };
                    best.cloned().ok_or_else(|| ExprError::new(format!("{function}() needs at least one argument")))
                }
                "abs" => {
                    count(1)?;
                    Ok(values[0].abs())
                }
                "bit" => {
                    count(1)?;
                    Ok(BigInt::one() << small_int(&values[0], "Bit number")?)
                }
                "mask" => {
                    count(1)?;
                    Ok((BigInt::one() << small_int(&values[0], "Mask width")?) - 1)
                }
                "popcount" => {
                    count(1)?;
                    if values[0].sign() == Sign::Minus {
                        return Err(ExprError::new("popcount() needs a non-negative number"));
                    }
                    let (_, digits) = values[0].to_u64_digits();
                    Ok(BigInt::from(digits.iter().map(|d| d.count_ones()).sum::<u32>()))
                }
                _ => Err(ExprError::new(format!("Unknown function {function}() — try min, max, abs, bit, mask, popcount"))),
            }
        }
    }
}
