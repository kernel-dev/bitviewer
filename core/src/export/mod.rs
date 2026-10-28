//! Code export (the web app's core/export). Every output, built-in or the
//! user's own, is an export template (language.rs) rendered against the data
//! of one register or one peripheral built here. The data is the same as the
//! web app's register-data.ts and peripheral-data.ts, key for key, so
//! templates behave the same in both apps.

pub mod language;

use num_bigint::BigInt;

use crate::field::{Access, Field};
use crate::value::Value;
use crate::workspace::Peripheral;
use language::{Num, TV, TemplateError, TemplateMeta, compile_template, obj, render_template};

// ------------------------------------------------------------ naming
/// UPPER_SNAKE identifier from free text ("Value 1" → "VALUE_1").
pub fn ident(text: &str, fallback: &str) -> String {
    let mut id = String::new();
    let mut gap = false;
    for c in text.trim().chars() {
        if c.is_ascii_alphanumeric() {
            if gap && !id.is_empty() {
                id.push('_');
            }
            gap = false;
            id.push(c.to_ascii_uppercase());
        } else {
            gap = true;
        }
    }
    if id.is_empty() {
        id = fallback.into();
    }
    if id.starts_with(|c: char| c.is_ascii_digit()) {
        id.insert(0, '_');
    }
    id
}

/// A prefix for a value: its name as an identifier, or REG for unnamed ones
/// ("Value 1" is the app's default).
pub fn default_prefix(value: &Value) -> String {
    let name = value.name.trim();
    let default_name = name.to_lowercase().strip_prefix("value ").is_some_and(|number| !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()));
    if name.is_empty() || default_name { "REG".into() } else { ident(name, "REG") }
}

/// A unique id from `base`: "X", then "X_2", "X_3"…
fn unique(base: String, used: &mut std::collections::HashSet<String>) -> String {
    let mut id = base.clone();
    let mut suffix = 2;
    while used.contains(&id) {
        id = format!("{base}_{suffix}");
        suffix += 1;
    }
    used.insert(id.clone());
    id
}

// ------------------------------------------------------------ register data
fn big(value: crate::integers::Bits) -> BigInt {
    BigInt::from_bytes_le(num_bigint::Sign::Plus, &value.to_le_bytes::<64>())
}

fn mask(width: usize) -> BigInt {
    (BigInt::from(1u8) << width) - 1
}

fn num(value: BigInt, bits: usize) -> TV {
    Num::of(value, bits).into()
}

fn range_of(lo: usize, hi: usize) -> String {
    if hi > lo { format!("[{hi}:{lo}]") } else { format!("[{lo}]") }
}

/// Bits needed for addresses: 32, or 64 when one doesn't fit in 32.
fn address_bits(addresses: &[Option<u64>]) -> usize {
    if addresses.iter().flatten().any(|address| *address > 0xffff_ffff) { 64 } else { 32 }
}

/// The address facts every register export gets.
fn placement(value: &Value, peripheral: Option<&Peripheral>) -> Vec<(&'static str, TV)> {
    let base = peripheral.and_then(|peripheral| peripheral.base);
    let address = value.offset.zip(base).map(|(offset, base)| base + offset);
    vec![
        ("description", value.description.to_string().into()),
        ("block", value.block.to_string().into()),
        ("has_offset", value.offset.is_some().into()),
        ("offset", num(BigInt::from(value.offset.unwrap_or(0)), 0)),
        ("has_address", address.is_some().into()),
        ("address", num(BigInt::from(address.unwrap_or(0)), 0)),
        ("address_bits", address_bits(&[address, value.offset]).into()),
    ]
}

