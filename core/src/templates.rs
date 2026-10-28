//! Field layout templates: a width and a list of fields, applied to a value
//! to give it those fields. Built-in presets plus the user's own, saved in
//! the settings (the web app's templates.ts).

use std::sync::Arc;

use num_bigint::BigInt;
use serde_json::{Map, Value as Json, json};

use crate::field::{Access, DetailsDraft, Field, is_color};
use crate::integers::{Base, MAX_WIDTH, MIN_WIDTH};
use crate::json::{TextPool, details_from_json};
use crate::value::Value;

#[derive(Clone, Debug, PartialEq)]
pub struct TemplateField {
    pub lo: usize,
    pub hi: usize,
    pub name: String,
    /// None or invalid: the next free field colour.
    pub color: Option<String>,
    pub base: Option<Base>,
    pub details: DetailsDraft,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Template {
    pub name: String,
    pub width: usize,
    pub description: Option<String>,
    pub fields: Vec<TemplateField>,
    pub builtin: bool,
}

impl Template {
    /// Checks the template's shape and drops fields that can't be used
    /// (outside the width, or with lo above hi).
    pub fn validated(mut self) -> Option<Template> {
        if !(MIN_WIDTH..=MAX_WIDTH).contains(&self.width) {
            return None;
        }
        let width = self.width;
        self.fields.retain(|field| field.lo <= field.hi && field.hi < width);
        Some(self)
    }
}

// ------------------------------------------------------------ presets
const ORANGE: &str = "#f59f00";
const GREEN: &str = "#2fb344";
const PURPLE: &str = "#ae3ec9";
const CYAN: &str = "#15aabf";
const BLUE: &str = "#4c6ef5";
const RED: &str = "#f76707";
const GRAY: &str = "#868e96";

fn field(lo: usize, hi: usize, name: &str, color: &str, radix: u64) -> TemplateField {
    TemplateField { lo, hi, name: name.into(), color: Some(color.into()), base: Base::from_radix(radix), details: DetailsDraft::default() }
}

impl TemplateField {
    fn formula(mut self, formula: &str) -> Self {
        self.details.formula = Some(formula.into());
        self
    }

