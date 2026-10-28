//! CMSIS-SVD import (the web app's core/svd): reads a System View
//! Description into peripherals, registers, fields and enumerated values.
//!
//! Supported: device / peripheral / cluster / register / field nesting,
//! inherited register properties (size, access, resetValue, resetMask),
//! derivedFrom on peripherals, clusters, registers, fields and
//! enumeratedValues, dim arrays (dim, dimIncrement, dimIndex, %s and [%s]),
//! the three ways of giving a field's bits, and enumerated values with
//! don't-care bits (#1x0). Register arrays stay one `SvdRegisterArray` whose
//! copies are made only when asked for, so arrays of any size are cheap.

use std::borrow::Cow;
use std::collections::HashMap;
use std::rc::Rc;

use num_bigint::BigInt;
use num_traits::{One, ToPrimitive, Zero};

use crate::field::{Access, DetailsDraft, FIELD_COLORS};
use crate::integers::MAX_WIDTH;
use crate::templates::{Template, TemplateField};

// ------------------------------------------------------------ XML
#[derive(Clone, Debug, PartialEq)]
pub struct XmlError {
    pub reason: String,
    pub line: usize,
}

impl std::fmt::Display for XmlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Line {}: {}", self.line, self.reason)
    }
}

#[derive(Clone, Debug, Default)]
pub struct XmlElement<'s> {
    /// Shared between elements of the same name (a file has few names).
    pub name: Rc<str>,
    pub attributes: Attributes,
    pub children: Vec<Rc<XmlElement<'s>>>,
    /// The element's own text (not its children's), entities decoded;
    /// borrowed from the file when it needed no decoding.
    pub text: Cow<'s, str>,
}

/// An element's attributes. Few SVD elements have any, and a big file has
/// millions of elements, so none costs one pointer instead of a map.
#[derive(Clone, Debug, Default)]
#[allow(clippy::box_collection)] // one pointer per element, not a whole empty map
pub struct Attributes(Option<Box<HashMap<String, String>>>);

impl Attributes {
    pub fn get(&self, key: &str) -> Option<&String> {
        self.0.as_ref()?.get(key)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.0.as_ref().is_some_and(|map| map.contains_key(key))
    }

    pub fn insert(&mut self, key: String, value: String) {
        self.0.get_or_insert_default().insert(key, value);
    }
}

fn line_of(source: &str, at: usize) -> usize {
    source[..at.min(source.len())].matches('\n').count() + 1
}

fn decode_entities<'s>(text: &'s str, source: &str, at: usize) -> Result<Cow<'s, str>, XmlError> {
    if !text.contains('&') {
        return Ok(Cow::Borrowed(text));
    }
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after.find(';').filter(|end| {
            let entity = &after[..*end];
            !entity.is_empty()
                && (entity.chars().all(|c| c.is_ascii_alphabetic())
                    || entity.strip_prefix('#').is_some_and(|n| {
                        n.strip_prefix(['x', 'X'])
                            .map_or(!n.is_empty() && n.chars().all(|c| c.is_ascii_digit()), |hex| !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit()))
                    }))
        });
        let Some(end) = end else {
            out.push('&');
            rest = after;
            continue;
        };
        let entity = &after[..end];
        let whole = format!("&{entity};");
        let decoded = if let Some(number) = entity.strip_prefix('#') {
            let code = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok(),
                None => number.parse::<u32>().ok(),
            };
            match code.and_then(char::from_u32) {
                Some(c) => c.to_string(),
                None => return Err(XmlError { reason: format!("Bad character reference {whole}"), line: line_of(source, at) }),
            }
        } else {
            match entity {
                "lt" => "<".into(),
                "gt" => ">".into(),
                "amp" => "&".into(),
                "quot" => "\"".into(),
                "apos" => "'".into(),
                _ => return Err(XmlError { reason: format!("Unknown entity {whole}"), line: line_of(source, at) }),
            }
        };
        out.push_str(&decoded);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(Cow::Owned(out))
}

fn name_at(source: &str, at: usize) -> Option<&str> {
    let bytes = source.as_bytes();
    let first = *bytes.get(at)?;
    if !(first.is_ascii_alphabetic() || first == b'_' || first == b':') {
        return None;
    }
    let mut end = at + 1;
    while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || matches!(bytes[end], b'_' | b'-' | b'.' | b':')) {
        end += 1;
    }
    Some(&source[at..end])
}