/// A field's description pieces: (comment, note).
fn describe(field: &Field) -> (String, String) {
    let details = &field.details;
    let mut rest = Vec::new();
    if details.access != Access::ReadWrite {
        rest.push(if details.access == Access::ReadOnly { "read-only".to_string() } else { "reserved".to_string() });
    }
    if details.signed {
        rest.push("signed".into());
    }
    if !details.formula.is_empty() {
        let unit = if details.unit.is_empty() { String::new() } else { format!(" {}", details.unit) };
        rest.push(format!("value = {}{unit}", details.formula));
    } else if !details.unit.is_empty() {
        rest.push(details.unit.to_string());
    }
    if !details.description.is_empty() {
        rest.push(details.description.to_string());
    }
    let mut comment = vec![field.label()];
    comment.extend(rest.iter().cloned());
    (comment.join(" · "), rest.join(" · "))
}

/// Names the built-in templates put after a field's name: a named value
/// called one of these would redefine them.
const RESERVED_SUFFIXES: [&str; 7] = ["POS", "WIDTH", "MASK", "SHIFT", "GET", "SET", "VALUE"];

fn named_items(field: &Field) -> TV {
    let mut used = std::collections::HashSet::new();
    let width = field.width();
    field
        .details
        .named
        .iter()
        .map(|named| {
            let mut base = ident(&named.label, "VALUE");
            if RESERVED_SUFFIXES.contains(&base.as_str()) {
                base = format!("{base}_VAL");
            }
            let id = unique(base, &mut used);
            obj(vec![("label", named.label.to_string().into()), ("id", id.into()), ("value", num(big(named.value) & mask(width), width))])
        })
        .collect::<Vec<_>>()
        .into()
}

fn access_text(access: Access) -> &'static str {
    access.as_str()
}

/// One field, or the part of it in one word; gaps too. All items have the
/// same keys, in the same order.
fn item(value: &Value, field: Option<&Field>, id: &str, lo: usize, hi: usize, word_lo: usize, extra: Vec<(&str, TV)>) -> TV {
    let width = hi - lo + 1;
    let m = mask(width);
    let (comment, note) = match field {
        Some(field) => describe(field),
        None => (format!("{} unused", range_of(lo, hi)), String::new()),
    };
    let details = field.map(|field| &field.details);
    let mut out = obj(vec![
        ("gap", field.is_none().into()),
        ("id", if field.is_some() { id.to_string() } else { String::new() }.into()),
        ("field_id", field.map_or(String::new(), |field| ident(&field.name, "FIELD")).into()),
        ("name", field.map_or(String::new(), |field| field.name.to_string()).into()),
        ("lo", lo.into()),
        ("hi", hi.into()),
        ("bit", (lo - word_lo).into()),
        ("width", width.into()),
        ("range", range_of(lo, hi).into()),
        ("mask", num(m.clone(), width)),
        ("shifted_mask", num(m.clone() << lo, value.width)),
        ("value", num((big(value.value) >> lo) & m, width)),
        ("access", details.map_or("rw", |details| access_text(details.access)).into()),
        ("readonly", details.is_some_and(|details| details.access == Access::ReadOnly).into()),
        ("reserved", details.is_some_and(|details| details.access == Access::Reserved).into()),
        ("signed", details.is_some_and(|details| details.signed).into()),
        ("formula", details.map_or(String::new(), |details| details.formula.to_string()).into()),
        ("unit", details.map_or(String::new(), |details| details.unit.to_string()).into()),
        ("description", details.map_or(String::new(), |details| details.description.to_string()).into()),
        ("comment", comment.into()),
        ("note", note.into()),
        ("named", field.map_or_else(|| Vec::<TV>::new().into(), named_items)),
        ("partial", false.into()),
        ("part", 1usize.into()),
        ("parts", 1usize.into()),
        ("crosses", false.into()),
    ]);
    for (key, value) in extra {
        out = out.with(key, value);
    }
    out
}

/// Options of a register export.
#[derive(Clone, Debug)]
pub struct ExportOptions {
    /// Used in names, e.g. "CTRL".
    pub prefix: String,
    /// Emit the current value as a constant.
    pub include_value: bool,
    /// Emit get/set helpers.
    pub accessors: bool,
    /// The target's register width: wider values are split into words.
    pub platform: usize,
}

