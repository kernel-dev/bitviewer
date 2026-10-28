//! The list's rows. While a page or a search filters the workspace, the list
//! holds only the values on show (so a few matches among 90 000 values cost
//! no more than a few values); otherwise row N is value N. Everything that
//! scrolls or remeasures goes through these, by value position.

use std::ops::Range;
use std::sync::Arc;

use crate::kit::*;

use super::WorkspaceView;

impl WorkspaceView {
    /// The positions of the values on show, when something filters them.
    fn filtered_rows(&self) -> Option<Vec<usize>> {
        if self.page.is_none() && !self.searching() {
            return None;
        }
        Some((0..self.state.len()).filter(|index| self.shown(*index)).collect())
    }

    /// How many rows the list has.
    pub(super) fn row_count(&self) -> usize {
        self.rows.as_ref().map_or(self.state.len(), |rows| rows.len())
    }

    /// The value shown in `row`.
    pub(super) fn value_at_row(&self, row: usize) -> usize {
        match &self.rows {
            Some(rows) => rows.get(row).copied().unwrap_or(self.state.len()),
            None => row,
        }
    }

    /// The row of the value at `index` (or of the next one on show).
    pub(super) fn row_of(&self, index: usize) -> usize {
        match &self.rows {
            Some(rows) => rows.partition_point(|&value| value < index),
            None => index,
        }
    }

    /// The value at the top of the list.
    pub(super) fn top_value(&self) -> usize {
        self.value_at_row(self.list.logical_scroll_top().item_ix)
    }

    /// Works out the rows again after the filter changed (a search, a page).
    /// `keep_scroll`: stay at the value on top, else go back to the top.
    pub(super) fn refilter(&mut self, keep_scroll: bool) {
        let top = keep_scroll.then(|| self.top_value());
        self.rows = self.filtered_rows().map(Arc::new);
        self.list.reset(self.row_count());
        match top {
            Some(value) => self.scroll_to_value(value),
            None => self.list.scroll_to(ListOffset { item_ix: 0, offset_in_item: px(0.0) }),
        }
    }

    /// After values changed: the rows again, only if which values show changed.
    pub(super) fn refilter_if_changed(&mut self) {
        let rows = self.filtered_rows();
        if rows.as_deref() != self.rows.as_deref().map(|rows| rows.as_slice()) {
            let top = self.top_value();
            self.rows = rows.map(Arc::new);
            self.list.reset(self.row_count());
            self.scroll_to_value(top);
        }
    }

    /// The values in `range` may have changed height.
    pub(super) fn remeasure_values(&mut self, range: Range<usize>) {
        let rows = match &self.rows {
            Some(rows) => rows.partition_point(|&value| value < range.start)..rows.partition_point(|&value| value < range.end),
            None => range,
        };
        if !rows.is_empty() {
            self.list.remeasure_items(rows);
        }
    }

    /// Values in `range` were replaced by `count` new ones.
    pub(super) fn splice_values(&mut self, range: Range<usize>, count: usize) {
        if self.rows.is_some() {
            self.refilter(true);
        } else {
            self.list.splice(range, count);
        }
    }

    /// The values changed wholesale (another workspace, an undo of a move).
    pub(super) fn reset_rows(&mut self) {
        self.rows = self.filtered_rows().map(Arc::new);
        self.list.reset(self.row_count());
    }

    pub(super) fn scroll_to_value(&mut self, index: usize) {
        let row = self.row_of(index).min(self.row_count().saturating_sub(1));
        self.list.scroll_to(ListOffset { item_ix: row, offset_in_item: px(0.0) });
    }

    pub(super) fn reveal_value(&mut self, index: usize) {
        let row = self.row_of(index);
        if row < self.row_count() {
            self.list.scroll_to_reveal_item(row);
        }
    }

    /// The list as it used to be, a row per value (to time against).
    #[cfg(test)]
    pub fn unfilter_rows_for_test(&mut self) {
        self.rows = None;
        self.list.reset(self.state.len());
    }
}