    fn describe(mut self, description: &str) -> Self {
        self.details.description = Some(description.into());
        self
    }
}

fn preset(name: &str, width: usize, description: Option<&str>, fields: Vec<TemplateField>) -> Template {
    Template { name: name.into(), width, description: description.map(String::from), fields, builtin: true }
}

/// The built-in templates (the web app's BUILTIN_TEMPLATES).
pub fn builtin_templates() -> Vec<Template> {
    let labels = [
        "ASCII (1 byte)",
        "ASCII (1 byte)",
        "ASCII (1 byte)",
        "ASCII (1 byte)",
        "continuation byte",
        "continuation byte",
        "2-byte sequence",
        "3- or 4-byte sequence",
    ];
    let utf8_named: Vec<(BigInt, Arc<str>)> = labels.iter().enumerate().map(|(value, label)| (BigInt::from(value), Arc::from(*label))).collect();
    let mut prefix = field(5, 7, "PREFIX", ORANGE, 2);
    prefix.details.named = Some(utf8_named);
    vec![
        preset(
            "IEEE-754 float32",
            32,
            Some("Single precision: sign, 8-bit exponent (bias 127), 23-bit fraction"),
            vec![
                field(31, 31, "SIGN", ORANGE, 2).describe("1 = negative"),
                field(23, 30, "EXPONENT", GREEN, 10).formula("x - 127").describe("Biased by 127"),
                field(0, 22, "FRACTION", PURPLE, 16).describe("Mantissa without the hidden 1"),
            ],
        ),
        preset(
            "IEEE-754 float64",
            64,
            Some("Double precision: sign, 11-bit exponent (bias 1023), 52-bit fraction"),
            vec![
                field(63, 63, "SIGN", ORANGE, 2).describe("1 = negative"),
                field(52, 62, "EXPONENT", GREEN, 10).formula("x - 1023").describe("Biased by 1023"),
                field(0, 51, "FRACTION", PURPLE, 16).describe("Mantissa without the hidden 1"),
            ],
        ),
        preset(
            "IEEE-754 float16 (half)",
            16,
            Some("Half precision: sign, 5-bit exponent (bias 15), 10-bit fraction"),
            vec![
                field(15, 15, "SIGN", ORANGE, 2),
                field(10, 14, "EXPONENT", GREEN, 10).formula("x - 15").describe("Biased by 15"),
                field(0, 9, "FRACTION", PURPLE, 16),
            ],
        ),
        preset(
            "bfloat16",
            16,
            Some("Brain float: the top 16 bits of a float32"),
            vec![
                field(15, 15, "SIGN", ORANGE, 2),
                field(7, 14, "EXPONENT", GREEN, 10).formula("x - 127").describe("Biased by 127"),
                field(0, 6, "FRACTION", PURPLE, 16),
            ],
        ),
        preset(
            "RGB565 colour",
            16,
            None,
            vec![
                field(11, 15, "R", RED, 10).formula("x * 255 / 31"),
                field(5, 10, "G", GREEN, 10).formula("x * 255 / 63"),
                field(0, 4, "B", BLUE, 10).formula("x * 255 / 31"),
            ],
        ),
        preset(
            "ARGB8888 colour",
            32,
            None,
            vec![field(24, 31, "A", GRAY, 16), field(16, 23, "R", RED, 16), field(8, 15, "G", GREEN, 16), field(0, 7, "B", BLUE, 16)],
        ),
        preset(
            "IPv4 address",
            32,
            None,
            vec![field(24, 31, "OCTET1", ORANGE, 10), field(16, 23, "OCTET2", GREEN, 10), field(8, 15, "OCTET3", PURPLE, 10), field(0, 7, "OCTET4", CYAN, 10)],
        ),
        preset("UTF-8 lead byte", 8, Some("How many bytes a UTF-8 sequence has, from its first byte"), vec![prefix, field(0, 4, "PAYLOAD", PURPLE, 2)]),
    ]
}

/// Reads a stored template (validTemplate): None when it isn't usable;
/// fields that can't be used are dropped, bad colours forgotten.
pub fn template_from_json(json: &Json) -> Option<Template> {
    let name = json.get("name")?.as_str()?.to_string();
    let width = json.get("width")?.as_u64()? as usize;
    let list = json.get("fields")?.as_array()?;
    let mut pool = TextPool::default();
    let fields = list
        .iter()
        .filter_map(|entry| {
            let lo = entry.get("lo")?.as_u64()? as usize;
            let hi = entry.get("hi")?.as_u64()? as usize;
            let name = entry.get("name")?.as_str()?.to_string();
            let color = entry.get("color").and_then(Json::as_str).filter(|color| is_color(color)).map(String::from);
            let base = entry.get("base").and_then(Json::as_u64).and_then(Base::from_radix);
            Some(TemplateField { lo, hi, name, color, base, details: details_from_json(entry, &mut pool) })
        })
        .collect();
    let description = json.get("description").and_then(Json::as_str).map(String::from);
    Template { name, width, description, fields, builtin: false }.validated()
}

fn details_json(out: &mut Map<String, Json>, details: &DetailsDraft) {
    if details.signed == Some(true) {
        out.insert("signed".into(), json!(true));
    }
    for (key, text) in [("formula", &details.formula), ("unit", &details.unit)] {
        if let Some(text) = text.as_deref().filter(|text| !text.is_empty()) {
            out.insert(key.into(), json!(text));
        }
    }
    if let Some(named) = details.named.as_ref().filter(|named| !named.is_empty()) {
        let list: Vec<Json> = named.iter().map(|(value, label)| json!({ "value": value.to_string(), "label": &**label })).collect();
        out.insert("named".into(), Json::Array(list));
    }
    if let Some(text) = details.description.as_deref().filter(|text| !text.is_empty()) {
        out.insert("description".into(), json!(text));
    }
    if let Some(access) = details.access.filter(|access| *access != Access::ReadWrite) {
        out.insert("access".into(), json!(access.as_str()));
    }
}

/// A template as stored in the settings.
pub fn template_to_json(template: &Template) -> Json {
    let fields: Vec<Json> = template
        .fields
        .iter()
        .map(|field| {
            let mut out = Map::new();
            out.insert("lo".into(), json!(field.lo));
            out.insert("hi".into(), json!(field.hi));
            out.insert("name".into(), json!(field.name));
            if let Some(color) = &field.color {
                out.insert("color".into(), json!(color));
            }
            if let Some(base) = field.base {
                out.insert("base".into(), json!(base.radix()));
            }
            details_json(&mut out, &field.details);
            Json::Object(out)
        })
        .collect();
    let mut out = Map::new();
    out.insert("name".into(), json!(template.name));
    out.insert("width".into(), json!(template.width));
    if let Some(description) = &template.description {
        out.insert("description".into(), json!(description));
    }
    out.insert("fields".into(), Json::Array(fields));
    Json::Object(out)
}

fn draft_of(field: &Field) -> DetailsDraft {
    let details = &field.details;
    let text = |text: &Arc<str>| (!text.is_empty()).then(|| text.clone());
    let named = details.named.iter().map(|named| {
        let value = BigInt::from_bytes_le(num_bigint::Sign::Plus, &named.value.to_le_bytes::<64>());
        (value, named.label.clone())
    });
    DetailsDraft {
        signed: details.signed.then_some(true),
        formula: text(&details.formula),
        unit: text(&details.unit),
        named: (!details.named.is_empty()).then(|| named.collect()),
        description: text(&details.description),
        access: (details.access != Access::ReadWrite).then_some(details.access),
    }
}

/// A template of `value`'s fields (Save fields as template).
pub fn template_from_value(value: &Value, name: &str) -> Template {
    let fields = value
        .fields
        .iter()
        .map(|field| TemplateField {
            lo: field.lo,
            hi: field.hi,
            name: field.name.to_string(),
            color: Some(field.color.to_string()),
            base: Some(field.base),
            details: draft_of(field),
        })
        .collect();
    let description = (!value.description.is_empty()).then(|| value.description.to_string());
    Template { name: name.into(), width: value.width, description, fields, builtin: false }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integers::Bits;
    use crate::rows::View;

    #[test]
    fn presets_apply_and_saved_templates_round_trip() {
        let presets = builtin_templates();
        assert_eq!(presets.len(), 8);
        let mut value = Value::new(32, Bits::from(0x3f80_0000u32), "F", View::Byte, Base::Hex).unwrap();
        value.apply_template(&presets[0]).unwrap();
        assert_eq!(value.fields.len(), 3);
        assert_eq!(&*value.fields[1].details.formula, "x - 127");

        let saved = template_from_value(&value, "Mine");
        let read = template_from_json(&template_to_json(&saved)).unwrap();
        assert_eq!(read.fields, saved.fields);
        assert_eq!(read.width, 32);
        assert!(template_from_json(&json!({ "name": "x", "width": 0, "fields": [] })).is_none());
        let dropped = template_from_json(&json!({ "name": "x", "width": 8, "fields": [{ "lo": 3, "hi": 9, "name": "A" }] })).unwrap();
        assert!(dropped.fields.is_empty());
    }
}