/// The data a register template reads.
pub fn export_context(value: &Value, options: &ExportOptions, peripheral: Option<&Peripheral>) -> TV {
    let prefix = ident(&options.prefix, "REG");
    let platform = if options.platform == 64 { 64 } else { 32 };
    let mut ascending: Vec<&Field> = value.fields.iter().collect();
    ascending.sort_by_key(|field| field.lo);
    let mut used = std::collections::HashSet::new();
    let ids: Vec<String> = ascending.iter().map(|field| unique(ident(&field.name, "FIELD"), &mut used)).collect();
    let word_count = value.width.div_ceil(platform).max(1);
    let word_of = |bit: usize| bit / platform;

    let fields: Vec<TV> = ascending
        .iter()
        .zip(&ids)
        .map(|(field, id)| {
            let spans = word_of(field.hi) - word_of(field.lo) + 1;
            item(value, Some(field), id, field.lo, field.hi, 0, vec![("parts", spans.into()), ("crosses", (spans > 1).into())])
        })
        .collect();

    let mut id_width = 4;
    let words: Vec<TV> = (0..word_count)
        .map(|word_index| {
            let lo = word_index * platform;
            let hi = value.width.min(lo + platform) - 1;
            let width = hi - lo + 1;
            let storage = [8, 16, 32, 64].into_iter().find(|size| *size >= width).unwrap_or(64);
            let name = match (word_count, word_index) {
                (1, _) => String::new(),
                (2, 0) => "lower".into(),
                (2, _) => "upper".into(),
                _ => (word_index + 1).to_string(),
            };
            let mut items = Vec::new();
            let mut next = lo;
            for (field, base) in ascending.iter().zip(&ids) {
                if field.hi < lo || field.lo > hi {
                    continue;
                }
                let (part_lo, part_hi) = (field.lo.max(lo), field.hi.min(hi));
                let first_word = word_of(field.lo);
                let spans = word_of(field.hi) - first_word + 1;
                let partial = spans > 1;
                let part = word_index - first_word + 1;
                if part_lo > next {
                    items.push(item(value, None, "", next, part_lo - 1, lo, vec![]));
                }
                let (comment, note) = describe(field);
                let comment = if partial {
                    let note = if note.is_empty() { String::new() } else { format!(" · {note}") };
                    format!("{} · part {part} of {spans} of {}{note}", range_of(part_lo, part_hi), field.label())
                } else {
                    comment
                };
                let id = if partial { format!("{base}_PART{part}") } else { base.clone() };
                items.push(item(
                    value,
                    Some(field),
                    &id,
                    part_lo,
                    part_hi,
                    lo,
                    vec![("partial", partial.into()), ("part", part.into()), ("parts", spans.into()), ("crosses", partial.into()), ("comment", comment.into())],
                ));
                next = next.max(part_hi + 1);
            }
            if next < lo + storage {
                items.push(item(value, None, "", next, lo + storage - 1, lo, vec![]));
            }
            for item in &items {
                if let Some(TV::Str(id)) = item.get("id") {
                    id_width = id_width.max(id.encode_utf16().count());
                }
            }
            let fields: Vec<TV> = items.iter().filter(|item| item.get("gap") == Some(&TV::Bool(false))).cloned().collect();
            let (member, title) = match word_count {
                1 => ("reg".to_string(), "register".to_string()),
                2 => (name.clone(), format!("{name} word")),
                _ => (format!("word{}", word_index + 1), format!("word {}", word_index + 1)),
            };
            obj(vec![
                ("index", (word_index + 1).into()),
                ("name", name.clone().into()),
                ("suffix", if name.is_empty() { String::new() } else { format!("_{name}") }.into()),
                ("member", member.into()),
                ("title", title.into()),
                ("lo", lo.into()),
                ("hi", hi.into()),
                ("width", width.into()),
                ("storage", storage.into()),
                ("value", num((big(value.value) >> lo) & mask(width), width)),
                ("items", items.into()),
                ("fields", fields.into()),
            ])
        })
        .collect();

    let mut out = obj(vec![
        ("name", if value.name.is_empty() { prefix.clone() } else { value.name.to_string() }.into()),
        ("prefix", prefix.into()),
        ("width", value.width.into()),
        ("value", num(big(value.value), value.width)),
        ("include_value", options.include_value.into()),
        ("accessors", options.accessors.into()),
        ("platform", platform.into()),
        ("uint_bits", [8, 16, 32, 64, 128].into_iter().find(|bits| *bits >= value.width).unwrap_or(0).into()),
        ("word_count", word_count.into()),
        ("name_width", id_width.into()),
        ("range_width", format!("[{}:0]", value.width - 1).len().into()),
        ("fields", fields.into()),
        ("words", words.into()),
    ]);
    for (key, value) in placement(value, peripheral) {
        out = out.with(key, value);
    }
    out
}