/// Parses a document and returns its root element.
pub fn parse_xml(source: &str) -> Result<Rc<XmlElement<'_>>, XmlError> {
    let fail = |reason: String, at: usize| XmlError { reason, line: line_of(source, at) };
    let bytes = source.as_bytes();
    let mut cursor = 0;
    // open elements, each with its text parts
    let mut stack: Vec<(XmlElement, Cow<str>)> = Vec::new();
    let mut root: Option<Rc<XmlElement>> = None;
    let mut names: HashMap<&str, Rc<str>> = HashMap::new();

    fn add_text<'s>(stack: &mut [(XmlElement<'s>, Cow<'s, str>)], text: Cow<'s, str>) -> bool {
        match stack.last_mut() {
            Some((_, parts)) if parts.is_empty() => {
                *parts = text;
                true
            }
            Some((_, parts)) => {
                parts.to_mut().push_str(&text);
                true
            }
            None => text.trim().is_empty(),
        }
    }

    while cursor < source.len() {
        let Some(open) = source[cursor..].find('<').map(|offset| cursor + offset) else {
            let text = decode_entities(&source[cursor..], source, cursor)?;
            if !add_text(&mut stack, text) {
                return Err(fail("Text outside the root element".into(), cursor));
            }
            break;
        };
        if open > cursor {
            let text = decode_entities(&source[cursor..open], source, open)?;
            if !add_text(&mut stack, text) {
                return Err(fail("Text outside the root element".into(), cursor));
            }
        }
        cursor = open;
        let rest = &source[cursor..];
        if rest.starts_with("<!--") {
            let end = source[cursor + 4..].find("-->").ok_or_else(|| fail("A comment is never closed".into(), cursor))?;
            cursor += 4 + end + 3;
        } else if rest.starts_with("<![CDATA[") {
            let end = source[cursor + 9..].find("]]>").ok_or_else(|| fail("A CDATA section is never closed".into(), cursor))?;
            let text = Cow::Borrowed(&source[cursor + 9..cursor + 9 + end]);
            add_text(&mut stack, text);
            cursor += 9 + end + 3;
        } else if rest.starts_with("<?") {
            let end = source[cursor + 2..].find("?>").ok_or_else(|| fail("A <? … ?> instruction is never closed".into(), cursor))?;
            cursor += 2 + end + 2;
        } else if rest.starts_with("<!") {
            let mut depth = 0i32;
            let mut scan = cursor + 2;
            while scan < bytes.len() {
                match bytes[scan] {
                    b'[' => depth += 1,
                    b']' => depth -= 1,
                    b'>' if depth <= 0 => break,
                    _ => {}
                }
                scan += 1;
            }
            if scan >= bytes.len() {
                return Err(fail("A <! … > declaration is never closed".into(), cursor));
            }
            cursor = scan + 1;
        } else if bytes.get(cursor + 1) == Some(&b'/') {
            let name = name_at(source, cursor + 2).ok_or_else(|| fail("Expected a tag name after </".into(), cursor))?.to_string();
            let after = cursor + 2 + name.len();
            let end = source[after..].find('>').map(|offset| after + offset);
            let Some(end) = end.filter(|end| source[after..*end].trim().is_empty()) else {
                return Err(fail(format!("Bad closing tag </{name}"), cursor));
            };
            let Some((mut element, text)) = stack.pop() else {
                return Err(fail(format!("</{name}> without an opening tag"), cursor));
            };
            if *element.name != *name {
                return Err(fail(format!("</{name}> closes <{}>", element.name), cursor));
            }
            // only an element's own words count; layout whitespace around children isn't kept
            element.text = if !element.children.is_empty() && text.trim().is_empty() { Cow::Borrowed("") } else { text };
            element.children.shrink_to_fit();
            let element = Rc::new(element);
            match stack.last_mut() {
                Some((parent, _)) => parent.children.push(element),
                None => root = Some(element),
            }
            cursor = end + 1;
        } else {
            let name = name_at(source, cursor + 1).ok_or_else(|| fail("Expected a tag name after <".into(), cursor))?;
            let shared = names.entry(name).or_insert_with(|| Rc::from(name)).clone();
            let mut element = XmlElement { name: shared, ..Default::default() };
            let mut scan = cursor + 1 + element.name.len();
            // attributes: whitespace, name, =, quoted value
            loop {
                let mut probe = scan;
                if !bytes.get(probe).is_some_and(u8::is_ascii_whitespace) {
                    break;
                }
                while bytes.get(probe).is_some_and(u8::is_ascii_whitespace) {
                    probe += 1;
                }
                let Some(key) = name_at(source, probe) else { break };
                probe += key.len();
                while bytes.get(probe).is_some_and(u8::is_ascii_whitespace) {
                    probe += 1;
                }
                if bytes.get(probe) != Some(&b'=') {
                    break;
                }
                probe += 1;
                while bytes.get(probe).is_some_and(u8::is_ascii_whitespace) {
                    probe += 1;
                }
                let Some(&quote) = bytes.get(probe).filter(|q| **q == b'"' || **q == b'\'') else { break };
                let Some(close) = source[probe + 1..].find(quote as char) else { break };
                let raw = &source[probe + 1..probe + 1 + close];
                element.attributes.insert(key.to_string(), decode_entities(raw, source, scan)?.into_owned());
                scan = probe + 1 + close + 1;
            }
            while bytes.get(scan).is_some_and(u8::is_ascii_whitespace) {
                scan += 1;
            }
            let self_closing = source[scan..].starts_with("/>");
            if !self_closing && bytes.get(scan) != Some(&b'>') {
                let found = source[scan..].chars().next().map_or("end of file".to_string(), |c| c.to_string());
                return Err(fail(format!("Unexpected \"{found}\" in <{}>", element.name), scan));
            }
            cursor = scan + if self_closing { 2 } else { 1 };
            if self_closing {
                let element = Rc::new(element);
                match stack.last_mut() {
                    Some((parent, _)) => parent.children.push(element),
                    None if root.is_some() => return Err(fail("A second root element".into(), cursor)),
                    None => root = Some(element),
                }
            } else {
                if stack.is_empty() && root.is_some() {
                    return Err(fail("A second root element".into(), cursor));
                }
                stack.push((element, Cow::Borrowed("")));
            }
        }
    }
    if let Some((element, _)) = stack.last() {
        return Err(fail(format!("<{}> is never closed", element.name), source.len()));
    }
    root.ok_or(XmlError { reason: "No elements found".into(), line: 1 })
}

fn child<'a, 's>(element: &'a XmlElement<'s>, name: &str) -> Option<&'a Rc<XmlElement<'s>>> {
    element.children.iter().find(|candidate| candidate.name.as_ref() == name)
}

fn children<'a, 's: 'a>(element: Option<&'a Rc<XmlElement<'s>>>, name: &'a str) -> impl Iterator<Item = &'a Rc<XmlElement<'s>>> {
    element.into_iter().flat_map(move |element| element.children.iter().filter(move |candidate| candidate.name.as_ref() == name))
}

fn child_text(element: &XmlElement, name: &str) -> Option<String> {
    child(element, name).map(|found| found.text.trim().to_string())
}

/// A child's text with whitespace runs collapsed.
fn text(element: &XmlElement, name: &str) -> String {
    child_text(element, name).unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ")
}

