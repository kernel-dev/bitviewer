//! One value of 1 to 512 bits with its display settings, compare rows,
//! register fields, snapshots and peripheral placement.
//!
//! Bit numbering is global: bit 0 is the LSB of the whole value. A *row* is
//! the whole value ("line" view), a byte or a nibble, identified by its lowest
//! bit `lo` (see rows.rs). Fields are inclusive bit ranges [lo, hi] and may
//! span rows. Edits return whether anything changed, so the workspace knows
//! when to record an undo step and redraw.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use super::ModelError;
use super::field::{self, DetailsDraft, Field};
use super::integers::{Base, Bits, MAX_WIDTH, MIN_WIDTH, mask};
use super::ops::{Op, apply_op};
use super::rows::{View, remap_row_bases, remap_rows, row_width_for};
use super::templates::Template;

/// A named copy of a value at some moment.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub name: Arc<str>,
    pub value: Bits,
    /// Milliseconds since the Unix epoch.
    pub at: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Value {
    /// Stays the same through edits (and undo), so the UI can follow a value
    /// when others are added or removed around it. Not saved in files.
    pub id: ValueId,
    pub width: usize,
    pub value: Bits,
    pub name: Arc<str>,
    pub view: View,
    pub msb_first: bool,
    pub full_base: Base,
    pub default_row_base: Base,
    /// Optional panel with the value in every base.
    pub show_bases: bool,
    /// The card shows only its header.
    pub collapsed: bool,
    /// Name of the peripheral this value is a register of ("" = none).
    pub block: Arc<str>,
    /// Address offset of the register within its peripheral, in bytes.
    pub offset: Option<u64>,
    /// What the register is for (e.g. from an SVD file).
    pub description: Arc<str>,
    /// Named copies of the value, oldest first.
    pub snapshots: Vec<Snapshot>,
    pub row_bases: BTreeMap<usize, Base>,
    pub fields: Vec<Field>,
    pub compares: BTreeMap<usize, Bits>,
    /// Values of closed compare rows, restored when the row is opened again.
    pub hidden_compares: BTreeMap<usize, Bits>,
}

/// A value's identity for the life of the app.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ValueId(pub u64);

impl ValueId {
    pub fn fresh() -> ValueId {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        ValueId(NEXT.fetch_add(1, Ordering::Relaxed))
    }
}

pub fn check_width(width: usize) -> Result<(), ModelError> {
    if (MIN_WIDTH..=MAX_WIDTH).contains(&width) {
        Ok(())
    } else {
        Err(ModelError::new(format!("Width must be a whole number of bits from {MIN_WIDTH} to {MAX_WIDTH}")))
    }
}

impl Value {
    pub fn new(width: usize, value: Bits, name: &str, view: View, default_row_base: Base) -> Result<Value, ModelError> {
        check_width(width)?;
        Ok(Value {
            id: ValueId::fresh(),
            width,
            value: value & mask(width),
            name: name.into(),
            view,
            msb_first: true,
            full_base: Base::Hex,
            default_row_base,
            show_bases: false,
            collapsed: false,
            block: "".into(),
            offset: None,
            description: "".into(),
            snapshots: Vec::new(),
            row_bases: BTreeMap::new(),
            fields: Vec::new(),
            compares: BTreeMap::new(),
            hidden_compares: BTreeMap::new(),
        })
    }

    // ------------------------------------------------------------ geometry
    pub fn mask(&self) -> Bits {
        mask(self.width)
    }

    /// Nominal row width for the view (the top row can be shorter).
    pub fn row_width(&self) -> usize {
        row_width_for(self.view, self.width)
    }

    /// Bits in the row starting at `lo`; only the top row can be partial.
    pub fn row_width_at(&self, lo: usize) -> usize {
        self.row_width().min(self.width - lo)
    }

    /// Row start bits in display order.
    pub fn row_los(&self) -> Vec<usize> {
        let mut starts: Vec<usize> = (0..self.width).step_by(self.row_width()).collect();
        if self.msb_first {
            starts.reverse();
        }
        starts
    }

