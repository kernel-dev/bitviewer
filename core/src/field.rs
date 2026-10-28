//! Register fields: a named, inclusive bit range [lo, hi] with a colour, a
//! display base and optional details (signedness, formula, unit, named
//! values, description, access). A value's fields never overlap and are kept
//! sorted from the top bit down.

use std::sync::Arc;

use num_bigint::{BigInt, Sign};

use super::ModelError;
use super::integers::{Base, Bits, mask};

pub const FIELD_COLORS: [&str; 8] = ["#f59f00", "#2fb344", "#ae3ec9", "#15aabf", "#4c6ef5", "#82c91e", "#f76707", "#868e96"];

/// read-write, read-only, or reserved (don't touch).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Access {
    #[default]
    ReadWrite,
    ReadOnly,
    Reserved,
}

impl Access {
    pub fn parse(text: &str) -> Option<Access> {
        match text {
            "rw" => Some(Access::ReadWrite),
            "ro" => Some(Access::ReadOnly),
            "reserved" => Some(Access::Reserved),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Access::ReadWrite => "rw",
            Access::ReadOnly => "ro",
            Access::Reserved => "reserved",
        }
    }
}

/// A named value of a field, e.g. MODE 1 = "Auto".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NamedValue {
    pub value: Bits,
    pub label: Arc<str>,
}

/// Optional details of a field; everything defaults to "plain unsigned number".
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FieldDetails {
    pub signed: bool,
    /// Real expression in x (the raw or signed value), e.g. "x * 0.5 - 40".
    pub formula: Arc<str>,
    pub unit: Arc<str>,
    pub named: Vec<NamedValue>,
    pub description: Arc<str>,
    pub access: Access,
}

/// Field details as read from a file: named values may be negative or too
/// large until they are fitted to the field (see `fit_named`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DetailsDraft {
    pub signed: Option<bool>,
    pub formula: Option<Arc<str>>,
    pub unit: Option<Arc<str>>,
    pub named: Option<Vec<(BigInt, Arc<str>)>>,
    pub description: Option<Arc<str>>,
    pub access: Option<Access>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Field {
    pub lo: usize,
    pub hi: usize,
    pub name: Arc<str>,
    pub color: Arc<str>,
    pub base: Base,
    pub details: FieldDetails,
}

impl Field {
    pub fn width(&self) -> usize {
        self.hi - self.lo + 1
    }

    pub fn contains(&self, bit: usize) -> bool {
        self.lo <= bit && bit <= self.hi
    }

    /// "[7:4]", or "[3]" for a one-bit field.
    pub fn label(&self) -> String {
        if self.width() > 1 { format!("[{}:{}]", self.hi, self.lo) } else { format!("[{}]", self.lo) }
    }

    pub fn protected(&self) -> bool {
        self.details.access != Access::ReadWrite
    }

    /// The label of a named value, if `raw` has one.
    pub fn name_of(&self, raw: Bits) -> Option<&str> {
        self.details.named.iter().find(|named| named.value == raw).map(|named| &*named.label)
    }

    /// Copies the details that `draft` gives onto the field, keeping only
    /// named values that fit it.
    pub fn assign(&mut self, draft: DetailsDraft) {
        let details = &mut self.details;
        if let Some(signed) = draft.signed {
            details.signed = signed;
        }
        if let Some(formula) = draft.formula {
            details.formula = formula;
        }
        if let Some(unit) = draft.unit {
            details.unit = unit;
        }
        if let Some(description) = draft.description {
            details.description = description;
        }
        if let Some(access) = draft.access {
            details.access = access;
        }
        if let Some(named) = draft.named {
            details.named = fit_named(&named, self.hi - self.lo + 1);
        }
    }
}

/// "#rrggbb" or "#rgb".
pub fn is_color(text: &str) -> bool {
    let Some(hex) = text.strip_prefix('#') else {
        return false;
    };
    (hex.len() == 3 || hex.len() == 6) && hex.chars().all(|c| c.is_ascii_hexdigit())
}

/// Named values that fit in `width` bits. Negative ones become two's
/// complement (-1 = all ones); values that can't fit are dropped.
pub fn fit_named(named: &[(BigInt, Arc<str>)], width: usize) -> Vec<NamedValue> {
    let range = BigInt::from(1u8) << width;
    named
        .iter()
        .filter_map(|(value, label)| {
            let value = if value.sign() == Sign::Minus && -value <= range { value + &range } else { value.clone() };
            if value.sign() == Sign::Minus || value >= range {
                return None;
            }
            Some(NamedValue { value: big_to_bits(&value)? & mask(width), label: label.clone() })
        })
        .collect()
}

/// A non-negative BigInt that fits 512 bits, as Bits.
pub fn big_to_bits(value: &BigInt) -> Option<Bits> {
    if value.sign() == Sign::Minus || value.bits() > 512 {
        return None;
    }
    let (_, bytes) = value.to_bytes_le();
    Bits::try_from_le_slice(&bytes)
}

