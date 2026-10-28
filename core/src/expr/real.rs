//! Real-number evaluation, used for field unit formulas such as
//! `x * 0.5 - 40`, and the linearity check that decides whether a formula can
//! be turned around to type in a real-world value. Functions behave like
//! JavaScript's Math functions, so formulas give the same results as in the
//! web app.

use num_bigint::BigInt;
use num_traits::ToPrimitive;

use super::integer::small_int;
use super::{Expr, ExprError};

const FUNCTIONS: &str = "abs, min, max, round, floor, ceil, sqrt, pow, log, log2, log10, exp";

/// JavaScript's Math.round: halves go up (toward +∞), -0 stays -0.
fn js_round(value: f64) -> f64 {
    if value.is_nan() || value.is_infinite() {
        return value;
    }
    let rounded = (value + 0.5).floor();
    if rounded == 0.0 && value < 0.0 { -0.0 } else { rounded }
}

fn as_integer(value: f64, operator: &str) -> Result<BigInt, ExprError> {
    if value.fract() != 0.0 || !value.is_finite() {
        return Err(ExprError::new(format!("\"{operator}\" needs whole numbers")));
    }
    Ok(BigInt::from(value as i128))
}

fn to_f64(value: BigInt) -> f64 {
    value.to_f64().unwrap_or(f64::NAN)
}

pub fn eval_real(expression: &Expr, lookup: &dyn Fn(&str) -> Option<f64>) -> Result<f64, ExprError> {
    let evaluate = |expression: &Expr| eval_real(expression, lookup);
    match expression {
        Expr::Num { real, .. } => Ok(*real),

        Expr::Name(name) => lookup(name)
            .or(match name.to_lowercase().as_str() {
                "pi" => Some(std::f64::consts::PI),
                "e" => Some(std::f64::consts::E),
                _ => None,
            })
            .ok_or_else(|| ExprError::new(format!("Unknown name \"{name}\""))),

        Expr::Unary(operator, operand) => {
            let operand = evaluate(operand)?;
            Ok(match operator {
                '-' => -operand,
                '+' => operand,
                '!' => f64::from(u8::from(operand == 0.0)),
                _ => to_f64(!as_integer(operand, "~")?),
            })
        }

        Expr::Binary(operator, left, right) => {
            let left = evaluate(left)?;
            let right = evaluate(right)?;
            let shift = |value: f64| -> Result<usize, ExprError> { small_int(&as_integer(value, "shift")?, "Shift amount") };
            Ok(match *operator {
                "+" => left + right,
                "-" => left - right,
                "*" => left * right,
                "/" => left / right,
                "%" => left % right,
                "**" => left.powf(right),
                "<<" => to_f64(as_integer(left, "<<")? << shift(right)?),
                ">>" => to_f64(as_integer(left, ">>")? >> shift(right)?),
                "&" => to_f64(as_integer(left, "&")? & as_integer(right, "&")?),
                "|" => to_f64(as_integer(left, "|")? | as_integer(right, "|")?),
                "^" => to_f64(as_integer(left, "^")? ^ as_integer(right, "^")?),
                other => return Err(ExprError::new(format!("Unknown operator {other}"))),
            })
        }

        Expr::Call(function, arguments) => {
            let values: Vec<f64> = arguments.iter().map(evaluate).collect::<Result<_, _>>()?;
            // missing arguments read as NaN, extra ones are ignored (as in JavaScript)
            let arg = |index: usize| values.get(index).copied().unwrap_or(f64::NAN);
            Ok(match function.as_str() {
                "abs" => arg(0).abs(),
                "min" => values.iter().copied().fold(f64::INFINITY, |a, b| if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }),
                "max" => values.iter().copied().fold(f64::NEG_INFINITY, |a, b| if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }),
                "round" => js_round(arg(0)),
                "floor" => arg(0).floor(),
                "ceil" => arg(0).ceil(),
                "sqrt" => arg(0).sqrt(),
                "pow" => arg(0).powf(arg(1)),
                "log" => arg(0).ln(),
                "log2" => arg(0).log2(),
                "log10" => arg(0).log10(),
                "exp" => arg(0).exp(),
                _ => {
                    return Err(ExprError::new(format!("Unknown function {function}() — try {FUNCTIONS}")));
                }
            })
        }
    }
}

/// If `f(x)` is linear (f(x) = a·x + b) over the sample points, returns (a, b).
pub fn linearity(evaluate: &dyn Fn(f64) -> f64, samples: &[f64]) -> Option<(f64, f64)> {
    let intercept = evaluate(0.0);
    let slope = evaluate(1.0) - intercept;
    if !slope.is_finite() || !intercept.is_finite() || slope == 0.0 {
        return None;
    }
    for &x in samples {
        let expected = slope * x + intercept;
        let actual = evaluate(x);
        // written so that NaN (from a formula that breaks at x) counts as "not close"
        let close = (actual - expected).abs() <= 1e-9 * expected.abs().max(1.0);
        if !close {
            return None;
        }
    }
    Some((slope, intercept))
}
