//! The JSON form of a value, as saved in workspace files and sessions. It
//! matches the TypeScript app's exactly, so files open in either. Reading is
//! strict about the structure (a broken entry is an error) but skips
//! malformed optional parts, such as one bad snapshot.

use std::collections::HashMap;
use std::sync::Arc;

use num_bigint::{BigInt, Sign};
use num_traits::{Num, ToPrimitive, Zero};
use serde_json::{Map, Value as Json, json};

use crate::ModelError;
use crate::field::{Access, DetailsDraft, big_to_bits};
use crate::integers::{Base, Bits, mask};
use crate::rows::View;
use crate::value::{Snapshot, Value};

/// Gives back one shared copy of each text seen, so repeated texts (field
/// names, descriptions, colours…) are stored once. Share one across a load.
#[derive(Default)]
pub struct TextPool(HashMap<Box<str>, Arc<str>>);

impl TextPool {
    pub fn get(&mut self, text: &str) -> Arc<str> {
        if let Some(shared) = self.0.get(text) {
            return shared.clone();
        }
        let shared: Arc<str> = Arc::from(text);
        self.0.insert(text.into(), shared.clone());
        shared
    }
}

// ------------------------------------------------------------ JavaScript rules
// The TypeScript app reads numbers with Number() and BigInt(); these follow
// the same rules so every file it accepts is accepted here.

/// JavaScript's Number(x) for what JSON can hold (absent = NaN).
fn js_number(value: Option<&Json>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Json::Null) => 0.0,
        Some(Json::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Json::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Json::String(text)) => {
            let text = text.trim();
            if text.is_empty() { 0.0 } else { parse_js_integer(text).and_then(|big| big.to_f64()).or_else(|| text.parse().ok()).unwrap_or(f64::NAN) }
        }
        Some(_) => f64::NAN,
    }
}

/// JavaScript's String(x) for what JSON can hold.
fn js_string(value: &Json) -> String {
    match value {
        Json::String(text) => text.clone(),
        Json::Null => "null".into(),
        Json::Bool(flag) => flag.to_string(),
        Json::Number(number) => number.to_string(),
        _ => "[object Object]".into(),
    }
}

/// An integer as BigInt() reads text: decimal with an optional sign, or
/// 0x / 0o / 0b without one.
fn parse_js_integer(text: &str) -> Option<BigInt> {
    let lower = text.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = lower.strip_prefix(prefix) {
            return BigInt::from_str_radix(digits, radix).ok();
        }
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned.is_empty() || !unsigned.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    BigInt::from_str_radix(text, 10).ok()
}

/// A number from JSON as the app's toBig() reads it: numbers are truncated,
/// text may be hex / octal / binary, "" is 0, booleans are refused.
pub fn to_big(value: &Json) -> Result<BigInt, ModelError> {
    let invalid = || ModelError::new(format!("Invalid number {value}"));
    match value {
        Json::Bool(_) => Err(ModelError::new("boolean is not a number")),
        Json::Number(number) => {
            if let Some(int) = number.as_i64() {
                Ok(BigInt::from(int))
            } else if let Some(int) = number.as_u64() {
                Ok(BigInt::from(int))
            } else {
                let float = number.as_f64().ok_or_else(invalid)?;
                BigInt::from_str_radix(&format!("{:.0}", float.trunc()), 10).map_err(|_| invalid())
            }
        }
        Json::String(text) => {
            let text = text.trim();
            if text.is_empty() { Ok(BigInt::zero()) } else { parse_js_integer(text).ok_or_else(invalid) }
        }
        _ => Err(invalid()),
    }
}

/// `big` & mask(width), with negative numbers as two's complement.
fn masked(big: &BigInt, width: usize) -> Bits {
    let range = BigInt::from(1u8) << width;
    let mut wrapped = big % &range;
    if wrapped.sign() == Sign::Minus {
        wrapped += &range;
    }
    big_to_bits(&wrapped).unwrap_or(Bits::ZERO) & mask(width)
}

fn check_base(number: f64) -> Result<Base, ModelError> {
    if number.fract() == 0.0
        && let Some(base) = Base::from_radix(number as u64)
    {
        return Ok(base);
    }
    Err(ModelError::new(format!("Unsupported base {}", js_number_text(number))))
}