// ------------------------------------------------------------ numbers and arrays
/// A number as SVD writes them: 0x1F, #11111 (binary), 0b11111 or 31, with
/// an optional k / M / G / T suffix (×1024 each).
pub fn parse_svd_number(text: Option<&str>) -> Option<BigInt> {
    let text = text?.trim();
    let text = text.strip_prefix('+').unwrap_or(text);
    let (digits, shift) = match text.chars().last() {
        Some(c) if "kmgtKMGT".contains(c) && text.len() > 1 => {
            let power = "kmgt".find(c.to_ascii_lowercase()).unwrap() + 1;
            (&text[..text.len() - 1], 10 * power)
        }
        _ => (text, 0),
    };
    let lower = digits.to_lowercase();
    let value = if let Some(hex) = lower.strip_prefix("0x") {
        (!hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit())).then(|| BigInt::parse_bytes(hex.as_bytes(), 16))??
    } else if let Some(binary) = lower.strip_prefix('#').or_else(|| lower.strip_prefix("0b")) {
        (!binary.is_empty() && binary.chars().all(|c| c == '0' || c == '1')).then(|| BigInt::parse_bytes(binary.as_bytes(), 2))??
    } else {
        (!lower.is_empty() && lower.chars().all(|c| c.is_ascii_digit())).then(|| BigInt::parse_bytes(lower.as_bytes(), 10))??
    };
    Some(value << shift)
}

fn svd_number(element: &XmlElement, name: &str) -> Option<BigInt> {
    parse_svd_number(child_text(element, name).as_deref())
}

const MAX_DONT_CARE: usize = 8;

/// Enumerated value text: a number, or binary with x don't-care bits
/// ("#1x0") that stands for every value it matches.
pub fn enum_values(text: &str) -> Option<Vec<BigInt>> {
    let trimmed = text.trim();
    let lower = trimmed.to_lowercase();
    let pattern = lower
        .strip_prefix('#')
        .or_else(|| lower.strip_prefix("0b"))
        .filter(|p| !p.is_empty() && p.chars().all(|c| matches!(c, '0' | '1' | 'x')) && p.contains('x'));
    let Some(pattern) = pattern else {
        return parse_svd_number(Some(trimmed)).map(|value| vec![value]);
    };
    let free = pattern.matches('x').count();
    if free > MAX_DONT_CARE {
        return None;
    }
    Some(
        (0..1u32 << free)
            .map(|combination| {
                let mut bit = free;
                let digits: String = pattern
                    .chars()
                    .map(|digit| {
                        if digit == 'x' {
                            bit -= 1;
                            if (combination >> bit) & 1 == 1 { '1' } else { '0' }
                        } else {
                            digit
                        }
                    })
                    .collect();
                BigInt::parse_bytes(digits.as_bytes(), 2).unwrap()
            })
            .collect(),
    )
}

/// How a dim array's copies are named.
#[derive(Clone, Debug)]
enum Index {
    /// first, first + 1, …
    Numbered(BigInt),
    /// A letter range from this letter.
    Letters(u32),
    List(Vec<String>),
}

/// A dim array, described rather than expanded.
#[derive(Clone, Debug)]
pub struct Dim {
    pub count: usize,
    /// dimIncrement: bytes between copies (bits, for fields).
    pub step: BigInt,
    index: Index,
    /// Every index in short: "0-4095", "A-C" or "a,b,c".
    pub range: String,
}

impl Dim {
    fn single() -> Dim {
        Dim { count: 1, step: BigInt::zero(), index: Index::List(vec![String::new()]), range: String::new() }
    }

    /// The text that replaces %s in copy `position`.
    pub fn index(&self, position: usize) -> String {
        match &self.index {
            Index::Numbered(first) => (first + position).to_string(),
            Index::Letters(first) => char::from_u32(first + position as u32).map(String::from).unwrap_or_default(),
            Index::List(list) => list.get(position).cloned().unwrap_or_default(),
        }
    }
}

fn numbered(count: usize, first: BigInt) -> (Index, String) {
    let range = if count == 1 { first.to_string() } else { format!("{first}-{}", &first + (count - 1)) };
    (Index::Numbered(first), range)
}

fn dim_index(count: usize, text: Option<&str>, name: &str, warnings: &mut Vec<String>) -> (Index, String) {
    let Some(text) = text.filter(|text| !text.is_empty()) else { return numbered(count, BigInt::zero()) };
    let trimmed = text.trim();
    // "0-7"
    if let Some((a, b)) = trimmed.split_once('-').map(|(a, b)| (a.trim(), b.trim()))
        && !a.is_empty()
        && !b.is_empty()
        && a.chars().all(|c| c.is_ascii_digit())
        && b.chars().all(|c| c.is_ascii_digit())
    {
        let first: BigInt = a.parse().unwrap();
        let last: BigInt = b.parse().unwrap();
        if &last - &first + 1 != BigInt::from(count) {
            warnings.push(format!("{name}: dimIndex {trimmed} doesn't match dim {count}; numbered from {first}"));
        }
        return numbered(count, first);
    }
    // "A-D" or "a-d"
    let letters = trimmed.split_once('-').map(|(a, b)| (a.trim(), b.trim())).filter(|(a, b)| {
        let one = |s: &str| s.len() == 1;
        one(a) && one(b) && {
            let (x, y) = (a.chars().next().unwrap(), b.chars().next().unwrap());
            (x.is_ascii_uppercase() && y.is_ascii_uppercase()) || (x.is_ascii_lowercase() && y.is_ascii_lowercase())
        }
    });
    if let Some((a, b)) = letters {
        let first = a.chars().next().unwrap() as u32;
        let last = first + count as u32 - 1;
        let end = if a.chars().next().unwrap().is_ascii_uppercase() { 'Z' } else { 'z' } as u32;
        if last > end {
            warnings.push(format!("{name}: dimIndex {trimmed} runs out of letters for dim {count}; numbered 0-{}", count - 1));
            return numbered(count, BigInt::zero());
        }
        if last != b.chars().next().unwrap() as u32 {
            warnings.push(format!("{name}: dimIndex {trimmed} doesn't match dim {count}; lettered from {a}"));
        }
        let range = if count == 1 { a.to_string() } else { format!("{a}-{}", char::from_u32(last).unwrap()) };
        return (Index::Letters(first), range);
    }
    let list: Vec<String> = text.split(',').map(|part| part.trim().to_string()).collect();
    if list.len() != count {
        let n = list.len();
        warnings.push(format!("{name}: dimIndex lists {n} name{} for dim {count}; numbered 0-{}", if n == 1 { "" } else { "s" }, count - 1));
        return numbered(count, BigInt::zero());
    }
    let range = if count <= 4 { list.join(",") } else { format!("{},…,{}", list[0], list[count - 1]) };
    (Index::List(list), range)
}