// ------------------------------------------------------------ peripheral data
/// C-style storage: (bits, count, bytes); an array of 32-bit words above 64 bits.
fn storage_of(width: usize) -> (usize, usize, usize) {
    match [8, 16, 32, 64].into_iter().find(|size| *size >= width) {
        Some(bits) => (bits, 1, bits / 8),
        None => {
            let count = width.div_ceil(32);
            (32, count, count * 4)
        }
    }
}

fn number_of(value: &TV) -> u64 {
    match value {
        TV::Num(num) => u64::try_from(&num.big).unwrap_or(0),
        TV::Number(number) => *number as u64,
        _ => 0,
    }
}

/// The data a peripheral template reads: the peripheral, its registers in
/// offset order, and a byte layout with gaps for structs.
pub fn peripheral_context(peripheral: &Peripheral, values: &[&Value], prefix: &str, include_value: bool) -> TV {
    let prefix = ident(prefix, "REG");
    let mut sorted: Vec<&Value> = values.to_vec();
    // values without an offset go last
    sorted.sort_by(|a, b| match (a.offset, b.offset) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, _) => std::cmp::Ordering::Greater,
        (_, None) => std::cmp::Ordering::Less,
        (Some(x), Some(y)) => x.cmp(&y),
    });
    let mut used = std::collections::HashSet::new();
    let registers: Vec<TV> = sorted
        .iter()
        .map(|value| {
            let own = value.name.strip_prefix(&format!("{}.", peripheral.name)).unwrap_or(&value.name);
            let mut base = ident(own, "REG");
            if base == "BASE" {
                base = "BASE_REG".into();
            }
            let id = unique(base, &mut used);
            let (bits, count, bytes) = storage_of(value.width);
            let options = ExportOptions { prefix: format!("{prefix}_{id}"), include_value, accessors: true, platform: 32 };
            let mut register = export_context(value, &options, Some(peripheral));
            for (key, item) in placement(value, Some(peripheral)) {
                register = register.with(key, item);
            }
            register
                .with("id", id.clone().into())
                .with("name", value.name.to_string().into())
                .with("bytes", value.width.div_ceil(8).into())
                .with("storage", bits.into())
                .with("count", count.into())
                .with("type", format!("uint{bits}_t").into())
                .with("array", if count > 1 { format!("[{count}]") } else { String::new() }.into())
                .with("rust_type", if count > 1 { format!("[u32; {count}]") } else { format!("u{bits}") }.into())
                .with("member_bytes", bytes.into())
        })
        .collect();

    // registers at their offsets, gaps padded, overlapping ones marked
    let mut layout = Vec::new();
    let mut cursor: u64 = 0;
    let mut gaps = 0;
    for register in &registers {
        if register.get("has_offset") != Some(&TV::Bool(true)) {
            continue;
        }
        let offset = number_of(register.get("offset").unwrap());
        if offset < cursor {
            layout.push(register.clone().with("member", false.into()).with("gap", false.into()).with("overlap", true.into()));
            continue;
        }
        if offset > cursor {
            let size = offset - cursor;
            layout.push(obj(vec![
                ("gap", true.into()),
                ("member", false.into()),
                ("overlap", false.into()),
                ("id", format!("RESERVED{gaps}").into()),
                ("offset", num(BigInt::from(cursor), 0)),
                ("bytes", TV::Number(size as f64)),
                ("range", format!("{}–{}", Num::of(BigInt::from(cursor), 0).hex, Num::of(BigInt::from(offset - 1), 0).hex).into()),
                ("declaration", format!("RESERVED{gaps}[{size}]").into()),
            ]));
            gaps += 1;
        }
        let id = match register.get("id") {
            Some(TV::Str(id)) => id.to_string(),
            _ => String::new(),
        };
        let array = match register.get("array") {
            Some(TV::Str(array)) => array.to_string(),
            _ => String::new(),
        };
        layout.push(
            register
                .clone()
                .with("member", true.into())
                .with("gap", false.into())
                .with("overlap", false.into())
                .with("declaration", format!("{id}{array}").into()),
        );
        cursor = offset + number_of(register.get("member_bytes").unwrap());
    }

    let mut addresses = vec![peripheral.base];
    for register in &registers {
        if register.get("has_address") == Some(&TV::Bool(true)) {
            addresses.push(Some(number_of(register.get("address").unwrap())));
        }
    }
    let unplaced: Vec<TV> =
        registers.iter().filter(|register| register.get("has_offset") != Some(&TV::Bool(true))).filter_map(|register| register.get("id").cloned()).collect();
    let text_width = |item: &TV| match item.get("declaration").or_else(|| item.get("id")) {
        Some(TV::Str(text)) => text.encode_utf16().count(),
        _ => 0,
    };
    let name_width = layout.iter().map(text_width).max().unwrap_or(0).max(4);
    obj(vec![
        ("name", peripheral.name.to_string().into()),
        ("prefix", prefix.into()),
        ("description", peripheral.description.to_string().into()),
        ("has_base", peripheral.base.is_some().into()),
        ("base", num(BigInt::from(peripheral.base.unwrap_or(0)), 0)),
        ("address_bits", address_bits(&addresses).into()),
        ("include_value", include_value.into()),
        ("registers", registers.into()),
        ("layout", layout.into()),
        ("unplaced", unplaced.into()),
        ("size", TV::Number(cursor as f64)),
        ("name_width", name_width.into()),
    ])
}