/// How JavaScript prints a number in a message: 7, 2.5, NaN.
fn js_number_text(number: f64) -> String {
    if number.is_nan() {
        "NaN".into()
    } else if number.fract() == 0.0 && number.abs() < 1e21 {
        format!("{number:.0}")
    } else {
        number.to_string()
    }
}

/// A row start from a JSON key; must start a row in the value's view.
fn row_start(key: &str, value: &Value) -> Result<usize, ModelError> {
    let number = js_number(Some(&Json::String(key.into())));
    if number.fract() != 0.0 || number < 0.0 || !number.is_finite() {
        return Err(ModelError::new(format!("{} is not a row start for this view", js_number_text(number))));
    }
    let lo = number as usize;
    value.check_row(lo)?;
    Ok(lo)
}

/// A bit position from JSON: a number or a string of digits.
fn bit_position(value: &Json) -> Result<usize, ModelError> {
    let number = match value {
        Json::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Json::String(text) if !text.trim().is_empty() && text.trim().bytes().all(|b| b.is_ascii_digit()) => js_number(Some(value)),
        _ => f64::NAN,
    };
    if number.fract() != 0.0 || !number.is_finite() {
        return Err(ModelError::new("Field bit positions must be whole numbers"));
    }
    if number < 0.0 {
        return Err(ModelError::new("Group outside the value"));
    }
    Ok(number as usize)
}

// ------------------------------------------------------------ reading
/// The optional field details from JSON, ignoring anything malformed.
pub fn details_from_json(json: &Json, pool: &mut TextPool) -> DetailsDraft {
    let mut draft = DetailsDraft::default();
    if json.get("signed") == Some(&Json::Bool(true)) {
        draft.signed = Some(true);
    }
    let text = |key: &str, pool: &mut TextPool| json.get(key).and_then(Json::as_str).map(|t| pool.get(t));
    draft.formula = text("formula", pool);
    draft.unit = text("unit", pool);
    draft.description = text("description", pool);
    draft.access = json.get("access").and_then(Json::as_str).filter(|access| *access == "ro" || *access == "reserved").and_then(Access::parse);
    draft.write = json.get("write").and_then(Json::as_str).and_then(crate::field::WriteAction::parse);
    draft.read = json.get("read").and_then(Json::as_str).and_then(crate::field::ReadAction::parse);

    if let Some(list) = json.get("named").and_then(Json::as_array) {
        draft.named = Some(
            list.iter()
                .filter_map(|named| {
                    let label = named.get("label")?.as_str()?;
                    let value = to_big(named.get("value").unwrap_or(&Json::Null)).ok()?;
                    Some((value, pool.get(label)))
                })
                .collect(),
        );
    }
    draft
}