const MAX_SAFE: u64 = (1 << 53) - 1;

/// The element's dim array (single when it has none), or None when it is
/// too large to count (the warning says so).
fn read_dim(element: &XmlElement, name: &str, warnings: &mut Vec<String>) -> Option<Dim> {
    let dim = svd_number(element, "dim").unwrap_or_default();
    if dim.is_zero() {
        return Some(Dim::single());
    }
    if dim > BigInt::from(MAX_SAFE) {
        warnings.push(format!("{name}: dim {dim} is too large to count; skipped"));
        return None;
    }
    let count = dim.to_usize().unwrap();
    let (index, range) = dim_index(count, child_text(element, "dimIndex").as_deref(), name, warnings);
    Some(Dim { count, step: svd_number(element, "dimIncrement").unwrap_or_default(), index, range })
}

/// The name of one copy: "[%s]" marks a C array; as separate values it becomes CCR0 … CCR3.
pub fn copy_name(name: &str, index: &str) -> String {
    name.replace("[%s]", index).replace("%s", index)
}

/// The name of the whole array, with its indices: "CCR[0-3]".
pub fn array_name(name: &str, dim: &Dim) -> String {
    if dim.count == 1 {
        return copy_name(name, &dim.index(0));
    }
    let indices = format!("[{}]", dim.range);
    if name.contains("%s") { name.replace("[%s]", &indices).replace("%s", &indices) } else { format!("{name}{indices}") }
}

// ------------------------------------------------------------ the device
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SvdEnum {
    pub value: BigInt,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SvdField {
    pub name: String,
    pub description: String,
    pub lsb: usize,
    pub msb: usize,
    /// SVD access, e.g. "read-only".
    pub access: String,
    pub enums: Rc<Vec<SvdEnum>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SvdRegister {
    /// Peripheral, clusters and register joined with ".".
    pub path: String,
    pub name: String,
    pub description: String,
    pub peripheral: String,
    pub peripheral_base: BigInt,
    pub peripheral_description: String,
    pub address: BigInt,
    pub size: usize,
    pub access: String,
    pub reset_value: BigInt,
    pub fields: Rc<Vec<SvdField>>,
    pub warnings: Rc<Vec<String>>,
    /// Where it sits in the file (see `in_file_order`).
    pub order: Vec<usize>,
}

#[derive(Clone, Debug)]
struct Level {
    name: String,
    dim: Dim,
    offset: BigInt,
    position: usize,
}

/// A register as the file describes it: one, or an array of copies.
#[derive(Clone, Debug)]
pub struct SvdRegisterArray {
    /// Path inside the peripheral: "CH[0-1].CFG".
    pub label: String,
    pub description: String,
    pub size: usize,
    /// Number of copies: 1 for a plain register.
    pub count: usize,
    pub fields: Rc<Vec<SvdField>>,
    pub warnings: Rc<Vec<String>>,
    access: String,
    reset_value: BigInt,
    path: Rc<Vec<Level>>,
    peripheral_base: BigInt,
    peripheral_description: String,
}

impl SvdRegisterArray {
    /// Copy `position` (0 … count-1); the innermost array changes fastest.
    pub fn at(&self, position: usize) -> SvdRegister {
        assert!(position < self.count, "{} has no copy {position}", self.label);
        let path = &self.path;
        let mut indices = vec![0; path.len()];
        let mut rest = position;
        for level in (0..path.len()).rev() {
            let count = path[level].dim.count;
            indices[level] = rest % count;
            rest /= count;
        }
        let names: Vec<String> = path.iter().zip(&indices).map(|(level, index)| copy_name(&level.name, &level.dim.index(*index))).collect();
        let peripheral_base = &self.peripheral_base + BigInt::from(indices[0]) * &path[0].dim.step;
        let mut address = peripheral_base.clone();
        for depth in 1..path.len() {
            address += &path[depth].offset + BigInt::from(indices[depth]) * &path[depth].dim.step;
        }
        SvdRegister {
            path: names.join("."),
            name: names.last().cloned().unwrap_or_default(),
            description: self.description.clone(),
            peripheral: names[0].clone(),
            peripheral_base,
            peripheral_description: self.peripheral_description.clone(),
            address,
            size: self.size,
            access: self.access.clone(),
            reset_value: self.reset_value.clone(),
            fields: self.fields.clone(),
            warnings: self.warnings.clone(),
            order: path.iter().zip(&indices).flat_map(|(level, index)| [level.position, *index]).collect(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SvdPeripheral {
    /// With its indices when it is an array: "TIM[2-5]".
    pub name: String,
    pub description: String,
    pub group_name: String,
    pub base_address: BigInt,
    pub count: usize,
    pub registers: Vec<SvdRegisterArray>,
}

#[derive(Clone, Debug)]
pub struct SvdDevice {
    pub name: String,
    pub description: String,
    pub peripherals: Vec<SvdPeripheral>,
    /// Problems that didn't stop the import.
    pub warnings: Vec<String>,
}

#[derive(Clone)]
struct Inherited {
    size: usize,
    access: String,
    reset_value: BigInt,
    reset_mask: Option<BigInt>,
}

fn inherit(element: &XmlElement, parent: &Inherited) -> Inherited {
    Inherited {
        size: svd_number(element, "size").map_or(parent.size, |size| size.to_usize().unwrap_or(usize::MAX)),
        access: child_text(element, "access").unwrap_or_else(|| parent.access.clone()),
        reset_value: svd_number(element, "resetValue").unwrap_or_else(|| parent.reset_value.clone()),
        reset_mask: svd_number(element, "resetMask").or_else(|| parent.reset_mask.clone()),
    }
}

/// An element with the children of the one it derives from, for those it
/// doesn't give itself.
fn merged<'s>(element: &Rc<XmlElement<'s>>, base: Option<&Rc<XmlElement<'s>>>) -> Rc<XmlElement<'s>> {
    let Some(base) = base else { return element.clone() };
    let own: std::collections::HashSet<&str> = element.children.iter().map(|item| item.name.as_ref()).collect();
    let mut out = XmlElement::clone(element);
    out.children = base.children.iter().filter(|item| !own.contains(item.name.as_ref())).cloned().chain(element.children.iter().cloned()).collect();
    Rc::new(out)
}

/// The element `derivedFrom` names: first among `siblings`, then by its last
/// dotted part anywhere.
fn find_base<'a, 's>(reference: Option<&String>, siblings: &'a [Rc<XmlElement<'s>>], everything: &'a [Rc<XmlElement<'s>>]) -> Option<&'a Rc<XmlElement<'s>>> {
    let reference = reference?;
    let last = reference.rsplit('.').next().unwrap_or("").trim();
    let by_name = |candidate: &&Rc<XmlElement>| child_text(candidate, "name").as_deref() == Some(last);
    siblings.iter().find(by_name).or_else(|| everything.iter().find(by_name))
}

fn all_named<'s>(root: &XmlElement<'s>, name: &str, out: &mut Vec<Rc<XmlElement<'s>>>) {
    for item in &root.children {
        if item.name.as_ref() == name {
            out.push(item.clone());
        }
        all_named(item, name, out);
    }
}

#[derive(Debug)]
pub enum SvdError {
    Xml(XmlError),
    NotSvd(String),
}

impl std::fmt::Display for SvdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SvdError::Xml(error) => error.fmt(f),
            SvdError::NotSvd(reason) => f.write_str(reason),
        }
    }
}

