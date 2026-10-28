//! Parsing and formatting of integers in binary / octal / decimal /
//! hexadecimal. Values are fixed 512-bit integers (the widest a value can be).

use ruint::aliases::U512;
use serde::{Deserialize, Serialize};

/// Every value fits in this: 1 to 512 bits, unsigned.
pub type Bits = U512;

pub const MIN_WIDTH: usize = 1;
pub const MAX_WIDTH: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "u32", into = "u32")]
pub enum Base {
    Bin,
    Oct,
    Dec,
    Hex,
}

impl Base {
    pub const ORDER: [Base; 4] = [Base::Bin, Base::Oct, Base::Dec, Base::Hex];

    pub fn radix(self) -> u32 {
        match self {
            Base::Bin => 2,
            Base::Oct => 8,
            Base::Dec => 10,
            Base::Hex => 16,
        }
    }

    pub fn from_radix(radix: u64) -> Option<Base> {
        match radix {
            2 => Some(Base::Bin),
            8 => Some(Base::Oct),
            10 => Some(Base::Dec),
            16 => Some(Base::Hex),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Base::Bin => "BIN",
            Base::Oct => "OCT",
            Base::Dec => "DEC",
            Base::Hex => "HEX",
        }
    }

    pub fn prefix(self) -> &'static str {
        match self {
            Base::Bin => "0b",
            Base::Oct => "0o",
            Base::Dec => "",
            Base::Hex => "0x",
        }
    }
}

impl TryFrom<u32> for Base {
    type Error = String;
    fn try_from(radix: u32) -> Result<Self, String> {
        Base::from_radix(radix.into()).ok_or_else(|| format!("Unsupported base {radix}"))
    }
}

impl From<Base> for u32 {
    fn from(base: Base) -> u32 {
        base.radix()
    }
}

/// All ones in the low `width` bits.
pub fn mask(width: usize) -> Bits {
    if width >= MAX_WIDTH { Bits::MAX } else { (Bits::from(1u8) << width) - Bits::from(1u8) }
}

/// Bit `index` of `value`, as 0 or 1.
pub fn bit(value: Bits, index: usize) -> u8 {
    u8::from(value.bit(index))
}

/// Text that can't become a value. `incomplete` marks input the user is
/// probably still typing (empty, or just a prefix), so the UI can stay neutral.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
    pub incomplete: bool,
}

impl ParseError {
    fn new(message: impl Into<String>) -> Self {
        ParseError { message: message.into(), incomplete: false }
    }

