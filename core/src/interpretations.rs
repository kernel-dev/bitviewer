//! Extra interpretations of a value: IEEE-754 floats (half, bfloat16,
//! single, double), byte sequences in either byte order, and assorted
//! readouts (BCD, Gray code, one's complement, bit counts, text).

use crate::integers::{Base, Bits, ParseError, format_int, mask};

// ------------------------------------------------------------------ numbers as JavaScript prints them
/// `value` as JavaScript's String(number) writes it: the shortest digits that
/// read back the same, in fixed notation from 1e-6 up to 1e21, else as 1.5e+21.
pub fn js_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if value == 0.0 {
        return "0".into();
    }
    // Rust's {:e} gives the shortest round-trip digits: "1.2345e3"
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap();
    let exponent: i32 = exponent.parse().unwrap();
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let sign = if value < 0.0 { "-" } else { "" };
    let count = digits.len() as i32;

    let body = if (-6..21).contains(&exponent) {
        if exponent >= count - 1 {
            // a whole number: pad with zeros
            format!("{digits}{}", "0".repeat((exponent - count + 1) as usize))
        } else if exponent >= 0 {
            let point = (exponent + 1) as usize;
            format!("{}.{}", &digits[..point], &digits[point..])
        } else {
            format!("0.{}{digits}", "0".repeat((-exponent - 1) as usize))
        }
    } else {
        let mantissa = if count > 1 { format!("{}.{}", &digits[..1], &digits[1..]) } else { digits.clone() };
        format!("{mantissa}e{}{exponent}", if exponent >= 0 { "+" } else { "" })
    };
    format!("{sign}{body}")
}

/// JavaScript's value.toPrecision(digits), read back as a number.
fn to_precision(value: f64, digits: usize) -> f64 {
    format!("{:.*e}", digits - 1, value).parse().unwrap_or(value)
}

// ------------------------------------------------------------------ floats
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FloatKind {
    F16,
    BF16,
    F32,
    F64,
}

impl FloatKind {
    pub fn name(self) -> &'static str {
        match self {
            FloatKind::F16 => "float16",
            FloatKind::BF16 => "bfloat16",
            FloatKind::F32 => "float32",
            FloatKind::F64 => "float64",
        }
    }
}

/// Float views that make sense for a value of this width.
pub fn float_kinds(width: usize) -> &'static [FloatKind] {
    match width {
        16 => &[FloatKind::F16, FloatKind::BF16],
        32 => &[FloatKind::F32],
        64 => &[FloatKind::F64],
        _ => &[],
    }
}

/// Round half to even, for x ≥ 0.
fn round_even(value: f64) -> f64 {
    let rounded = value.round();
    if (value % 1.0).abs() == 0.5 && rounded % 2.0 != 0.0 { rounded - 1.0 } else { rounded }
}

/// floor(log2(a)) for a > 0, exact even where log2 rounds.
fn exponent_of(absolute: f64) -> i32 {
    let mut exponent = absolute.log2().floor() as i32;
    if 2f64.powi(exponent) > absolute {
        exponent -= 1;
    }
    if 2f64.powi(exponent + 1) <= absolute {
        exponent += 1;
    }
    exponent
}

fn half_to_number(bits: u16) -> f64 {
    let sign = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exponent = i32::from((bits >> 10) & 0x1f);
    let fraction = f64::from(bits & 0x3ff);
    match exponent {
        0 => sign * fraction * 2f64.powi(-24),
        31 if fraction != 0.0 => f64::NAN,
        31 => sign * f64::INFINITY,
        _ => sign * (1.0 + fraction / 1024.0) * 2f64.powi(exponent - 15),
    }
}

fn number_to_half(value: f64) -> u16 {
    if value.is_nan() {
        return 0x7e00;
    }
    let sign: u16 = if value.is_sign_negative() { 0x8000 } else { 0 };
    let absolute = value.abs();
    if absolute >= 65520.0 {
        return sign | 0x7c00; // past the largest half (65504) after rounding
    }
    if absolute == 0.0 {
        return sign;
    }
    let mut exponent = exponent_of(absolute);
    // subnormal: count units of 2^-24 (a result of 1024 is exactly the smallest normal)
    if exponent < -14 {
        return sign | round_even(absolute / 2f64.powi(-24)) as u16;
    }
    let mut mantissa = round_even((absolute / 2f64.powi(exponent) - 1.0) * 1024.0) as u16;
    if mantissa == 1024 {
        mantissa = 0;
        exponent += 1;
    }
    if exponent > 15 {
        return sign | 0x7c00;
    }
    sign | (((exponent + 15) as u16) << 10) | mantissa
}