// ------------------------------------------------------------ templates
/// A template the export dialog offers: built-in or the user's own.
#[derive(Clone, Debug, PartialEq)]
pub struct ExportTemplate {
    /// "c", "cstruct", … for built-ins, "custom:<name>" otherwise.
    pub id: String,
    pub name: String,
    /// Without the dot.
    pub extension: String,
    pub about: String,
    pub source: String,
    pub builtin: bool,
    /// "register" or "peripheral".
    pub scope: String,
}

fn builtin(id: &str, source: &str) -> ExportTemplate {
    let meta = compile_template(source).map(|compiled| compiled.meta).unwrap_or_default();
    ExportTemplate {
        id: id.into(),
        name: meta.name.unwrap_or_else(|| id.into()),
        extension: meta.extension.unwrap_or_else(|| "txt".into()),
        about: meta.about.unwrap_or_default(),
        source: source.into(),
        builtin: true,
        scope: meta.scope.unwrap_or_else(|| "register".into()),
    }
}

/// The built-in templates: the very files the web app uses.
pub fn builtin_exports() -> Vec<ExportTemplate> {
    vec![
        builtin("c", include_str!("../../templates/c-macros.tpl")),
        builtin("cstruct", include_str!("../../templates/c-struct.tpl")),
        builtin("rust", include_str!("../../templates/rust.tpl")),
        builtin("python", include_str!("../../templates/python.tpl")),
        builtin("cperipheral", include_str!("../../templates/c-peripheral.tpl")),
        builtin("cperipheralmacros", include_str!("../../templates/c-peripheral-macros.tpl")),
        builtin("rustperipheral", include_str!("../../templates/rust-peripheral.tpl")),
    ]
}