    fn incomplete(message: impl Into<String>) -> Self {
        ParseError { message: message.into(), incomplete: true }
    }
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Parses `text` in `base` into an unsigned `width`-bit value.
/// - Spaces, underscores, apostrophes and tabs are ignored as separators.
/// - Prefixes 0x / 0b / 0o override the base. In HEX mode 0b is *not* a
///   prefix, because 0B is a valid hex number.
/// - With `allow_negative` a leading "-" stores the two's-complement value.
pub fn parse_value(text: &str, base: Base, width: usize, allow_negative: bool) -> Result<Bits, ParseError> {
    let mut cleaned: String = text.chars().filter(|c| !matches!(c, ' ' | '_' | '\'' | '\t')).collect();
    if cleaned.is_empty() {
        return Err(ParseError::incomplete("Enter a value"));
    }

    let mut negative = false;
    if cleaned.starts_with(['+', '-']) {
        negative = cleaned.starts_with('-');
        cleaned.remove(0);
        if cleaned.is_empty() {
            return Err(ParseError::incomplete("Enter a value"));
        }
    }

    let mut digits = cleaned.to_lowercase();
    let mut active = base;
    let prefixes: &[(&str, Base)] =
        if base == Base::Hex { &[("0x", Base::Hex), ("0o", Base::Oct)] } else { &[("0x", Base::Hex), ("0b", Base::Bin), ("0o", Base::Oct)] };

    for (prefix, prefix_base) in prefixes {
        if let Some(rest) = digits.strip_prefix(prefix) {
            active = *prefix_base;
            digits = rest.to_string();
            break;
        }
    }

    if digits.is_empty() {
        return Err(ParseError::incomplete(format!("Enter {} digits after the prefix", active.name())));
    }

    let radix = Bits::from(active.radix());
    let mut value = Bits::ZERO;
    let mut overflow = false;

    for character in digits.chars() {
        let digit = character.to_digit(active.radix()).ok_or_else(|| ParseError::new(format!("'{character}' is not a valid {} digit", active.name())))?;
        match value.checked_mul(radix).and_then(|v| v.checked_add(Bits::from(digit))) {
            Some(next) => value = next,
            None => overflow = true, // keep checking the digits, then report the range
        }
    }

    let limit = mask(width);

    if negative {
        if !allow_negative {
            return Err(ParseError::new("Negative values are not allowed here"));
        }
        let minimum = Bits::from(1u8) << (width - 1);
        if overflow || value > minimum {
            return Err(ParseError::new(format!("Below the signed {width}-bit minimum (-{minimum})")));
        }
        return Ok(value.wrapping_neg() & limit);
    }

    if overflow || value > limit {
        return Err(ParseError::new(format!("Exceeds the {width}-bit range (max {})", format_int(limit, active, width, true, false))));
    }

    Ok(value)
}

/// Groups `text` in fours from the right with "_": 1_0000_0000.
fn group(text: &str) -> String {
    let head = text.len() % 4;
    let mut parts: Vec<&str> = Vec::new();
    if head > 0 {
        parts.push(&text[..head]);
    }
    let mut start = head;
    while start < text.len() {
        parts.push(&text[start..start + 4]);
        start += 4;
    }
    parts.join("_")
}

/// Formats `value`. HEX and BIN are zero-padded to `width` bits.
pub fn format_int(value: Bits, base: Base, width: usize, prefix: bool, grouped: bool) -> String {
    let mut text = match base {
        Base::Hex => format!("{value:X}"),
        Base::Bin => format!("{value:b}"),
        Base::Oct => format!("{value:o}"),
        Base::Dec => value.to_string(),
    };

    let pad = match base {
        Base::Hex => width.div_ceil(4),
        Base::Bin => width,
        _ => 0,
    };
    if text.len() < pad {
        text = "0".repeat(pad - text.len()) + &text;
    }

    if grouped && matches!(base, Base::Bin | Base::Hex) && text.len() > 4 {
        text = group(&text);
    }

    if prefix { format!("{}{text}", base.prefix()) } else { text }
}

/// The value read as a signed (two's complement) `width`-bit number, in decimal.
pub fn signed_decimal(value: Bits, width: usize) -> String {
    if value.bit(width - 1) {
        let magnitude = value.wrapping_neg() & mask(width);
        format!("-{magnitude}")
    } else {
        value.to_string()
    }
}

/// Number of set bits.
pub fn popcount(value: Bits) -> usize {
    value.count_ones()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(v: u128) -> Bits {
        Bits::from(v)
    }

    #[test]
    fn parses_with_prefixes_separators_and_signs() {
        assert_eq!(parse_value("0xFF", Base::Dec, 8, false), Ok(n(255)));
        assert_eq!(parse_value("1111_0000", Base::Bin, 8, false), Ok(n(0xF0)));
        assert_eq!(parse_value("0B", Base::Hex, 8, false), Ok(n(0x0B)));
        assert_eq!(parse_value("-1", Base::Dec, 8, true), Ok(n(255)));
        assert_eq!(parse_value("-128", Base::Dec, 8, true), Ok(n(128)));
        assert!(parse_value("-129", Base::Dec, 8, true).is_err());
        assert!(parse_value("-1", Base::Dec, 8, false).is_err());
        assert!(parse_value("", Base::Dec, 8, false).unwrap_err().incomplete);
        assert!(parse_value("0x", Base::Dec, 8, false).unwrap_err().incomplete);
        assert_eq!(parse_value("256", Base::Dec, 8, false).unwrap_err().message, "Exceeds the 8-bit range (max 255)");
        assert_eq!(parse_value("12g", Base::Hex, 16, false).unwrap_err().message, "'g' is not a valid HEX digit");
    }

    #[test]
    fn handles_the_full_512_bits() {
        let all = "f".repeat(128);
        assert_eq!(parse_value(&all, Base::Hex, 512, false), Ok(Bits::MAX));
        let too_long = "1".repeat(200);
        assert!(parse_value(&too_long, Base::Dec, 512, false).is_err());
    }

    #[test]
    fn formats_padded_and_grouped() {
        assert_eq!(format_int(n(0x1F), Base::Hex, 16, true, false), "0x001F");
        assert_eq!(format_int(n(5), Base::Bin, 8, false, true), "0000_0101");
        assert_eq!(format_int(n(0x12345), Base::Hex, 20, false, true), "1_2345");
        assert_eq!(format_int(n(8), Base::Oct, 8, true, false), "0o10");
        assert_eq!(signed_decimal(n(0xFF), 8), "-1");
        assert_eq!(signed_decimal(n(0x7F), 8), "127");
        assert_eq!(mask(512), Bits::MAX);
    }
}