/// The number stored in the low bits of `value` as this float kind.
pub fn decode_float(value: Bits, kind: FloatKind) -> f64 {
    let low = value.as_limbs()[0];
    match kind {
        FloatKind::F64 => f64::from_bits(low),
        FloatKind::F32 => f64::from(f32::from_bits(low as u32)),
        FloatKind::BF16 => f64::from(f32::from_bits(((low & 0xffff) as u32) << 16)),
        FloatKind::F16 => half_to_number((low & 0xffff) as u16),
    }
}

/// Bits of `value` as this float kind (rounded to nearest, ties to even).
pub fn encode_float(value: f64, kind: FloatKind) -> Bits {
    match kind {
        FloatKind::F64 => Bits::from(value.to_bits()),
        FloatKind::F32 => Bits::from((value as f32).to_bits()),
        FloatKind::BF16 => {
            if value.is_nan() {
                return Bits::from(0x7fc0u16);
            }
            let bits = (value as f32).to_bits();
            let rounded = (bits.wrapping_add(0x7fff + ((bits >> 16) & 1)) >> 16) & 0xffff;
            Bits::from(rounded)
        }
        FloatKind::F16 => Bits::from(number_to_half(value)),
    }
}

/// Shortest text that reads back as the same float of this kind.
pub fn format_float_kind(value: f64, kind: FloatKind) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "+Inf" } else { "-Inf" }.into();
    }
    if value == 0.0 && value.is_sign_negative() {
        return "-0.0".into();
    }
    let mut formatted = js_number(value);
    if kind != FloatKind::F64 {
        let bits = encode_float(value, kind);
        for digits in 1..=9 {
            let candidate = to_precision(value, digits);
            if encode_float(candidate, kind) == bits {
                formatted = js_number(candidate);
                break;
            }
        }
    }
    if !formatted.contains(['.', 'e', 'E', 'n']) {
        formatted.push_str(".0");
    }
    formatted
}

/// "−1.5 × 2^3" style breakdown of a float.
pub fn float_breakdown(value: f64) -> String {
    if value.is_nan() {
        return "not a number".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "positive infinity" } else { "negative infinity" }.into();
    }
    if value == 0.0 {
        return if value.is_sign_negative() { "negative zero" } else { "zero" }.into();
    }
    let absolute = value.abs();
    let exponent = exponent_of(absolute);
    let mantissa = to_precision(absolute / 2f64.powi(exponent), 12);
    format!("{}{} × 2^{exponent}", if value < 0.0 { "−" } else { "+" }, js_number(mantissa))
}

/// Parses "1.5", "-0.1", "1e-3", "inf", "-inf" or "nan".
pub fn parse_float_text(text: &str) -> Result<f64, ParseError> {
    let cleaned = text.trim().to_lowercase().replace('_', "");
    if cleaned.is_empty() {
        return Err(ParseError { message: "Enter a number".into(), incomplete: true });
    }
    let unsigned = cleaned.trim_start_matches(['+', '-']);
    if unsigned == "inf" || unsigned == "infinity" {
        return Ok(if cleaned.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY });
    }
    if cleaned == "nan" {
        return Ok(f64::NAN);
    }
    let valid = {
        let body = cleaned.strip_prefix(['+', '-']).unwrap_or(&cleaned);
        let (number, exponent) = match body.split_once('e') {
            Some((number, exponent)) => (number, Some(exponent)),
            None => (body, None),
        };
        let exponent_ok = exponent.is_none_or(|e| {
            let digits = e.strip_prefix(['+', '-']).unwrap_or(e);
            !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
        });
        let (whole, fraction) = number.split_once('.').unwrap_or((number, ""));
        let digits_ok = whole.bytes().all(|b| b.is_ascii_digit())
            && fraction.bytes().all(|b| b.is_ascii_digit())
            && (!whole.is_empty() || (!fraction.is_empty() && number.starts_with('.')));
        exponent_ok && digits_ok && !number.is_empty()
    };
    if !valid {
        return Err(ParseError { message: format!("\"{}\" is not a number", text.trim()), incomplete: false });
    }
    cleaned.parse().map_err(|_| ParseError { message: format!("\"{}\" is not a number", text.trim()), incomplete: false })
}

// ------------------------------------------------------------------ bytes
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ByteOrder {
    Big,
    Little,
}

/// The value as ceil(width / 8) bytes; Big puts the most significant first.
pub fn value_to_bytes(value: Bits, width: usize, order: ByteOrder) -> Vec<u8> {
    let count = width.div_ceil(8);
    let mut out: Vec<u8> = (0..count).rev().map(|index| (value >> (index * 8)).as_limbs()[0] as u8).collect();
    if order == ByteOrder::Little {
        out.reverse();
    }
    out
}