    pub fn row_title(&self, lo: usize) -> String {
        match self.view {
            View::Line => format!("Bits {}…0", self.width - 1),
            View::Byte => format!("Byte {}", lo / self.row_width()),
            View::Nibble => format!("Nibble {}", lo / self.row_width()),
        }
    }

    /// Fails unless `lo` starts a row in the current view.
    pub fn check_row(&self, lo: usize) -> Result<(), ModelError> {
        if !lo.is_multiple_of(self.row_width()) || lo >= self.width { Err(ModelError::new(format!("{lo} is not a row start for this view"))) } else { Ok(()) }
    }

    fn check_bit(&self, bit: usize) -> Result<(), ModelError> {
        if bit >= self.width { Err(ModelError::new(format!("Bit {bit} out of range"))) } else { Ok(()) }
    }

    // ------------------------------------------------------------ meta / bases
    pub fn set_name(&mut self, name: &str) -> bool {
        if &*self.name == name {
            return false;
        }
        self.name = name.into();
        true
    }

    pub fn set_full_base(&mut self, base: Base) -> bool {
        std::mem::replace(&mut self.full_base, base) != base
    }

    pub fn row_base(&self, lo: usize) -> Base {
        self.row_bases.get(&lo).copied().unwrap_or(self.default_row_base)
    }

    pub fn set_row_base(&mut self, lo: usize, base: Base) -> Result<bool, ModelError> {
        self.check_row(lo)?;
        if self.row_base(lo) == base {
            return Ok(false);
        }
        self.row_bases.insert(lo, base);
        Ok(true)
    }

    pub fn set_all_row_bases(&mut self, base: Base) -> bool {
        let changed = self.default_row_base != base || !self.row_bases.is_empty();
        self.default_row_base = base;
        self.row_bases.clear();
        changed
    }

    // ------------------------------------------------------------ bits
    pub fn bit(&self, index: usize) -> bool {
        self.value.bit(index)
    }

    pub fn set_value(&mut self, value: Bits) -> bool {
        let value = value & self.mask();
        std::mem::replace(&mut self.value, value) != value
    }

    pub fn flip_bit(&mut self, index: usize) -> Result<bool, ModelError> {
        self.check_bit(index)?;
        let mut value = self.value;
        value.set_bit(index, !value.bit(index));
        Ok(self.set_value(value))
    }

    pub fn bits_value(&self, lo: usize, width: usize) -> Bits {
        (self.value >> lo) & mask(width)
    }

    /// The whole value with bits lo … lo+width-1 replaced by `value` (nothing is changed).
    pub fn with_bits(&self, lo: usize, width: usize, value: Bits) -> Bits {
        let part = mask(width);
        ((self.value & !(part << lo)) | ((value & part) << lo)) & self.mask()
    }

    pub fn set_bits_value(&mut self, lo: usize, width: usize, value: Bits) -> bool {
        self.set_value(self.with_bits(lo, width, value))
    }

    pub fn row_value(&self, lo: usize) -> Bits {
        self.bits_value(lo, self.row_width_at(lo))
    }

    pub fn set_row_value(&mut self, lo: usize, value: Bits) -> Result<bool, ModelError> {
        self.check_row(lo)?;
        Ok(self.set_bits_value(lo, self.row_width_at(lo), value))
    }

    // ------------------------------------------------------------ operations
    pub fn op_value(&mut self, op: Op, argument: Option<Bits>) -> Result<bool, ModelError> {
        let next = apply_op(op, self.value, self.width, argument)?;
        Ok(self.set_value(next))
    }

    pub fn op_row(&mut self, lo: usize, op: Op, argument: Option<Bits>) -> Result<bool, ModelError> {
        let next = apply_op(op, self.row_value(lo), self.row_width_at(lo), argument)?;
        self.set_row_value(lo, next)
    }

    pub fn op_compare(&mut self, lo: usize, op: Op, argument: Option<Bits>) -> Result<bool, ModelError> {
        let next = apply_op(op, self.compare_value(lo)?, self.row_width_at(lo), argument)?;
        self.set_compare(lo, next)
    }