struct Reader<'s> {
    root: Rc<XmlElement<'s>>,
    warnings: Vec<String>,
    /// Every element of a kind, for derivedFrom; collected once, shared.
    all: HashMap<&'static str, Rc<Vec<Rc<XmlElement<'s>>>>>,
    /// Equal enumerated-value lists, kept once (most fields repeat a few).
    enum_lists: std::collections::HashSet<Rc<Vec<SvdEnum>>>,
}

impl<'s> Reader<'s> {
    fn all(&mut self, name: &'static str) -> Rc<Vec<Rc<XmlElement<'s>>>> {
        if !self.all.contains_key(name) {
            let mut out = Vec::new();
            all_named(&self.root, name, &mut out);
            self.all.insert(name, Rc::new(out));
        }
        self.all[name].clone()
    }

    fn device(mut self) -> SvdDevice {
        let root = self.root.clone();
        let device_props = inherit(&root, &Inherited { size: 32, access: "read-write".into(), reset_value: BigInt::zero(), reset_mask: None });
        let elements: Vec<Rc<XmlElement>> = children(child(&root, "peripherals"), "peripheral").cloned().collect();
        let mut peripherals = Vec::new();
        for (position, raw) in elements.iter().enumerate() {
            let element = merged(raw, find_base(raw.attributes.get("derivedFrom"), &elements, &[]));
            let props = inherit(&element, &device_props);
            let name = text(&element, "name");
            let Some(dim) = read_dim(&element, &name, &mut self.warnings) else { continue };
            let base_address = svd_number(&element, "baseAddress").unwrap_or_default();
            let description = text(&element, "description");
            let mut registers = Vec::new();
            if let Some(container) = child(&element, "registers").cloned() {
                let levels = vec![Level { name: name.clone(), dim: dim.clone(), offset: BigInt::zero(), position }];
                self.read_registers(&container, (&base_address, &description), levels, &props, &mut registers);
            }
            peripherals.push(SvdPeripheral {
                name: array_name(&name, &dim),
                description,
                group_name: text(&element, "groupName"),
                base_address,
                count: dim.count,
                registers,
            });
        }
        let name = text(&root, "name");
        SvdDevice { name: if name.is_empty() { "Device".into() } else { name }, description: text(&root, "description"), peripherals, warnings: self.warnings }
    }

    fn read_registers(
        &mut self,
        container: &XmlElement,
        peripheral: (&BigInt, &String),
        levels: Vec<Level>,
        props: &Inherited,
        out: &mut Vec<SvdRegisterArray>,
    ) {
        let items: Vec<Rc<XmlElement>> =
            container.children.iter().filter(|item| item.name.as_ref() == "register" || item.name.as_ref() == "cluster").cloned().collect();
        let label_of = |path: &[Level]| path.iter().map(|level| array_name(&level.name, &level.dim)).collect::<Vec<_>>().join(".");
        for (position, raw) in items.iter().enumerate() {
            let is_cluster = raw.name.as_ref() == "cluster";
            let everything = if raw.attributes.contains_key("derivedFrom") { self.all(if is_cluster { "cluster" } else { "register" }) } else { Rc::default() };
            let element = merged(raw, find_base(raw.attributes.get("derivedFrom"), &items, &everything));
            let own = inherit(&element, props);
            let name = text(&element, "name");
            let Some(dim) = read_dim(&element, &format!("{}.{name}", label_of(&levels)), &mut self.warnings) else { continue };
            let mut path = levels.clone();
            path.push(Level { name, dim, offset: svd_number(&element, "addressOffset").unwrap_or_default(), position });
            let label = label_of(&path);
            if is_cluster {
                self.read_registers(&element, peripheral, path, &own, out);
                continue;
            }
            if own.size < 1 || own.size > MAX_WIDTH {
                self.warnings.push(format!("{label}: {} bits is outside 1–{MAX_WIDTH}; skipped", own.size));
                continue;
            }
            let copies = path.iter().fold(BigInt::one(), |total, level| total * level.dim.count);
            if copies > BigInt::from(MAX_SAFE) {
                self.warnings.push(format!("{label}: {copies} copies are too many to count; skipped"));
                continue;
            }
            // every copy has the same fields, so they are read once
            let mut warnings = Vec::new();
            let fields = self.read_fields(&element, &own.access, own.size, &mut warnings);
            let fields = fit_fields(fields, own.size, &mut warnings);
            let size_mask: BigInt = (BigInt::one() << own.size) - 1;
            let reset_value = &own.reset_value & own.reset_mask.clone().unwrap_or_else(|| size_mask.clone()) & &size_mask;
            out.push(SvdRegisterArray {
                label: label_of(&path[1..]),
                description: text(&element, "description"),
                size: own.size,
                count: copies.to_usize().unwrap(),
                fields: Rc::new(fields),
                warnings: Rc::new(warnings),
                access: own.access.clone(),
                reset_value,
                path: Rc::new(path),
                peripheral_base: peripheral.0.clone(),
                peripheral_description: peripheral.1.clone(),
            });
        }
    }

    fn read_fields(&mut self, register: &XmlElement, access: &str, size: usize, warnings: &mut Vec<String>) -> Vec<SvdField> {
        let elements: Vec<Rc<XmlElement>> = children(child(register, "fields"), "field").cloned().collect();
        let everything = if elements.iter().any(|field| field.attributes.contains_key("derivedFrom")) { self.all("field") } else { Rc::default() };
        let mut out = Vec::new();
        for raw in &elements {
            let field = merged(raw, find_base(raw.attributes.get("derivedFrom"), &elements, &everything));
            let base_name = text(&field, "name");
            let number = |name: &str| svd_number(&field, name).and_then(|n| n.to_i64());
            let bit_range = child_text(&field, "bitRange").and_then(|range| {
                let inner = range.strip_prefix('[')?.strip_suffix(']')?;
                let (hi, lo) = inner.split_once(':')?;
                let all_digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
                (all_digits(hi) && all_digits(lo)).then(|| (hi.parse::<i64>().ok(), lo.parse::<i64>().ok()))
            });
            let (lsb, width) = if let Some((Some(hi), Some(lo))) = bit_range {
                (Some(lo), Some(hi - lo + 1))
            } else if child(&field, "lsb").is_some() && child(&field, "msb").is_some() {
                let lsb = number("lsb");
                (lsb, number("msb").zip(lsb).map(|(msb, lsb)| msb - lsb + 1))
            } else if child(&field, "bitOffset").is_some() {
                (number("bitOffset"), Some(number("bitWidth").unwrap_or(1)))
            } else {
                (None, None)
            };
            let (Some(lsb), Some(width)) = (lsb, width) else {
                warnings.push(format!("{base_name}: no usable bit position"));
                continue;
            };
            if width < 1 || lsb < 0 {
                warnings.push(format!("{base_name}: no usable bit position"));
                continue;
            }
            let (lsb, width) = (lsb as usize, width as usize);
            let Some(dim) = read_dim(&field, &base_name, warnings) else { continue };
            let step = dim.step.to_usize().unwrap_or(0);
            // a register has at most 512 bits: only the first copies of a big field array fit
            let fit = if step > 0 { dim.count.min((size.saturating_sub(lsb)).div_ceil(step).max(1)) } else { 1 };
            if fit < dim.count {
                warnings.push(format!(
                    "{}: {} more {}, so they were left out",
                    array_name(&base_name, &dim),
                    dim.count - fit,
                    if step > 0 { format!("copies would be outside the {size}-bit register") } else { "copies would overlap the first".into() }
                ));
            }
            let enums = self.read_enums(&field);
            let enums = match self.enum_lists.get(&enums) {
                Some(shared) => shared.clone(),
                None => {
                    let shared = Rc::new(enums);
                    self.enum_lists.insert(shared.clone());
                    shared
                }
            };
            for index in 0..fit {
                let field_lsb = lsb + index * step;
                out.push(SvdField {
                    name: copy_name(&base_name, &dim.index(index)),
                    description: text(&field, "description"),
                    lsb: field_lsb,
                    msb: field_lsb + width - 1,
                    access: child_text(&field, "access").unwrap_or_else(|| access.to_string()),
                    enums: enums.clone(),
                });
            }
        }
        out
    }

    fn read_enums(&mut self, field: &XmlElement) -> Vec<SvdEnum> {
        let derived = field.children.iter().any(|item| item.name.as_ref() == "enumeratedValues" && item.attributes.contains_key("derivedFrom"));
        let everything = if derived { self.all("enumeratedValues") } else { Rc::default() };
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for list in field.children.iter().filter(|item| item.name.as_ref() == "enumeratedValues") {
            let resolved = merged(list, find_base(list.attributes.get("derivedFrom"), &[], &everything));
            for item in resolved.children.iter().filter(|item| item.name.as_ref() == "enumeratedValue") {
                // isDefault entries have no value
                let Some(value_text) = child_text(item, "value") else { continue };
                let Some(values) = enum_values(&value_text) else { continue };
                for value in values {
                    // read and write lists often repeat
                    if !seen.insert(value.clone()) {
                        continue;
                    }
                    let name = text(item, "name");
                    out.push(SvdEnum { value, name: if name.is_empty() { value_text.clone() } else { name }, description: text(item, "description") });
                }
            }
        }
        out
    }
}

/// Drops fields outside the register or overlapping an earlier one.
fn fit_fields(fields: Vec<SvdField>, size: usize, warnings: &mut Vec<String>) -> Vec<SvdField> {
    let mut kept: Vec<SvdField> = Vec::new();
    for field in fields {
        if field.msb >= size {
            warnings.push(format!("{} [{}:{}] is outside the {size}-bit register", field.name, field.msb, field.lsb));
            continue;
        }
        if let Some(clash) = kept.iter().find(|other| !(other.msb < field.lsb || other.lsb > field.msb)) {
            warnings.push(format!("{} overlaps {}, so it was left out", field.name, clash.name));
            continue;
        }
        kept.push(field);
    }
    kept
}

/// Reads a CMSIS-SVD file.
pub fn parse_svd(source: &str) -> Result<SvdDevice, SvdError> {
    let root = parse_xml(source).map_err(SvdError::Xml)?;
    if root.name.as_ref() != "device" {
        return Err(SvdError::NotSvd(format!("This is not a CMSIS-SVD file (it starts with <{}>, not <device>)", root.name)));
    }
    Ok(Reader { root, warnings: Vec::new(), all: HashMap::new(), enum_lists: Default::default() }.device())
}

/// Whether a file looks like an SVD (by name, or by its start).
pub fn looks_like_svd(name: &str, text: &str) -> bool {
    name.to_lowercase().ends_with(".svd") || {
        let start: String = text.chars().take(2048).collect();
        start.contains("<device") && !start.trim_start().starts_with('{')
    }
}

// ------------------------------------------------------------ picking copies
/// Positions 0 … limit-1 as sorted, separate [start, end) ranges.
#[derive(Clone, Debug, PartialEq)]
pub struct IndexSet {
    pub limit: usize,
    ranges: Vec<(usize, usize)>,
}

impl IndexSet {
    pub fn new(limit: usize) -> IndexSet {
        IndexSet { limit, ranges: Vec::new() }
    }