/// Reads a value from its workspace JSON. Fails when it is unusable.
pub fn value_from_json(json: &Json, pool: &mut TextPool) -> Result<Value, ModelError> {
    let Some(object) = json.as_object() else {
        return Err(ModelError::new("Invalid value entry"));
    };
    if !object.contains_key("width") {
        return Err(ModelError::new("Invalid value entry: missing width"));
    }

    let width_number = js_number(object.get("width"));
    let width = if width_number.fract() == 0.0 && width_number >= 0.0 && width_number.is_finite() {
        width_number as usize
    } else {
        0 // refused just below
    };
    crate::value::check_width(width)?;

    let view_text = object.get("view").map(js_string).unwrap_or_else(|| "byte".into());
    let view = View::parse(&view_text).ok_or_else(|| ModelError::new(format!("Unknown view {view_text}")))?;
    let name = object.get("name").map(js_string).unwrap_or_else(|| "Value".into());
    let value_big = to_big(object.get("value").unwrap_or(&json!(0)))?;
    let full_base = check_base(js_number(Some(object.get("full_base").unwrap_or(&json!(16)))))?;
    let default_row_base = check_base(js_number(Some(object.get("default_row_base").unwrap_or(&json!(16)))))?;

    let mut value = Value::new(width, masked(&value_big, width), &name, view, default_row_base)?;
    value.full_base = full_base;
    value.msb_first = match object.get("msb_first") {
        None | Some(Json::Null) => true,
        Some(Json::Bool(flag)) => *flag,
        Some(Json::Number(number)) => number.as_f64() != Some(0.0),
        Some(Json::String(text)) => !text.is_empty(),
        Some(_) => true,
    };
    value.show_bases = object.get("show_bases") == Some(&Json::Bool(true));
    value.collapsed = object.get("collapsed") == Some(&Json::Bool(true));
    if let Some(block) = object.get("block").and_then(Json::as_str) {
        value.block = pool.get(block.trim());
    }

    if let Some(offset) = object.get("offset").filter(|offset| !offset.is_null()) {
        let big = to_big(offset)?;
        if big.sign() == Sign::Minus {
            return Err(ModelError::new("Invalid register offset"));
        }
        value.offset = Some(big.to_u64().ok_or_else(|| ModelError::new("Invalid register offset"))?);
    }

    if let Some(description) = object.get("description").and_then(Json::as_str) {
        value.description = pool.get(description);
    }

    for snapshot in object.get("snapshots").and_then(Json::as_array).into_iter().flatten() {
        let Ok(big) = to_big(snapshot.get("value").unwrap_or(&Json::Null)) else {
            continue; // skip a malformed snapshot
        };
        let at = js_number(snapshot.get("at"));
        value.snapshots.push(Snapshot {
            name: pool.get(&snapshot.get("name").map(js_string).unwrap_or_else(|| "Snapshot".into())),
            value: masked(&big, width),
            at: if at.is_finite() { at } else { 0.0 },
        });
    }

    for (key, base) in object.get("row_bases").and_then(Json::as_object).into_iter().flatten() {
        let lo = row_start(key, &value)?;
        let base = check_base(js_number(Some(base)))?;
        value.row_bases.insert(lo, base);
    }

    for (key, row_value) in object.get("compares").and_then(Json::as_object).into_iter().flatten() {
        let lo = row_start(key, &value)?;
        let big = to_big(row_value)?;
        value.compares.insert(lo, masked(&big, value.row_width_at(lo)));
    }

    for (key, row_value) in object.get("hidden_compares").and_then(Json::as_object).into_iter().flatten() {
        let lo = row_start(key, &value)?;
        let big = to_big(row_value)?;
        if !value.compares.contains_key(&lo) {
            value.hidden_compares.insert(lo, masked(&big, value.row_width_at(lo)));
        }
    }

    for group in object.get("groups").and_then(Json::as_array).into_iter().flatten() {
        let (Some(lo), Some(hi)) = (group.get("lo"), group.get("hi")) else {
            return Err(ModelError::new("Invalid group entry"));
        };
        let (lo, hi) = (bit_position(lo)?, bit_position(hi)?);
        let name = pool.get(&group.get("name").map(js_string).unwrap_or_default());
        let color = group.get("color").and_then(Json::as_str).map(|color| pool.get(color));
        let base = check_base(js_number(Some(group.get("base").unwrap_or(&json!(16)))))?;
        let index = value.add_field(lo, hi, Some(&name), color.as_deref(), Some(base))?;
        // add_field may have made its own copies; use the shared ones
        let field = &mut value.fields[index];
        if *field.name == *name {
            field.name = name;
        }
        if let Some(color) = color.filter(|color| **color == *field.color) {
            field.color = color;
        }
        field.assign(details_from_json(group, pool));
    }

    Ok(value)
}

// ------------------------------------------------------------ writing
fn hex(value: Bits) -> Json {
    Json::String(format!("0x{value:X}"))
}

/// Milliseconds as JavaScript writes them: whole numbers without ".0".
fn js_millis(at: f64) -> Json {
    if at.fract() == 0.0 && at.abs() < 9.0e15 { json!(at as i64) } else { json!(at) }
}