    /// Applies `op` to the bits lo..=hi only (e.g. a selection).
    pub fn op_bits(&mut self, lo: usize, hi: usize, op: Op, argument: Option<Bits>) -> Result<bool, ModelError> {
        let width = hi - lo + 1;
        let next = apply_op(op, self.bits_value(lo, width), width, argument)?;
        Ok(self.set_bits_value(lo, width, next))
    }

    // ------------------------------------------------------------ view / order
    pub fn set_view(&mut self, view: View) -> bool {
        if view == self.view {
            return false;
        }
        let old = self.row_width();
        let new = row_width_for(view, self.width);
        let compares = remap_rows(self.value, self.width, &self.compares, old, new);
        let mut hidden = remap_rows(self.value, self.width, &self.hidden_compares, old, new);
        hidden.retain(|lo, _| !compares.contains_key(lo)); // an open row wins
        self.row_bases = remap_row_bases(&self.row_bases, self.width, old, new);
        self.view = view;
        self.compares = compares;
        self.hidden_compares = hidden;
        true
    }

    /// Smallest width that keeps every field.
    pub fn min_width_for_fields(&self) -> usize {
        self.fields.iter().map(|field| field.hi + 1).max().unwrap_or(MIN_WIDTH).max(MIN_WIDTH)
    }

    /// Resizes the value. High bits are cut off (or added as 0) and compare
    /// rows that no longer fit are dropped. Fields are never dropped
    /// implicitly: shrinking below a field is refused.
    pub fn set_width(&mut self, width: usize) -> Result<bool, ModelError> {
        check_width(width)?;
        if width == self.width {
            return Ok(false);
        }
        let beyond: Vec<String> = self.fields.iter().filter(|field| field.hi >= width).map(|field| format!("{} {}", field.name, field.label())).collect();
        if !beyond.is_empty() {
            return Err(ModelError::new(format!("Fields {} don't fit in {width} bits", beyond.join(", "))));
        }

        self.width = width;
        self.value &= self.mask();
        let row_width = self.row_width();
        let fits = |lo: &usize| *lo < width && lo.is_multiple_of(row_width);
        let refit = |rows: &BTreeMap<usize, Bits>, this: &Value| -> BTreeMap<usize, Bits> {
            rows.iter().filter(|(lo, _)| fits(lo)).map(|(&lo, &value)| (lo, value & mask(this.row_width_at(lo)))).collect()
        };
        self.compares = refit(&self.compares, self);
        self.hidden_compares = refit(&self.hidden_compares, self);
        self.row_bases.retain(|lo, _| fits(lo));
        Ok(true)
    }

    /// Fields that block `set_width(width)`, and how many compare rows it would drop.
    pub fn lost_on_resize(&self, width: usize) -> (Vec<&Field>, usize) {
        let row_width = row_width_for(self.view, width);
        (self.fields.iter().filter(|field| field.hi >= width).collect(), self.compares.keys().filter(|lo| **lo >= width || *lo % row_width != 0).count())
    }

    /// Puts the value in a peripheral at `offset` ("" takes it out).
    pub fn set_peripheral(&mut self, block: &str, offset: Option<u64>) -> bool {
        if &*self.block == block && self.offset == offset {
            return false;
        }
        self.block = block.into();
        self.offset = offset;
        true
    }

    pub fn set_description(&mut self, description: &str) -> bool {
        if &*self.description == description {
            return false;
        }
        self.description = description.into();
        true
    }

    pub fn set_collapsed(&mut self, collapsed: bool) -> bool {
        std::mem::replace(&mut self.collapsed, collapsed) != collapsed
    }

    pub fn set_show_bases(&mut self, show: bool) -> bool {
        std::mem::replace(&mut self.show_bases, show) != show
    }

    pub fn set_msb_first(&mut self, msb_first: bool) -> bool {
        std::mem::replace(&mut self.msb_first, msb_first) != msb_first
    }

