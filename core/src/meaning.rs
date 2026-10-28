//! What a field's bits mean: signed values, unit formulas (e.g.
//! "x * 0.5 - 40 °C"), and turning a typed real-world value back into raw
//! bits.

use num_bigint::BigInt;
use num_traits::ToPrimitive;

use crate::expr::{ExprError, eval_real, linearity, parse_expr};
use crate::field::{Field, big_to_bits};
use crate::integers::{Bits, mask};
use crate::interpretations::js_number;

/// A compiled formula in `x`.
pub struct Formula {
    expression: crate::expr::Expr,
    /// (scale, offset) when the formula is linear, so values can be typed back in.
    pub linear: Option<(f64, f64)>,
}

impl Formula {
    pub fn evaluate(&self, x: f64) -> Result<f64, ExprError> {
        eval_real(&self.expression, &|name: &str| (name == "x").then_some(x))
    }
}

/// Compiles a formula in `x`; unknown names fail now rather than on every redraw.
pub fn compile_formula(source: &str) -> Result<Formula, ExprError> {
    let expression = parse_expr(source)?;
    let mut formula = Formula { expression, linear: None };
    formula.evaluate(1.0)?;
    let evaluate = |x: f64| formula.evaluate(x).unwrap_or(f64::NAN);
    let linear = linearity(&evaluate, &[2.0, 7.0, 1000.0, -3.0]);
    formula.linear = linear;
    Ok(formula)
}

/// Short, readable number: integers as they are, others to 6 significant digits.
pub fn format_real(value: f64) -> String {
    if !value.is_finite() {
        return if value.is_nan() {
            "NaN".into()
        } else if value > 0.0 {
            "∞".into()
        } else {
            "−∞".into()
        };
    }
    if value.fract() == 0.0 && value.abs() < 1e15 {
        return js_number(value);
    }
    let six: f64 = format!("{value:.5e}").parse().unwrap_or(value);
    js_number(six)
}

/// The field's number: `raw` read as signed when the field is signed.
pub fn field_number(field: &Field, raw: Bits) -> BigInt {
    let width = field.width();
    let raw_big = BigInt::from_bytes_le(num_bigint::Sign::Plus, &raw.to_le_bytes::<64>());
    if field.details.signed && width >= 2 && raw.bit(width - 1) { raw_big - (BigInt::from(1u8) << width) } else { raw_big }
}

/// What a field's raw bits mean, for display next to the raw value: "-12",
/// "23.5 °C", or "" when there's nothing beyond the raw value.
pub fn decode_field(field: &Field, raw: Bits) -> Result<String, ExprError> {
    let number = field_number(field, raw);
    let unit = &field.details.unit;
    if field.details.formula.is_empty() {
        let text = if field.details.signed { number.to_string() } else { String::new() };
        return Ok(match (text.is_empty(), unit.is_empty()) {
            (false, false) => format!("{text} {unit}"),
            (false, true) => text,
            (true, false) => format!("{number} {unit}"),
            (true, true) => String::new(),
        });
    }
    let decoded = compile_formula(&field.details.formula)?.evaluate(number.to_f64().unwrap_or(f64::NAN))?;
    let mut text = format_real(decoded);
    if !unit.is_empty() {
        text = format!("{text} {unit}");
    }
    Ok(text)
}

/// Can a real-world value be typed in for this field?
pub fn is_invertible(field: &Field) -> bool {
    field.details.formula.is_empty() || compile_formula(&field.details.formula).is_ok_and(|formula| formula.linear.is_some())
}

/// Raw bits for a typed real-world value.
pub fn raw_from_number(field: &Field, value: f64) -> Result<Bits, ExprError> {
    let mut raw = value;
    if !field.details.formula.is_empty() {
        let (scale, offset) =
            compile_formula(&field.details.formula)?.linear.ok_or_else(|| ExprError::new("This formula can't be reversed, so type the raw value instead"))?;
        raw = (value - offset) / scale;
    }
    if !raw.is_finite() {
        return Err(ExprError::new("That value can't be represented"));
    }
    // JavaScript's Math.round: halves go up
    let rounded = BigInt::from((raw + 0.5).floor() as i128);
    let width = field.width();
    let signed = field.details.signed && width > 1;
    let (lo, hi) = if signed {
        (-(BigInt::from(1u8) << (width - 1)), (BigInt::from(1u8) << (width - 1)) - 1)
    } else {
        (BigInt::from(0u8), (BigInt::from(1u8) << width) - 1)
    };
    if rounded < lo || rounded > hi {
        return Err(ExprError::new(format!("Out of range for {width} {}bits", if field.details.signed { "signed " } else { "" })));
    }
    let wrapped = if rounded < BigInt::from(0u8) { rounded + (BigInt::from(1u8) << width) } else { rounded };
    Ok(big_to_bits(&wrapped).unwrap_or(Bits::ZERO) & mask(width))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::DetailsDraft;
    use crate::integers::Base;
    use crate::rows::View;
    use crate::value::Value;

    /// A 32-bit register with a temperature field (x * 0.5 - 40 °C) and a
    /// signed offset, as in the web app's tests.
    fn register() -> Value {
        let mut value = Value::new(32, Bits::ZERO, "R", View::Byte, Base::Hex).unwrap();
        let temperature = value.add_field(0, 7, Some("TEMP"), None, None).unwrap();
        value.set_field_details(temperature, DetailsDraft { formula: Some("x * 0.5 - 40".into()), unit: Some("°C".into()), ..Default::default() });
        let offset = value.add_field(8, 11, Some("OFFSET"), None, None).unwrap();
        value.set_field_details(offset, DetailsDraft { signed: Some(true), ..Default::default() });
        value
    }

    fn field<'a>(value: &'a Value, name: &str) -> &'a Field {
        value.fields.iter().find(|field| &*field.name == name).unwrap()
    }

    #[test]
    fn decodes_signed_values_and_formulas() {
        let value = register();
        let (temperature, offset) = (field(&value, "TEMP"), field(&value, "OFFSET"));
        assert_eq!(decode_field(temperature, Bits::from(0x7au8)).unwrap(), "21 °C");
        assert_eq!(decode_field(temperature, Bits::from(0x7bu8)).unwrap(), "21.5 °C");
        assert_eq!(decode_field(offset, Bits::from(0xeu8)).unwrap(), "-2");
        assert_eq!(decode_field(offset, Bits::from(0x7u8)).unwrap(), "7");
        assert_eq!(format_real(1.0 / 3.0), "0.333333");
    }

    #[test]
    fn turns_typed_values_back_into_raw_bits() {
        let mut value = register();
        assert!(is_invertible(field(&value, "TEMP")));
        assert_eq!(raw_from_number(field(&value, "TEMP"), 21.5), Ok(Bits::from(0x7bu8)));
        assert!(raw_from_number(field(&value, "TEMP"), 1000.0).unwrap_err().0.contains("Out of range"));
        assert_eq!(raw_from_number(field(&value, "OFFSET"), -2.0), Ok(Bits::from(0xeu8)));
        assert!(raw_from_number(field(&value, "OFFSET"), 8.0).unwrap_err().0.contains("Out of range"));

        let sequence = value.add_field(24, 31, Some("SQ"), None, None).unwrap();
        value.set_field_details(sequence, DetailsDraft { formula: Some("x * x".into()), ..Default::default() });
        assert!(!is_invertible(field(&value, "SQ")));
        assert!(raw_from_number(field(&value, "SQ"), 4.0).unwrap_err().0.contains("can't be reversed"));
    }
}