/// The body of a Python bytes literal (between the quotes) as bytes.
fn parse_python_bytes(body: &str) -> Result<Vec<u8>, ParseError> {
    let error = |message: String| ParseError { message, incomplete: false };
    let chars: Vec<char> = body.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let character = chars[i];
        if character != '\\' {
            if !character.is_ascii() {
                return Err(error(format!("\"{character}\" isn't ASCII; write it as \\x escapes")));
            }
            out.push(character as u8);
            i += 1;
            continue;
        }
        let escaped = chars.get(i + 1).copied().unwrap_or('\0');
        match escaped {
            'x' => {
                let hex: String = chars.get(i + 2..i + 4).map(|s| s.iter().collect()).unwrap_or_default();
                let byte = u8::from_str_radix(&hex, 16).ok().filter(|_| hex.len() == 2).ok_or_else(|| error("Bad \\x escape in the bytes literal".into()))?;
                out.push(byte);
                i += 4;
            }
            '0'..='7' => {
                let octal: String = chars[i + 1..].iter().take(3).take_while(|c| ('0'..='7').contains(c)).collect();
                let byte = u16::from_str_radix(&octal, 8).unwrap();
                if byte > 0xff {
                    return Err(error(format!("\\{octal} is more than a byte")));
                }
                out.push(byte as u8);
                i += 1 + octal.len();
            }
            _ => {
                let byte = match escaped {
                    '\\' => Some(0x5c),
                    '\'' => Some(0x27),
                    '"' => Some(0x22),
                    'a' => Some(0x07),
                    'b' => Some(0x08),
                    'f' => Some(0x0c),
                    'n' => Some(0x0a),
                    'r' => Some(0x0d),
                    't' => Some(0x09),
                    'v' => Some(0x0b),
                    _ => None,
                };
                match byte {
                    Some(byte) => {
                        out.push(byte);
                        i += 2;
                    }
                    None => {
                        // Python keeps unknown escapes as a backslash and the character
                        out.push(0x5c);
                        i += 1;
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Accepts "DE AD BE EF", "0xde, 0xad", "{0xDE, 0xAD}", "deadbeef",
/// "bytes([…])" and b'\xde\xad'.
pub fn parse_bytes(text: &str) -> Result<Vec<u8>, ParseError> {
    let cleaned = text.trim();
    if cleaned.is_empty() {
        return Err(ParseError { message: "Paste some bytes".into(), incomplete: true });
    }
    for quote in ['\'', '"'] {
        if let Some(body) = cleaned.strip_prefix('b').and_then(|rest| rest.strip_prefix(quote)?.strip_suffix(quote)) {
            return parse_python_bytes(body);
        }
    }
    let lower = cleaned.to_lowercase();
    let mut rest = cleaned;
    for prefix in ["bytes(", "bytearray("] {
        if lower.starts_with(prefix) {
            rest = &cleaned[prefix.len()..];
        }
    }
    let spaced: String = rest.chars().map(|c| if "{}[]();".contains(c) { ' ' } else { c }).collect();
    let mut tokens: Vec<String> = spaced.split(|c: char| c.is_whitespace() || c == ',').filter(|token| !token.is_empty()).map(str::to_string).collect();
    // one long run of hex digits: split it into pairs
    if tokens.len() == 1 {
        let one = tokens[0].trim_start_matches("0x").trim_start_matches("0X").to_string();
        if one.len() > 2 && one.chars().all(|c| c.is_ascii_hexdigit()) {
            let padded = if one.len() % 2 == 1 { format!("0{one}") } else { one };
            tokens = padded.as_bytes().chunks(2).map(|pair| String::from_utf8_lossy(pair).into_owned()).collect();
        }
    }
    tokens
        .iter()
        .map(|token| {
            let hex = token.strip_prefix("0x").or_else(|| token.strip_prefix("0X")).unwrap_or(token);
            if (1..=2).contains(&hex.len()) && hex.chars().all(|c| c.is_ascii_hexdigit()) {
                Ok(u8::from_str_radix(hex, 16).unwrap())
            } else {
                Err(ParseError { message: format!("\"{token}\" is not a byte (use 00–FF)"), incomplete: false })
            }
        })
        .collect()
}

/// Builds a `width`-bit value from bytes; fewer bytes than fit are zero-extended.
pub fn bytes_to_value(bytes: &[u8], width: usize, order: ByteOrder) -> Result<Bits, ParseError> {
    let count = width.div_ceil(8);
    if bytes.len() > count {
        return Err(ParseError { message: format!("{} bytes don't fit in {width} bits (max {count})", bytes.len()), incomplete: false });
    }
    let mut value = Bits::ZERO;
    let mut push = |byte: u8| value = (value << 8) | Bits::from(byte);
    match order {
        ByteOrder::Big => bytes.iter().for_each(|b| push(*b)),
        ByteOrder::Little => bytes.iter().rev().for_each(|b| push(*b)),
    }
    if value > mask(width) {
        return Err(ParseError { message: format!("The bytes don't fit in {width} bits"), incomplete: false });
    }
    Ok(value)
}

/// How bytes are written out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ByteStyle {
    /// { 0xDE, 0xAD }
    C,
    /// b'\xde\xad'
    Python,
    /// DE AD
    Hex,
}

pub fn format_bytes(bytes: &[u8], style: ByteStyle) -> String {
    match style {
        ByteStyle::Hex => bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" "),
        ByteStyle::C => format!("{{ {} }}", bytes.iter().map(|b| format!("0x{b:02X}")).collect::<Vec<_>>().join(", ")),
        ByteStyle::Python => format!("b'{}'", bytes.iter().map(|b| format!("\\x{b:02x}")).collect::<String>()),
    }
}

// ------------------------------------------------------------------ extra readouts
pub fn bit_length(value: Bits) -> usize {
    value.bit_len()
}

/// Leading zeros within `width` bits.
pub fn count_leading_zeros(value: Bits, width: usize) -> usize {
    width - bit_length(value)
}

/// Trailing zeros (`width` when the value is 0).
pub fn count_trailing_zeros(value: Bits, width: usize) -> usize {
    if value == Bits::ZERO { width } else { value.trailing_zeros() }
}

/// Decimal digits if every nibble is 0–9 (binary-coded decimal), else None.
pub fn bcd_decode(value: Bits, width: usize) -> Option<String> {
    let digits = format_int(value, Base::Hex, width, false, false);
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let trimmed = digits.trim_start_matches('0');
    Some(if trimmed.is_empty() && !digits.is_empty() { "0".into() } else { trimmed.into() })
}

/// Binary value of a Gray-coded number.
pub fn gray_to_binary(gray: Bits) -> Bits {
    let mut binary = gray;
    let mut shifted = gray >> 1;
    while shifted != Bits::ZERO {
        binary ^= shifted;
        shifted >>= 1;
    }
    binary
}

/// One's-complement signed interpretation, in decimal.
pub fn ones_complement(value: Bits, width: usize) -> String {
    if value.bit(width - 1) { format!("-{}", !value & mask(width)) } else { value.to_string() }
}

/// The bytes (most significant first, leading zero bytes dropped) as text:
/// UTF-8 when valid and printable, else ASCII with · for other bytes.
pub fn bytes_as_text(value: Bits, width: usize) -> String {
    let bytes = value_to_bytes(value, width, ByteOrder::Big);
    let used = match bytes.iter().position(|byte| *byte != 0) {
        Some(first) => &bytes[first..],
        None => &[][..],
    };
    if let Ok(text) = std::str::from_utf8(used)
        && !text.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
    {
        return text.into();
    }
    used.iter().map(|byte| if (0x20..0x7f).contains(byte) { *byte as char } else { '·' }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prints_numbers_like_javascript() {
        assert_eq!(js_number(1.0), "1");
        assert_eq!(js_number(0.1), "0.1");
        assert_eq!(js_number(-2.5), "-2.5");
        assert_eq!(js_number(1e21), "1e+21");
        assert_eq!(js_number(1.5e-7), "1.5e-7");
        assert_eq!(js_number(0.000001), "0.000001");
        assert_eq!(js_number(123456789.0), "123456789");
        assert_eq!(js_number(3.4028234663852886e38), "3.4028234663852886e+38");
    }

    #[test]
    fn decodes_and_formats_floats() {
        let f32_bits = |bits: u32| decode_float(Bits::from(bits), FloatKind::F32);
        assert_eq!(format_float_kind(f32_bits(0x3F800000), FloatKind::F32), "1.0");
        assert_eq!(format_float_kind(f32_bits(0x3DCCCCCD), FloatKind::F32), "0.1");
        assert_eq!(format_float_kind(f32_bits(0x7F800000), FloatKind::F32), "+Inf");
        assert_eq!(format_float_kind(f32_bits(0x80000000), FloatKind::F32), "-0.0");
        assert_eq!(decode_float(Bits::from(0x3C00u16), FloatKind::F16), 1.0);
        assert_eq!(decode_float(Bits::from(0x0001u16), FloatKind::F16), 2f64.powi(-24));
        assert_eq!(decode_float(Bits::from(0x3F80u16), FloatKind::BF16), 1.0);
        assert_eq!(float_breakdown(-12.0), "−1.5 × 2^3");
    }

    #[test]
    fn encodes_floats_with_round_to_even() {
        assert_eq!(encode_float(1.0, FloatKind::F16), Bits::from(0x3C00u16));
        assert_eq!(encode_float(65504.0, FloatKind::F16), Bits::from(0x7BFFu16));
        assert_eq!(encode_float(70000.0, FloatKind::F16), Bits::from(0x7C00u16));
        assert_eq!(encode_float(-0.0, FloatKind::F16), Bits::from(0x8000u16));
        assert_eq!(encode_float(1.0, FloatKind::BF16), Bits::from(0x3F80u16));
        assert_eq!(encode_float(0.1, FloatKind::F32), Bits::from(0x3DCCCCCDu32));
        assert_eq!(parse_float_text(" -1e3 ").unwrap(), -1000.0);
        assert_eq!(parse_float_text(".5").unwrap(), 0.5);
        assert!(parse_float_text("-inf").unwrap().is_infinite());
        assert!(parse_float_text("1.2.3").is_err());
        assert!(parse_float_text("").unwrap_err().incomplete);
    }

    #[test]
    fn parses_many_byte_notations() {
        let de_ad = vec![0xDE, 0xAD];
        assert_eq!(parse_bytes("DE AD").unwrap(), de_ad);
        assert_eq!(parse_bytes("0xde, 0xad").unwrap(), de_ad);
        assert_eq!(parse_bytes("{0xDE, 0xAD};").unwrap(), de_ad);
        assert_eq!(parse_bytes("dead").unwrap(), de_ad);
        assert_eq!(parse_bytes("bytes([0xde, 0xad])").unwrap(), de_ad);
        assert_eq!(parse_bytes(r"b'\xde\xad'").unwrap(), de_ad);
        assert_eq!(parse_bytes(r"b'A\n\101'").unwrap(), vec![0x41, 0x0a, 0x41]);
        assert_eq!(parse_bytes("abc").unwrap(), vec![0x0a, 0xbc]);
        assert!(parse_bytes("1FF").is_ok());
        assert!(parse_bytes("GG").is_err());
        assert!(parse_bytes("").unwrap_err().incomplete);
    }

    #[test]
    fn converts_bytes_in_both_orders() {
        assert_eq!(bytes_to_value(&[0x12, 0x34], 16, ByteOrder::Big), Ok(Bits::from(0x1234u16)));
        assert_eq!(bytes_to_value(&[0x12, 0x34], 16, ByteOrder::Little), Ok(Bits::from(0x3412u16)));
        assert_eq!(bytes_to_value(&[0x01], 16, ByteOrder::Big), Ok(Bits::from(1u8)));
        assert!(bytes_to_value(&[1, 2, 3], 16, ByteOrder::Big).is_err());
        assert!(bytes_to_value(&[0xFF], 4, ByteOrder::Big).is_err());
        assert_eq!(format_bytes(&[0xDE, 0xAD], ByteStyle::C), "{ 0xDE, 0xAD }");
        assert_eq!(format_bytes(&[0xDE, 0xAD], ByteStyle::Python), r"b'\xde\xad'");
        assert_eq!(format_bytes(&[0xDE, 0xAD], ByteStyle::Hex), "DE AD");
    }

    #[test]
    fn readouts() {
        assert_eq!(count_leading_zeros(Bits::from(1u8), 8), 7);
        assert_eq!(count_trailing_zeros(Bits::ZERO, 8), 8);
        assert_eq!(count_trailing_zeros(Bits::from(8u8), 8), 3);
        assert_eq!(bcd_decode(Bits::from(0x0042u16), 16).as_deref(), Some("42"));
        assert_eq!(bcd_decode(Bits::from(0x0000u16), 16).as_deref(), Some("0"));
        assert_eq!(bcd_decode(Bits::from(0x4Au8), 8), None);
        assert_eq!(gray_to_binary(Bits::from(0b110u8)), Bits::from(0b100u8));
        assert_eq!(ones_complement(Bits::from(0xFEu8), 8), "-1");
        assert_eq!(bytes_as_text(Bits::from(0x4869u16), 32), "Hi");
        assert_eq!(bytes_as_text(Bits::from(0x48_01u16), 16), "H·");
        assert_eq!(value_to_bytes(Bits::from(0x1234u16), 16, ByteOrder::Little), vec![0x34, 0x12]);
    }
}
