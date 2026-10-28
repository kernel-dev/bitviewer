//! Undo / redo over whole workspace states. States share everything that
//! didn't change (see workspace.rs), so keeping 200 of them costs about what
//! the 200 changes changed, not 200 copies of the workspace.

use crate::workspace::WorkspaceState;

const LIMIT: usize = 200; // undo steps kept

pub struct History {
    past: Vec<WorkspaceState>,
    future: Vec<WorkspaceState>,
    /// Steps recorded with the same merge key in a row become one step
    /// (e.g. keystrokes in one text field).
    last_merge_key: Option<u64>,
}

impl Default for History {
    fn default() -> Self {
        History::new()
    }
}

impl History {
    pub fn new() -> Self {
        History { past: Vec::new(), future: Vec::new(), last_merge_key: None }
    }

    /// Forgets all history.
    pub fn reset(&mut self) {
        self.past.clear();
        self.future.clear();
        self.last_merge_key = None;
    }

    pub fn can_undo(&self) -> bool {
        !self.past.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.future.is_empty()
    }

    /// Records that the workspace is about to change from `before`. With a
    /// `merge_key` equal to the previous step's, the change joins that step.
    pub fn record(&mut self, before: &WorkspaceState, merge_key: Option<u64>) {
        let merge = merge_key.is_some() && merge_key == self.last_merge_key && !self.past.is_empty();
        if !merge {
            self.past.push(before.clone());
            if self.past.len() > LIMIT {
                self.past.remove(0);
            }
        }
        self.future.clear();
        self.last_merge_key = merge_key;
    }

    /// Ends any merging, so the next change is a step of its own.
    pub fn break_merge(&mut self) {
        self.last_merge_key = None;
    }

    /// The state to go back to, given the current one.
    pub fn undo(&mut self, current: &WorkspaceState) -> Option<WorkspaceState> {
        let previous = self.past.pop()?;
        self.future.push(current.clone());
        self.last_merge_key = None;
        Some(previous)
    }

    pub fn redo(&mut self, current: &WorkspaceState) -> Option<WorkspaceState> {
        let next = self.future.pop()?;
        self.past.push(current.clone());
        self.last_merge_key = None;
        Some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integers::{Base, Bits};
    use crate::rows::View;
    use crate::value::Value;
    use std::sync::Arc;

    fn state(count: usize) -> WorkspaceState {
        let mut state = WorkspaceState::default();
        for index in 0..count {
            let value = Value::new(32, Bits::ZERO, &format!("V{index}"), View::Byte, Base::Hex).unwrap();
            state.values.push_back(Arc::new(value));
        }
        state
    }

    #[test]
    fn undoes_and_redoes() {
        let mut history = History::new();
        let mut current = state(3);
        history.record(&current, None);
        current.edit(1, |value| value.set_value(Bits::from(5u8)));
        let undone = history.undo(&current).unwrap();
        assert_eq!(undone.values[1].value, Bits::ZERO);
        let redone = history.redo(&undone).unwrap();
        assert_eq!(redone.values[1].value, Bits::from(5u8));
        assert!(!history.can_redo());
    }

    #[test]
    fn merges_typing_into_one_step() {
        let mut history = History::new();
        let mut current = state(1);
        for digit in 1..=5u8 {
            history.record(&current, Some(42));
            current.edit(0, |value| value.set_value(Bits::from(digit)));
        }
        let undone = history.undo(&current).unwrap();
        assert_eq!(undone.values[0].value, Bits::ZERO);
        assert!(!history.can_undo());
    }

    #[test]
    fn steps_share_everything_that_did_not_change() {
        let mut history = History::new();
        let mut current = state(150_000);
        for step in 0..200 {
            history.record(&current, None);
            current.edit(step * 700, |value| value.set_value(Bits::from(1u8)));
        }
        // every value the edits didn't touch is the very same one in all steps
        let oldest = history.undo(&current).unwrap();
        assert!(Arc::ptr_eq(&oldest.values[1], &current.values[1]));
    }
}