/// The workspace JSON of a value, keys in the TypeScript app's order.
pub fn value_to_json(value: &Value) -> Json {
    let mut out = Map::new();
    out.insert("name".into(), json!(&*value.name));
    out.insert("width".into(), json!(value.width));
    out.insert("value".into(), hex(value.value));
    out.insert("view".into(), json!(value.view.as_str()));
    out.insert("msb_first".into(), json!(value.msb_first));
    out.insert("full_base".into(), json!(value.full_base.radix()));
    out.insert("default_row_base".into(), json!(value.default_row_base.radix()));
    out.insert("show_bases".into(), json!(value.show_bases));
    out.insert("collapsed".into(), json!(value.collapsed));
    out.insert(
        "snapshots".into(),
        Json::Array(
            value.snapshots.iter().map(|snapshot| json!({ "name": &*snapshot.name, "value": hex(snapshot.value), "at": js_millis(snapshot.at) })).collect(),
        ),
    );
    out.insert("row_bases".into(), Json::Object(value.row_bases.iter().map(|(lo, base)| (lo.to_string(), json!(base.radix()))).collect()));
    out.insert("compares".into(), Json::Object(value.compares.iter().map(|(lo, v)| (lo.to_string(), hex(*v))).collect()));
    out.insert("hidden_compares".into(), Json::Object(value.hidden_compares.iter().map(|(lo, v)| (lo.to_string(), hex(*v))).collect()));
    out.insert("groups".into(), Json::Array(value.fields.iter().map(field_to_json).collect()));
    // only written when set, so plain values stay as they were
    if !value.block.is_empty() {
        out.insert("block".into(), json!(&*value.block));
    }
    if let Some(offset) = value.offset {
        out.insert("offset".into(), hex(Bits::from(offset)));
    }
    if !value.description.is_empty() {
        out.insert("description".into(), json!(&*value.description));
    }
    Json::Object(out)
}

/// A field's JSON. Only non-default details are written, so plain fields stay compact.
fn field_to_json(field: &crate::field::Field) -> Json {
    let mut out = Map::new();
    out.insert("lo".into(), json!(field.lo));
    out.insert("hi".into(), json!(field.hi));
    out.insert("name".into(), json!(&*field.name));
    out.insert("color".into(), json!(&*field.color));
    out.insert("base".into(), json!(field.base.radix()));
    let details = &field.details;
    if details.signed {
        out.insert("signed".into(), json!(true));
    }
    if !details.formula.is_empty() {
        out.insert("formula".into(), json!(&*details.formula));
    }
    if !details.unit.is_empty() {
        out.insert("unit".into(), json!(&*details.unit));
    }
    if !details.named.is_empty() {
        out.insert(
            "named".into(),
            Json::Array(details.named.iter().map(|named| json!({ "value": named.value.to_string(), "label": &*named.label })).collect()),
        );
    }
    if !details.description.is_empty() {
        out.insert("description".into(), json!(&*details.description));
    }
    if details.access != Access::ReadWrite {
        out.insert("access".into(), json!(details.access.as_str()));
    }
    if details.write != crate::field::WriteAction::Normal {
        out.insert("write".into(), json!(details.write.as_str()));
    }
    if details.read != crate::field::ReadAction::Normal {
        out.insert("read".into(), json!(details.read.as_str()));
    }
    Json::Object(out)
}

impl TextPool {
    /// Replaces `text` by the pool's shared copy.
    pub fn share(&mut self, text: &mut Arc<str>) {
        if let Some(shared) = self.0.get(&**text) {
            if !Arc::ptr_eq(shared, text) {
                *text = shared.clone();
            }
        } else {
            self.0.insert((**text).into(), text.clone());
        }
    }

