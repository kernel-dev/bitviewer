//! Comparing a peripheral's registers with other values for them (a
//! peripheral snapshot, or the same registers in another workspace): which
//! registers differ, and which of their fields.

use std::sync::Arc;

use crate::integers::{Bits, mask};
use crate::value::Value;

/// A field whose bits differ.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldChange {
    /// Index into the register's fields.
    pub index: usize,
    pub name: Arc<str>,
    /// The field's bits in the other value, and now (shifted down to bit 0).
    pub then: Bits,
    pub now: Bits,
}

/// A register whose value differs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegisterChange {
    /// Index of the value in the workspace.
    pub value_index: usize,
    pub name: Arc<str>,
    pub width: usize,
    pub then: Bits,
    pub now: Bits,
    pub fields: Vec<FieldChange>,
}

impl RegisterChange {
    /// How many bits differ.
    pub fn bits(&self) -> usize {
        (self.then ^ self.now).count_ones()
    }
}

/// The result of a comparison.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Diff {
    pub changes: Vec<RegisterChange>,
    /// Registers that were compared and are the same.
    pub same: usize,
    /// Registers the other side has no value for.
    pub missing: Vec<Arc<str>>,
}

/// Compares `values` (index in the workspace, value) with what `other` gives
/// for each of them (None: the other side doesn't have that register).
pub fn diff<'a>(values: impl IntoIterator<Item = (usize, &'a Value)>, other: impl Fn(&Value) -> Option<Bits>) -> Diff {
    let mut out = Diff::default();
    for (value_index, value) in values {
        let Some(then) = other(value).map(|bits| bits & mask(value.width)) else {
            out.missing.push(value.name.clone());
            continue;
        };
        if then == value.value {
            out.same += 1;
            continue;
        }
        let fields = value
            .fields
            .iter()
            .enumerate()
            .filter_map(|(index, field)| {
                let part = |bits: Bits| (bits >> field.lo) & mask(field.width());
                let (then, now) = (part(then), part(value.value));
                (then != now).then(|| FieldChange { index, name: field.name.clone(), then, now })
            })
            .collect();
        out.changes.push(RegisterChange { value_index, name: value.name.clone(), width: value.width, then, now: value.value, fields });
    }
    out
}

/// The comparison as a plain-text table (for a bug report): one line per
/// register, indented lines for its fields.
pub fn diff_text(diff: &Diff, then_label: &str, values: &[Arc<Value>]) -> String {
    use crate::integers::{Base, format_int};
    let mut rows: Vec<(String, String, String)> = Vec::new();
    for change in &diff.changes {
        let hex = |bits: Bits| format_int(bits, Base::Hex, change.width, true, false);
        rows.push((change.name.to_string(), hex(change.then), hex(change.now)));
        let value = values.get(change.value_index);
        for field in &change.fields {
            let shown = |bits: Bits| {
                let target = value.and_then(|value| value.fields.get(field.index));
                let width = target.map_or(1, |field| field.width());
                let number = format_int(bits, Base::Hex, width, true, false);
                match target.and_then(|target| target.name_of(bits)) {
                    Some(label) => format!("{number} {label}"),
                    None => number,
                }
            };
            rows.push((format!("  {}", field.name), shown(field.then), shown(field.now)));
        }
    }
    let header = ("Register / field".to_string(), then_label.to_string(), "Now".to_string());
    let widths = std::iter::once(&header).chain(&rows).fold((0, 0), |(a, b), (name, then, _)| (a.max(name.chars().count()), b.max(then.chars().count())));
    let line = |(name, then, now): &(String, String, String)| format!("{name:<w0$}  {then:<w1$}  {now}", w0 = widths.0, w1 = widths.1).trim_end().to_string();
    let mut out: Vec<String> = std::iter::once(&header).chain(&rows).map(line).collect();
    out.push(format!("{} of {} registers differ", diff.changes.len(), diff.changes.len() + diff.same + diff.missing.len()));
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integers::Base;
    use crate::rows::View;

    fn register(name: &str, bits: u32) -> Value {
        let mut value = Value::new(32, Bits::from(bits), name, View::Line, Base::Hex).unwrap();
        value.add_field(4, 15, Some("MANTISSA"), None, None).unwrap();
        value.add_field(0, 3, Some("FRACTION"), None, None).unwrap();
        value
    }

    #[test]
    fn finds_changed_registers_and_fields() {
        let values = [register("BRR", 0x341), register("CR1", 0x200C), register("SR", 0xC0)];
        let then = |value: &Value| match &*value.name {
            "BRR" => Some(Bits::from(0x683u32)),
            "CR1" => Some(Bits::from(0x200Cu32)),
            _ => None,
        };
        let diff = diff(values.iter().enumerate(), then);
        assert_eq!(diff.same, 1);
        assert_eq!(diff.missing, vec![Arc::<str>::from("SR")]);
        assert_eq!(diff.changes.len(), 1);
        let brr = &diff.changes[0];
        assert_eq!((brr.value_index, brr.then, brr.now), (0, Bits::from(0x683u32), Bits::from(0x341u32)));
        assert_eq!(brr.bits(), (0x683u32 ^ 0x341).count_ones() as usize);
        let names: Vec<&str> = brr.fields.iter().map(|field| &*field.name).collect();
        assert_eq!(names, ["MANTISSA", "FRACTION"]);
        assert_eq!((brr.fields[0].then, brr.fields[0].now), (Bits::from(0x68u32), Bits::from(0x34u32)));

        let shared: Vec<Arc<Value>> = values.into_iter().map(Arc::new).collect();
        let text = diff_text(&diff, "Snapshot", &shared);
        assert!(
            text.starts_with(
                "Register / field  Snapshot    Now
BRR               0x00000683  0x00000341"
            ),
            "{text}"
        );
        assert!(text.contains("BRR"), "{text}");
        assert!(text.contains("  MANTISSA"), "{text}");
        assert!(text.ends_with("1 of 3 registers differ"), "{text}");
    }
}