    pub fn all(limit: usize) -> IndexSet {
        let mut set = IndexSet::new(limit);
        set.set_range(0, limit, true);
        set
    }

    /// Reads "0-15, 32, 40-47"; the problem as text when it can't.
    pub fn parse(text: &str, limit: usize) -> Result<IndexSet, String> {
        let mut set = IndexSet::new(limit);
        let mut normalized = String::new();
        for part in text.split('-') {
            if !normalized.is_empty() {
                normalized = normalized.trim_end().to_string();
                normalized.push('-');
                normalized.push_str(part.trim_start());
            } else {
                normalized.push_str(part);
            }
        }
        for part in normalized.split(|c: char| c == ',' || c.is_whitespace()).filter(|part| !part.is_empty()) {
            let (first, last) = match part.split_once('-') {
                Some((a, b)) => (a, Some(b)),
                None => (part, None),
            };
            let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
            if !digits(first) || last.is_some_and(|last| !digits(last)) {
                return Err(format!("\"{part}\" is not a position or a range like 0-7"));
            }
            let first: usize = first.parse().unwrap_or(usize::MAX);
            let last: usize = last.map_or(first, |last| last.parse().unwrap_or(usize::MAX));
            if last < first {
                return Err(format!("{part} runs backwards"));
            }
            if last >= limit {
                return Err(format!("{last} is past the last copy ({})", limit.saturating_sub(1)));
            }
            set.set_range(first, last + 1, true);
        }
        Ok(set)
    }

