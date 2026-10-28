//! Rows: how a value is split up on screen. The "line" view shows the whole
//! value as one row; "byte" and "nibble" split it into 8- or 4-bit rows. A
//! row is identified by its lowest bit `lo`; only the top row can be shorter.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::integers::{Base, Bits, mask};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum View {
    Line,
    Byte,
    Nibble,
}

impl View {
    pub const ALL: [View; 3] = [View::Line, View::Byte, View::Nibble];

    pub fn parse(text: &str) -> Option<View> {
        match text {
            "line" => Some(View::Line),
            "byte" => Some(View::Byte),
            "nibble" => Some(View::Nibble),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            View::Line => "line",
            View::Byte => "byte",
            View::Nibble => "nibble",
        }
    }
}

/// Nominal row width of `view` for a `width`-bit value.
pub fn row_width_for(view: View, width: usize) -> usize {
    match view {
        View::Line => width,
        View::Byte => 8.min(width),
        View::Nibble => 4.min(width),
    }
}

/// Re-maps rows of values (compare rows) from `old_row_width`-bit rows to
/// `new_row_width`-bit rows. Each old row is laid over the parent `value`; a
/// new row gets an entry if any old row covered part of it (the rest of its
/// bits come from the parent).
pub fn remap_rows(value: Bits, width: usize, rows: &BTreeMap<usize, Bits>, old_row_width: usize, new_row_width: usize) -> BTreeMap<usize, Bits> {
    let value_mask = mask(width);
    let mut overlay = value;
    let mut covered = Bits::ZERO;

    for (&lo, &row_value) in rows {
        let row_mask = (mask(old_row_width) << lo) & value_mask;
        overlay = (overlay & !row_mask) | ((row_value << lo) & row_mask);
        covered |= row_mask;
    }

    let mut out = BTreeMap::new();
    let mut lo = 0;
    while lo < width {
        let row_width = new_row_width.min(width - lo);
        if covered & (mask(row_width) << lo) != Bits::ZERO {
            out.insert(lo, (overlay >> lo) & mask(row_width));
        }
        lo += new_row_width;
    }
    out
}

/// Display bases for the new rows: each new row keeps the explicit base of
/// the lowest old row it overlaps.
pub fn remap_row_bases(row_bases: &BTreeMap<usize, Base>, width: usize, old_row_width: usize, new_row_width: usize) -> BTreeMap<usize, Base> {
    let mut bases = BTreeMap::new();
    let mut lo = 0;
    while lo < width {
        // BTreeMap iterates in ascending order: the first overlap is the lowest
        if let Some((_, &base)) = row_bases.iter().find(|(old, _)| **old + old_row_width > lo && **old < lo + new_row_width) {
            bases.insert(lo, base);
        }
        lo += new_row_width;
    }
    bases
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_widths() {
        assert_eq!(row_width_for(View::Byte, 32), 8);
        assert_eq!(row_width_for(View::Nibble, 2), 2);
        assert_eq!(row_width_for(View::Line, 12), 12);
    }

    #[test]
    fn remaps_compare_rows_between_views() {
        // a 16-bit value 0x1234 with a compare on byte 1 (0xAB)
        let rows = BTreeMap::from([(8, Bits::from(0xABu8))]);
        let nibbles = remap_rows(Bits::from(0x1234u16), 16, &rows, 8, 4);
        assert_eq!(nibbles, BTreeMap::from([(8, Bits::from(0xBu8)), (12, Bits::from(0xAu8))]));
        let line = remap_rows(Bits::from(0x1234u16), 16, &rows, 8, 16);
        assert_eq!(line, BTreeMap::from([(0, Bits::from(0xAB34u16))]));
    }

    #[test]
    fn remaps_row_bases() {
        let bases = BTreeMap::from([(8, Base::Bin)]);
        assert_eq!(remap_row_bases(&bases, 16, 8, 4), BTreeMap::from([(8, Base::Bin), (12, Base::Bin)]));
    }
}