    /// Saves the current value under a name.
    pub fn take_snapshot(&mut self, name: &str, at: f64) -> &Snapshot {
        let name = name.trim();
        let name = if name.is_empty() { format!("Snapshot {}", self.snapshots.len() + 1) } else { name.to_string() };
        self.snapshots.push(Snapshot { name: name.into(), value: self.value, at });
        self.snapshots.last().unwrap()
    }

    pub fn remove_snapshot(&mut self, index: usize) -> bool {
        if index < self.snapshots.len() {
            self.snapshots.remove(index);
            true
        } else {
            false
        }
    }

    // ------------------------------------------------------------ compare rows
    pub fn has_compare(&self, lo: usize) -> bool {
        self.compares.contains_key(&lo)
    }

    /// Opens a compare row; reopening restores the value it had when closed.
    pub fn add_compare(&mut self, lo: usize) -> Result<bool, ModelError> {
        self.check_row(lo)?;
        if self.compares.contains_key(&lo) {
            return Ok(false);
        }
        let value = self.hidden_compares.remove(&lo).unwrap_or_else(|| self.row_value(lo));
        self.compares.insert(lo, value);
        Ok(true)
    }

    /// Opens a compare row on every row, filled with the bits of `other`
    /// (e.g. another value, or a snapshot). Bits above this width are dropped.
    pub fn compare_with(&mut self, other: Bits) -> bool {
        for lo in self.row_los() {
            let value = (other >> lo) & mask(self.row_width_at(lo));
            self.compares.insert(lo, value);
            self.hidden_compares.remove(&lo);
        }
        true
    }

    /// Closes a compare row; its value is kept and comes back on reopen.
    pub fn remove_compare(&mut self, lo: usize) -> bool {
        match self.compares.remove(&lo) {
            Some(value) => {
                self.hidden_compares.insert(lo, value);
                true
            }
            None => false,
        }
    }

    pub fn compare_value(&self, lo: usize) -> Result<Bits, ModelError> {
        self.compares.get(&lo).copied().ok_or_else(|| ModelError::new("No compare row there"))
    }

    pub fn set_compare(&mut self, lo: usize, value: Bits) -> Result<bool, ModelError> {
        let width = self.row_width_at(lo);
        let slot = self.compares.get_mut(&lo).ok_or_else(|| ModelError::new("No compare row there"))?;
        let value = value & mask(width);
        Ok(std::mem::replace(slot, value) != value)
    }

    pub fn compare_bit(&self, lo: usize, bit: usize) -> Result<bool, ModelError> {
        Ok(self.compare_value(lo)?.bit(bit - lo))
    }

    pub fn flip_compare_bit(&mut self, lo: usize, bit: usize) -> Result<bool, ModelError> {
        if bit < lo || bit >= lo + self.row_width_at(lo) {
            return Err(ModelError::new("Bit outside the compare row"));
        }
        let mut value = self.compare_value(lo)?;
        value.set_bit(bit - lo, !value.bit(bit - lo));
        self.set_compare(lo, value)
    }

    pub fn compare_diff(&self, lo: usize) -> Result<Bits, ModelError> {
        Ok(self.compare_value(lo)? ^ self.row_value(lo))
    }

    // ------------------------------------------------------------ writes
    /// Whether any field does something other than take what is written.
    pub fn has_write_rules(&self) -> bool {
        self.fields.iter().any(|field| field.details.write != field::WriteAction::Normal || field.details.access == field::Access::ReadOnly)
    }

    /// The register after `written` is written to it, as the hardware would
    /// do it: read-only fields keep their bits, fields such as "write 1 to
    /// clear" follow their rule, everything else takes what is written.
    pub fn after_write(&self, written: Bits) -> Bits {
        let mut out = written & mask(self.width);
        for field in &self.fields {
            let width = field.width();
            let field_mask = mask(width) << field.lo;
            let old = (self.value >> field.lo) & mask(width);
            let new = if field.details.access == field::Access::ReadOnly { old } else { field.details.write.apply(old, written >> field.lo, width) };
            out = (out & !field_mask) | ((new & mask(width)) << field.lo);
        }
        out
    }