    pub fn size(&self) -> usize {
        self.ranges.iter().map(|(start, end)| end - start).sum()
    }

    pub fn has(&self, position: usize) -> bool {
        self.ranges.iter().any(|(start, end)| position >= *start && position < *end)
    }

    /// Picks (or unpicks) positions start … end-1.
    pub fn set_range(&mut self, start: usize, end: usize, on: bool) {
        let end = end.min(self.limit);
        if start >= end {
            return;
        }
        let mut next = Vec::new();
        for &(from, to) in &self.ranges {
            if to <= start || from >= end {
                next.push((from, to));
                continue;
            }
            if from < start {
                next.push((from, start));
            }
            if to > end {
                next.push((end, to));
            }
        }
        if on {
            next.push((start, end));
        }
        next.sort();
        self.ranges.clear();
        for range in next {
            match self.ranges.last_mut() {
                Some(last) if range.0 <= last.1 => last.1 = last.1.max(range.1),
                _ => self.ranges.push(range),
            }
        }
    }

    pub fn set(&mut self, position: usize, on: bool) {
        self.set_range(position, position + 1, on);
    }

    pub fn fill(&mut self, on: bool) {
        self.ranges = if on && self.limit > 0 { vec![(0, self.limit)] } else { Vec::new() };
    }

    pub fn iter(&self) -> impl Iterator<Item = usize> + '_ {
        self.ranges.iter().flat_map(|(start, end)| *start..*end)
    }
}

impl std::fmt::Display for IndexSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let parts: Vec<String> =
            self.ranges.iter().map(|(start, end)| if end - start == 1 { start.to_string() } else { format!("{start}-{}", end - 1) }).collect();
        f.write_str(&parts.join(", "))
    }
}

/// Registers sorted the way the file lists them.
pub fn in_file_order(mut registers: Vec<SvdRegister>) -> Vec<SvdRegister> {
    registers.sort_by(|a, b| a.order.cmp(&b.order));
    registers
}