/// Any integer as `width` bits: negative numbers wrap to two's complement and
/// higher bits are dropped (e.g. an expression's result put into a value).
pub fn wrap_big(value: &BigInt, width: usize) -> Bits {
    let range = BigInt::from(1u8) << width;
    let mut wrapped = value % &range;
    if wrapped.sign() == Sign::Minus {
        wrapped += &range;
    }
    big_to_bits(&wrapped).unwrap_or(Bits::ZERO) & mask(width)
}

/// Fields that share at least one bit with [lo, hi].
pub fn overlapping(fields: &[Field], lo: usize, hi: usize) -> impl Iterator<Item = (usize, &Field)> {
    fields.iter().enumerate().filter(move |(_, field)| !(field.hi < lo || field.lo > hi))
}

/// Checks that [lo, hi] (in either order) fits a `width`-bit value without
/// overlapping a field other than the one at `except`. Returns it as (low, high).
pub fn field_range(fields: &[Field], width: usize, lo: usize, hi: usize, except: Option<usize>) -> Result<(usize, usize), ModelError> {
    let (lo, hi) = (lo.min(hi), lo.max(hi));
    if hi >= width {
        return Err(ModelError::new("Group outside the value"));
    }
    let clash: Vec<String> =
        overlapping(fields, lo, hi).filter(|(index, _)| Some(*index) != except).map(|(_, other)| format!("{} {}", other.name, other.label())).collect();
    if !clash.is_empty() {
        return Err(ModelError::new(format!("Groups cannot overlap: {}", clash.join(", "))));
    }
    Ok((lo, hi))
}

/// The first free name of the form FIELD1, FIELD2, …
pub fn suggest_field_name(fields: &[Field]) -> String {
    (1..).map(|suffix| format!("FIELD{suffix}")).find(|name| !fields.iter().any(|field| &*field.name == name)).unwrap()
}

/// A colour no field uses yet (or the next one round when all are taken).
pub fn next_field_color(fields: &[Field]) -> &'static str {
    FIELD_COLORS
        .iter()
        .find(|color| !fields.iter().any(|field| field.color.eq_ignore_ascii_case(color)))
        .copied()
        .unwrap_or(FIELD_COLORS[fields.len() % FIELD_COLORS.len()])
}

/// A new field for a `width`-bit value that already has `fields`. Missing or
/// invalid names and colours get defaults; short fields default to binary.
pub fn new_field(
    fields: &[Field],
    width: usize,
    lo: usize,
    hi: usize,
    name: Option<&str>,
    color: Option<&str>,
    base: Option<Base>,
) -> Result<Field, ModelError> {
    let (lo, hi) = field_range(fields, width, lo, hi, None)?;
    let name = name.map(str::trim).filter(|name| !name.is_empty());
    Ok(Field {
        lo,
        hi,
        name: name.map(Arc::from).unwrap_or_else(|| suggest_field_name(fields).into()),
        color: Arc::from(color.filter(|color| is_color(color)).unwrap_or_else(|| next_field_color(fields))),
        base: base.unwrap_or(if hi - lo < 3 { Base::Bin } else { Base::Hex }),
        details: FieldDetails::default(),
    })
}

/// Sorts fields from the top bit down.
pub fn sort_fields(fields: &mut [Field]) {
    fields.sort_by_key(|field| std::cmp::Reverse(field.hi));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors() {
        assert!(is_color("#abc"));
        assert!(is_color("#A0B1C2"));
        assert!(!is_color("red"));
        assert!(!is_color("#abcd"));
    }

    #[test]
    fn fits_named_values() {
        let named = vec![(BigInt::from(-1), Arc::from("all")), (BigInt::from(3), Arc::from("three")), (BigInt::from(9), Arc::from("too big"))];
        let fitted = fit_named(&named, 3);
        assert_eq!(fitted.len(), 2);
        assert_eq!(fitted[0].value, Bits::from(7u8));
        assert_eq!(&*fitted[1].label, "three");
    }

    #[test]
    fn wraps_any_integer_into_bits() {
        assert_eq!(wrap_big(&BigInt::from(-1), 8), Bits::from(0xFFu8));
        assert_eq!(wrap_big(&BigInt::from(0x1234), 8), Bits::from(0x34u8));
        assert_eq!(wrap_big(&(BigInt::from(1) << 600), 512), Bits::ZERO);
    }

    #[test]
    fn new_fields_get_defaults_and_refuse_overlaps() {
        let first = new_field(&[], 8, 7, 4, None, None, None).unwrap();
        assert_eq!((first.lo, first.hi, &*first.name, first.base), (4, 7, "FIELD1", Base::Hex));
        let fields = vec![first];
        let second = new_field(&fields, 8, 0, 1, Some(" EN "), Some("bad"), None).unwrap();
        assert_eq!((&*second.name, &*second.color, second.base), ("EN", "#2fb344", Base::Bin));
        let clash = new_field(&fields, 8, 3, 5, None, None, None).unwrap_err();
        assert_eq!(clash.to_string(), "Groups cannot overlap: FIELD1 [7:4]");
        assert!(new_field(&fields, 8, 8, 9, None, None, None).is_err());
    }
}