    // ------------------------------------------------------------ fields
    pub fn field_at(&self, bit: usize) -> Option<usize> {
        self.fields.iter().position(|field| field.contains(bit))
    }

    pub fn add_field(&mut self, lo: usize, hi: usize, name: Option<&str>, color: Option<&str>, base: Option<Base>) -> Result<usize, ModelError> {
        let new = field::new_field(&self.fields, self.width, lo, hi, name, color, base)?;
        let (lo, hi) = (new.lo, new.hi);
        self.fields.push(new);
        field::sort_fields(&mut self.fields);
        Ok(self.fields.iter().position(|field| field.lo == lo && field.hi == hi).unwrap())
    }

    pub fn remove_field(&mut self, index: usize) -> bool {
        if index < self.fields.len() {
            self.fields.remove(index);
            true
        } else {
            false
        }
    }

    /// Moves a field's edges, e.g. to widen a 4-bit field to 8 bits. Other
    /// fields stay put. Returns the field's index after re-sorting.
    pub fn resize_field(&mut self, index: usize, lo: usize, hi: usize) -> Result<usize, ModelError> {
        let (lo, hi) = field::field_range(&self.fields, self.width, lo, hi, Some(index))?;
        let field = &mut self.fields[index];
        if (field.lo, field.hi) == (lo, hi) {
            return Ok(index);
        }
        field.lo = lo;
        field.hi = hi;
        // named values are kept as they are: the user can tidy them
        field::sort_fields(&mut self.fields);
        Ok(self.fields.iter().position(|f| f.lo == lo && f.hi == hi).unwrap())
    }

    pub fn update_field(&mut self, index: usize, name: Option<&str>, color: Option<&str>, base: Option<Base>) -> Result<bool, ModelError> {
        let field = &mut self.fields[index];
        let mut changed = false;
        if let Some(name) = name.filter(|name| *name != &*field.name) {
            field.name = name.into();
            changed = true;
        }
        if let Some(color) = color.filter(|color| *color != &*field.color) {
            if !field::is_color(color) {
                return Err(ModelError::new(format!("Not a colour: {color}")));
            }
            field.color = color.into();
            changed = true;
        }
        if let Some(base) = base.filter(|base| *base != field.base) {
            field.base = base;
            changed = true;
        }
        Ok(changed)
    }

    /// Replaces a field's details (signedness, formula, named values, …).
    pub fn set_field_details(&mut self, index: usize, draft: DetailsDraft) {
        self.fields[index].assign(draft);
    }

    /// Replaces all fields with a template's. Refuses if a template field
    /// doesn't fit; then nothing changes.
    pub fn apply_template(&mut self, template: &Template) -> Result<(), ModelError> {
        if template.fields.iter().any(|field| field.hi >= self.width) {
            return Err(ModelError::new(format!("The template needs {} bits; this value has {}", template.width, self.width)));
        }
        let mut fields: Vec<Field> = Vec::with_capacity(template.fields.len());
        for spec in &template.fields {
            let mut new = field::new_field(&fields, self.width, spec.lo, spec.hi, Some(&spec.name), spec.color.as_deref(), spec.base)?;
            new.assign(spec.details.clone());
            fields.push(new);
            field::sort_fields(&mut fields);
        }
        self.fields = fields;
        Ok(())
    }

    pub fn field_value(&self, index: usize) -> Bits {
        let field = &self.fields[index];
        self.bits_value(field.lo, field.width())
    }