/// The picked copies of each array, made into registers, in file order.
pub fn picked_registers(picks: &[(&SvdRegisterArray, &IndexSet)]) -> Vec<SvdRegister> {
    let registers = picks.iter().flat_map(|(array, positions)| positions.iter().map(|position| array.at(position))).collect();
    in_file_order(registers)
}

// ------------------------------------------------------------ as templates
/// An address as eight hex digits: 0x40011000.
pub fn hex_address(address: &BigInt) -> String {
    format!("0x{:0>8}", address.to_str_radix(16).to_uppercase())
}

/// A register as a field template (the same shape the app saves).
pub fn register_template(register: &SvdRegister, device_name: &str) -> Template {
    let mut fields: Vec<&SvdField> = register.fields.iter().collect();
    fields.sort_by_key(|field| std::cmp::Reverse(field.msb));
    let reset = format!("0x{}", register.reset_value.to_str_radix(16).to_uppercase());
    let description = [hex_address(&register.address), register.description.clone(), format!("reset {reset}")]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    Template {
        name: format!("{device_name} {}", register.path),
        width: register.size,
        description: Some(description),
        fields: fields
            .iter()
            .enumerate()
            .map(|(index, field)| TemplateField {
                lo: field.lsb,
                hi: field.msb,
                name: field.name.clone(),
                color: Some(FIELD_COLORS[index % FIELD_COLORS.len()].to_string()),
                base: None,
                details: DetailsDraft {
                    description: (!field.description.is_empty()).then(|| field.description.as_str().into()),
                    access: Some(if field.name.to_lowercase().starts_with("reserved") {
                        Access::Reserved
                    } else if field.access == "read-only" {
                        Access::ReadOnly
                    } else {
                        Access::ReadWrite
                    }),
                    named: (!field.enums.is_empty()).then(|| field.enums.iter().map(|item| (item.value.clone(), item.name.as_str().into())).collect()),
                    ..Default::default()
                },
            })
            .collect(),
        builtin: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0"?>
<!-- a comment -->
<device><name>CHIP</name><size>32</size><resetValue>0</resetValue>
<peripherals>
 <peripheral><name>UART0</name><description>Serial &amp; more</description><baseAddress>0x40000000</baseAddress>
  <registers>
   <register><name>CTRL</name><addressOffset>0x4</addressOffset><resetValue>0x0000_00FF</resetValue>
     <fields>
       <field><name>EN</name><bitRange>[0:0]</bitRange></field>
       <field><name>MODE</name><lsb>1</lsb><msb>2</msb><access>read-only</access>
         <enumeratedValues><enumeratedValue><name>FAST</name><value>#1x</value></enumeratedValue></enumeratedValues></field>
       <field><name>CLASH</name><bitOffset>2</bitOffset><bitWidth>2</bitWidth></field>
     </fields></register>
   <cluster><dim>2</dim><dimIncrement>0x10</dimIncrement><name>CH%s</name><addressOffset>0x10</addressOffset>
     <register><dim>3</dim><dimIncrement>4</dimIncrement><dimIndex>A-C</dimIndex><name>CFG%s</name><addressOffset>0</addressOffset></register>
   </cluster>
  </registers></peripheral>
 <peripheral derivedFrom="UART0"><name>UART1</name><baseAddress>0x40001000</baseAddress></peripheral>
</peripherals></device>"#;

    #[test]
    fn reads_devices_arrays_and_fields() {
        let device = parse_svd(SAMPLE).unwrap();
        assert_eq!(device.name, "CHIP");
        assert_eq!(device.peripherals.len(), 2);
        let uart = &device.peripherals[0];
        assert_eq!(uart.description, "Serial & more");
        let ctrl = uart.registers[0].at(0);
        assert_eq!(ctrl.path, "UART0.CTRL");
        assert_eq!(ctrl.address, BigInt::from(0x4000_0004u32));
        assert_eq!(ctrl.fields.len(), 2);
        assert_eq!(ctrl.warnings[0], "CLASH overlaps MODE, so it was left out");
        assert_eq!(ctrl.fields[1].enums.len(), 2);
        let cfg = &uart.registers[1];
        assert_eq!(cfg.label, "CH[0-1].CFG[A-C]");
        assert_eq!(cfg.count, 6);
        let last = cfg.at(5);
        assert_eq!(last.path, "UART0.CH1.CFGC");
        assert_eq!(last.address, BigInt::from(0x4000_0000u32 + 0x10 + 0x10 + 8));
        // derivedFrom copies the registers
        assert_eq!(device.peripherals[1].registers[0].at(0).address, BigInt::from(0x4000_1004u32));
        assert!(parse_svd("<x/>").is_err());
        assert_eq!(parse_svd("<device><a></b></device>").unwrap_err().to_string(), "Line 1: </b> closes <a>");
    }

    #[test]
    fn numbers_dims_and_selections() {
        assert_eq!(parse_svd_number(Some("0x1F")), Some(BigInt::from(31)));
        assert_eq!(parse_svd_number(Some("#101")), Some(BigInt::from(5)));
        assert_eq!(parse_svd_number(Some("4k")), Some(BigInt::from(4096)));
        assert_eq!(parse_svd_number(Some("x")), None);
        assert_eq!(enum_values("#1x0").unwrap(), vec![BigInt::from(4), BigInt::from(6)]);
        let set = IndexSet::parse("0-3, 8 , 10 - 11", 16).unwrap();
        assert_eq!(set.to_string(), "0-3, 8, 10-11");
        assert_eq!(set.size(), 7);
        assert_eq!(IndexSet::parse("5-2", 16).unwrap_err(), "5-2 runs backwards");
        assert_eq!(IndexSet::parse("20", 16).unwrap_err(), "20 is past the last copy (15)");
        assert_eq!(copy_name("CCR[%s]", "3"), "CCR3");
    }
}