/// The dialog's view of a template saved in the settings.
pub fn custom_export(name: &str, extension: &str, source: &str) -> ExportTemplate {
    // a broken template can still be opened and fixed in the editor
    let meta: TemplateMeta = compile_template(source).map(|compiled| compiled.meta).unwrap_or_default();
    let extension = if !extension.is_empty() { extension.to_string() } else { meta.extension.clone().unwrap_or_else(|| "txt".into()) };
    ExportTemplate {
        id: format!("custom:{}", name.to_lowercase()),
        name: name.into(),
        extension: extension.trim_start_matches('.').into(),
        about: meta.about.unwrap_or_else(|| "Your own template.".into()),
        source: source.into(),
        builtin: false,
        scope: meta.scope.unwrap_or_else(|| "register".into()),
    }
}

/// Renders a register template.
pub fn render_export(source: &str, value: &Value, options: &ExportOptions, peripheral: Option<&Peripheral>) -> Result<String, TemplateError> {
    render_template(&compile_template(source)?, &export_context(value, options, peripheral))
}

/// Renders a peripheral template.
pub fn render_peripheral_export(source: &str, peripheral: &Peripheral, values: &[&Value], prefix: &str, include_value: bool) -> Result<String, TemplateError> {
    render_template(&compile_template(source)?, &peripheral_context(peripheral, values, prefix, include_value))
}

/// True when a template reads the register words, so the register width matters to it.
pub fn uses_words(source: &str) -> bool {
    let word_char = |c: char| c.is_ascii_alphanumeric() || c == '_';
    ["words", "word_count", "platform"].iter().any(|word| {
        source.match_indices(word).any(|(at, _)| {
            let before = source[..at].chars().next_back();
            let after = source[at + word.len()..].chars().next();
            !before.is_some_and(word_char) && !after.is_some_and(word_char)
        })
    })
}

/// A starting point for a new register template.
pub const NEW_TEMPLATE_SOURCE: &str = "@name My template\n@ext txt\n@about Describe what this produces.\n@# Lines starting with @ are instructions; everything else is output.\n${name}: ${width}-bit register\n@for field in fields\n${field.id} = bits ${field.range}\n@end\n";

/// A starting point for a new peripheral template.
pub const NEW_PERIPHERAL_TEMPLATE_SOURCE: &str = "@name My peripheral template\n@ext txt\n@scope peripheral\n@about Describe what this produces.\n@# Lines starting with @ are instructions; everything else is output.\n${name} at ${base}\n@for register in registers\n${register.id} at offset ${register.offset}\n@end\n";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integers::{Base, Bits};
    use crate::rows::View;

    #[test]
    fn names_become_identifiers() {
        assert_eq!(ident("Value 1", "REG"), "VALUE_1");
        assert_eq!(ident("  -- ", "REG"), "REG");
        assert_eq!(ident("3d mode!", "REG"), "_3D_MODE");
        let value = Value::new(8, Bits::ZERO, "Value 12", View::Byte, Base::Hex).unwrap();
        assert_eq!(default_prefix(&value), "REG");
    }

    #[test]
    fn every_builtin_template_renders() {
        let mut value = Value::new(48, Bits::from(0x1234_5678_9ABCu64), "UART0.CTRL", View::Byte, Base::Hex).unwrap();
        value.add_field(0, 3, Some("MODE"), None, None).unwrap();
        value.add_field(28, 39, Some("SPAN"), None, None).unwrap();
        value.set_peripheral("UART0", Some(8));
        let peripheral = Peripheral { name: "UART0".into(), base: Some(0x4001_1000), description: "".into(), collapsed: false };
        let options = ExportOptions { prefix: "CTRL".into(), include_value: true, accessors: true, platform: 32 };
        for template in builtin_exports() {
            let result = if template.scope == "peripheral" {
                render_peripheral_export(&template.source, &peripheral, &[&value], "UART0", true)
            } else {
                render_export(&template.source, &value, &options, Some(&peripheral))
            };
            let text = result.unwrap_or_else(|error| panic!("{}: {error}", template.id));
            assert!(
                text.contains("UART0") || text.contains("CTRL"),
                "{}:
{text}",
                template.id
            );
        }
        assert!(uses_words("@for w in words"));
        assert!(!uses_words("${keywords}"));
    }
}