    /// Shares every text of a value built some other way (an SVD import),
    /// so thousands of values with the same field names, colours and
    /// descriptions store each text once.
    pub fn share_value(&mut self, value: &mut Value) {
        self.share(&mut value.name);
        self.share(&mut value.block);
        self.share(&mut value.description);
        for snapshot in &mut value.snapshots {
            self.share(&mut snapshot.name);
        }
        for field in &mut value.fields {
            self.share(&mut field.name);
            self.share(&mut field.color);
            let details = &mut field.details;
            self.share(&mut details.formula);
            self.share(&mut details.unit);
            self.share(&mut details.description);
            for named in &mut details.named {
                self.share(&mut named.label);
            }
            details.named.shrink_to_fit();
        }
        value.fields.shrink_to_fit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(json: Json) -> Result<Value, ModelError> {
        value_from_json(&json, &mut TextPool::default())
    }

    #[test]
    fn reads_numbers_the_way_javascript_does() {
        assert_eq!(to_big(&json!("0x1F")).unwrap(), BigInt::from(31));
        assert_eq!(to_big(&json!(" -12 ")).unwrap(), BigInt::from(-12));
        assert_eq!(to_big(&json!("")).unwrap(), BigInt::zero());
        assert_eq!(to_big(&json!(7.9)).unwrap(), BigInt::from(7));
        assert!(to_big(&json!(true)).is_err());
        assert!(to_big(&json!("-0x1")).is_err());
        assert!(to_big(&json!("12abc")).is_err());
    }

    #[test]
    fn round_trips_a_full_value() {
        let source = json!({
            "name": "UART0.CTRL", "width": 32, "value": "0x301", "view": "line",
            "msb_first": false, "full_base": 10, "default_row_base": 2,
            "show_bases": true, "collapsed": false,
            "snapshots": [{ "name": "boot", "value": "0x1", "at": 1700000000000i64 }],
            "row_bases": {}, "compares": { "0": "0xFFFF" }, "hidden_compares": {},
            "groups": [
                { "lo": 8, "hi": 9, "name": "MODE", "color": "#2fb344", "base": 2,
                  "named": [{ "value": "0", "label": "Off" }, { "value": "3", "label": "Fast" }],
                  "description": "Mode", "access": "ro" },
                { "lo": 0, "hi": 0, "name": "EN", "color": "#f59f00", "base": 2, "write": "w1c", "read": "rc" }
            ],
            "block": "UART0", "offset": "0x0", "description": "Control register"
        });
        let value = read(source.clone()).unwrap();
        assert_eq!(value.value, Bits::from(0x301u32));
        assert_eq!(value.fields[0].name_of(Bits::from(3u8)), Some("Fast"));
        assert_eq!(value.offset, Some(0));
        assert_eq!(value_to_json(&value), source);
    }

    #[test]
    fn refuses_broken_values_and_skips_broken_details() {
        assert_eq!(read(json!([])).unwrap_err().to_string(), "Invalid value entry");
        assert_eq!(read(json!({})).unwrap_err().to_string(), "Invalid value entry: missing width");
        assert!(read(json!({ "width": 600 })).is_err());
        assert_eq!(read(json!({ "width": 8, "view": "x" })).unwrap_err().to_string(), "Unknown view x");
        assert!(read(json!({ "width": 8, "groups": [{ "lo": 0 }] })).is_err());
        assert!(read(json!({ "width": 8, "compares": { "3": "0x1" } })).is_err());
        let value = read(json!({
            "width": "8", "value": -1,
            "snapshots": [{ "value": true }, { "name": 5, "value": "2" }],
            "groups": [{ "lo": "4", "hi": 7, "named": [{ "value": "x", "label": "bad" }, { "value": -1, "label": "all" }] }]
        }))
        .unwrap();
        assert_eq!(value.value, Bits::from(0xFFu8));
        assert_eq!(value.snapshots.len(), 1);
        assert_eq!(&*value.snapshots[0].name, "5");
        assert_eq!(&*value.fields[0].name, "FIELD1");
        assert_eq!(value.fields[0].details.named.len(), 1);
        assert_eq!(value.fields[0].details.named[0].value, Bits::from(0xFu8));
    }

    #[test]
    fn shares_repeated_texts() {
        let mut pool = TextPool::default();
        let entry = json!({ "width": 8, "description": "Control", "groups": [{ "lo": 0, "hi": 0, "name": "EN", "description": "Enable" }] });
        let first = value_from_json(&entry, &mut pool).unwrap();
        let second = value_from_json(&entry, &mut pool).unwrap();
        assert!(Arc::ptr_eq(&first.description, &second.description));
        assert!(Arc::ptr_eq(&first.fields[0].details.description, &second.fields[0].details.description));
        assert!(Arc::ptr_eq(&first.fields[0].name, &second.fields[0].name));
    }
}