    pub fn set_field_value(&mut self, index: usize, value: Bits) -> bool {
        let (lo, width) = (self.fields[index].lo, self.fields[index].width());
        self.set_bits_value(lo, width, value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(width: usize, v: u64) -> Value {
        Value::new(width, Bits::from(v), "V", View::Byte, Base::Hex).unwrap()
    }

    #[test]
    fn writes_follow_each_field_rule() {
        use crate::field::{Access, WriteAction};
        // a status register: [7] TXE read-only, [6] TC w1c, [5] RXNE w1c, [3:0] DATA plain
        let mut v = value(8, 0b1110_0101);
        for (lo, hi, name) in [(7, 7, "TXE"), (6, 6, "TC"), (5, 5, "RXNE"), (0, 3, "DATA")] {
            v.add_field(lo, hi, Some(name), None, None).unwrap();
        }
        let set = |v: &mut Value, name: &str, change: &dyn Fn(&mut crate::field::FieldDetails)| {
            let index = v.fields.iter().position(|field| &*field.name == name).unwrap();
            change(&mut v.fields[index].details);
        };
        set(&mut v, "TXE", &|d| d.access = Access::ReadOnly);
        set(&mut v, "TC", &|d| d.write = WriteAction::OneToClear);
        set(&mut v, "RXNE", &|d| d.write = WriteAction::OneToClear);
        assert!(v.has_write_rules());
        // writing RXNE = 1 clears it; TC (written 0) stays; TXE ignores the write;
        // DATA takes 0xA; bit 4 (no field) takes what is written
        assert_eq!(v.after_write(Bits::from(0b0011_1010u8)), Bits::from(0b1101_1010u8));
        assert!(!value(8, 0).has_write_rules());
        assert_eq!(value(8, 3).after_write(Bits::from(0x5Au8)), Bits::from(0x5Au8));
    }

    #[test]
    fn rows_and_bits() {
        let mut v = value(12, 0xABC);
        assert_eq!(v.row_los(), vec![8, 0]);
        assert_eq!(v.row_width_at(8), 4);
        assert_eq!(v.row_value(8), Bits::from(0xAu8));
        assert!(v.flip_bit(0).unwrap());
        assert_eq!(v.value, Bits::from(0xABDu16));
        assert!(v.set_row_value(0, Bits::from(0xFFu8)).unwrap());
        assert_eq!(v.value, Bits::from(0xAFFu16));
        assert!(!v.set_value(Bits::from(0xAFFu16)));
        assert!(v.check_row(4).is_err());
        assert_eq!(v.row_title(8), "Byte 1");
    }

    #[test]
    fn compare_rows_close_and_reopen_with_their_value() {
        let mut v = value(16, 0x1234);
        v.add_compare(8).unwrap();
        v.set_compare(8, Bits::from(0xFFu8)).unwrap();
        assert_eq!(v.compare_diff(8).unwrap(), Bits::from(0xFFu8 ^ 0x12));
        assert!(v.remove_compare(8));
        assert!(v.add_compare(8).unwrap());
        assert_eq!(v.compare_value(8).unwrap(), Bits::from(0xFFu8));
        assert!(v.set_view(View::Nibble));
        assert_eq!(v.compares.keys().copied().collect::<Vec<_>>(), vec![8, 12]);
    }

    #[test]
    fn width_changes_keep_fields() {
        let mut v = value(16, 0xFFFF);
        v.add_field(8, 15, Some("HI"), None, None).unwrap();
        let error = v.set_width(8).unwrap_err();
        assert_eq!(error.to_string(), "Fields HI [15:8] don't fit in 8 bits");
        v.remove_field(0);
        v.add_compare(8).unwrap();
        assert!(v.set_width(8).unwrap());
        assert_eq!(v.value, Bits::from(0xFFu8));
        assert!(v.compares.is_empty());
    }

    #[test]
    fn fields_stay_sorted_from_the_top() {
        let mut v = value(16, 0);
        v.add_field(0, 3, Some("LO"), None, None).unwrap();
        let index = v.add_field(12, 15, Some("TOP"), None, None).unwrap();
        assert_eq!(index, 0);
        assert_eq!(&*v.fields[1].name, "LO");
        let moved = v.resize_field(1, 0, 13).map(|_| ()).unwrap_err();
        assert_eq!(moved.to_string(), "Groups cannot overlap: TOP [15:12]");
        v.set_field_value(1, Bits::from(0xFu8));
        assert_eq!(v.value, Bits::from(0xFu8));
    }
}
