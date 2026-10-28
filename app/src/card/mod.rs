//! One value as a card. A CardView exists only while its value is on (or
//! near) the screen; it holds what belongs to the screen rather than to the
//! value: the text fields, the bit selection, a drag in progress. Every
//! change goes through the workspace, which records it for undo.
//!
//! Text fields parse as you type: a valid entry changes the value at once
//! (keystrokes in one field are one undo step), an invalid one is marked
//! and left alone, and leaving the field shows the value as it is.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use crate::kit::component::WindowExt;
use crate::kit::component::input::{InputEvent, InputState};
use crate::kit::component::notification::Notification;
use crate::kit::prelude::FluentBuilder as _;
use crate::kit::*;
use bitviewer_core::ModelError;
use bitviewer_core::expr::{eval_int, names_in, parse_expr};
use bitviewer_core::field::{Access, DetailsDraft, wrap_big};
use bitviewer_core::integers::{Base, Bits, format_int, mask, parse_value, signed_decimal};
use bitviewer_core::interpretations::parse_float_text;
use bitviewer_core::meaning::{compile_formula, field_number, format_real, raw_from_number};
use bitviewer_core::ops::Op;
use bitviewer_core::rows::View;
use bitviewer_core::value::{Value, ValueId};
use num_bigint::{BigInt, Sign};
use num_traits::ToPrimitive;

mod dialogs;
mod menu;
mod render;
use render::CARD_PAD;
pub use render::{PAGE_PAD, PAGE_WIDTH, SIDEBAR_WIDTH};

use crate::field_editor::FieldEditor;
use crate::theme;
use crate::widgets::r;
use crate::workspace_view::WorkspaceView;

/// Protected bits a change would touch: a read-only or reserved field, or a
/// run of reserved bits between fields.
struct Blocked {
    /// Lowest and highest bit: the key the user's "Always" unlocks.
    key: (usize, usize),
    name: String,
    label: String,
    kind: &'static str,
    description: String,
}

#[derive(Clone, Copy)]
enum Choice {
    Change,
    Always,
    Cancel,
}

/// Which text field an event or a parse error belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Slot {
    Name,
    Value,
    Selection,
    InBase(Base),
    Row(usize),
    Field(usize),
    /// A field's meaning (its formula's result, or the signed number).
    Meaning(usize),
    /// The expression bar.
    Expr,
    /// The compare row under the row starting at this bit.
    Compare(usize),
    /// A field's name.
    FieldName(usize),
    /// A float readout chip (its position among the value's float kinds).
    Float(usize),
}

impl Slot {
    /// Keystrokes in the same field of the same value merge into one undo step.
    fn merge_key(self, id: ValueId) -> u64 {
        let code: u64 = match self {
            Slot::Name => 1,
            Slot::Value => 2,
            Slot::Selection => 3,
            Slot::InBase(base) => 10 + u64::from(base.radix()),
            Slot::Row(lo) => 1000 + lo as u64,
            Slot::Field(index) => 3000 + index as u64,
            Slot::Meaning(index) => 5000 + index as u64,
            Slot::Expr => 4,
            Slot::Compare(lo) => 7000 + lo as u64,
            Slot::FieldName(index) => 9000 + index as u64,
            Slot::Float(index) => 8000 + index as u64,
        };
        (id.0 << 20) | code
    }
}

pub struct CardView {
    pub id: ValueId,
    /// Where the value was when last shown (a hint; the id is what counts).
    index: usize,
    value: Arc<Value>,
    peripheral_base: Option<u64>,
    workspace: WeakEntity<WorkspaceView>,

    inputs: HashMap<Slot, Entity<InputState>>,
    errors: HashMap<Slot, String>,
    subscriptions: Vec<Subscription>,

    /// Selected bits, lowest and highest.
    selection: Option<(usize, usize)>,
    /// A press on a bit: where it started, and whether it became a drag.
    press: Option<(usize, bool)>,

    /// Protected fields (by bit range) the user allowed changes to: for the
    /// rest of the session, or while typing in one text field.
    unlocked: HashSet<(usize, usize)>,
    typing_allowed: HashSet<(usize, usize)>,
    /// A protected-field question is open.
    asking: bool,
    expr_open: bool,
    /// What the expression typed so far gives (or why it can't be evaluated).
    expr_result: Option<Result<crate::expr_field::Fitted, String>>,
    /// The base the selection's field shows.
    selection_base: Base,
    /// The keyboard cursor (a bit), and where a Shift+arrow selection started.
    cursor: Option<usize>,
    anchor: Option<usize>,
    /// The bits take the keyboard (arrows, Space, 0 and 1).
    bits_focus: FocusHandle,
    /// Bits per visual line in line view, as last drawn.
    line_bits: usize,
    /// The bits had the keyboard when last drawn (the cursor is solid then).
    bits_focused: bool,
    /// The bit right-clicked for the row menu.
    menu_bit: Option<usize>,
    /// An Alt+drag paint stroke: the bit value it paints.
    paint: Option<bool>,
    /// The float chip being typed in.
    editing_float: Option<usize>,
    /// Fields that match the search (shown ringed).
    matches: std::collections::HashSet<String>,
    /// When the search stepped to this value (it flashes for a moment).
    flash: Option<std::time::Instant>,
    /// A press landed on something that works with the selection (bits,
    /// row labels, operations…): it doesn't drop the selection.
    keep_press: bool,
}

impl CardView {
    pub fn new(index: usize, value: Arc<Value>, peripheral_base: Option<u64>, workspace: WeakEntity<WorkspaceView>, cx: &mut Context<Self>) -> Self {
        CardView {
            id: value.id,
            index,
            value,
            peripheral_base,
            workspace,
            inputs: HashMap::new(),
            errors: HashMap::new(),
            subscriptions: Vec::new(),
            selection: None,
            press: None,
            unlocked: HashSet::new(),
            typing_allowed: HashSet::new(),
            asking: false,
            expr_open: false,
            expr_result: None,
            selection_base: Base::Hex,
            cursor: None,
            anchor: None,
            bits_focus: cx.focus_handle(),
            line_bits: 0,
            bits_focused: false,
            menu_bit: None,
            paint: None,
            editing_float: None,
            matches: Default::default(),
            flash: None,
            keep_press: false,
        }
    }

    /// The value to show (from the workspace, each frame).
    /// What the search highlights: matching fields, and a flash when the
    /// search has just stepped to this value.
    pub fn highlight(&mut self, matcher: Option<&crate::workspace_view::Matcher>, flash: Option<std::time::Instant>) {
        self.matches = match matcher {
            Some(matcher) => crate::workspace_view::match_value(&self.value, matcher).1,
            None => Default::default(),
        };
        self.flash = flash;
    }

    pub fn show(&mut self, index: usize, value: Arc<Value>, peripheral_base: Option<u64>) {
        self.index = index;
        if let Some((lo, hi)) = self.selection
            && hi >= value.width
        {
            self.selection = (lo < value.width).then(|| (lo, value.width - 1));
        }
        self.value = value;
        self.peripheral_base = peripheral_base;
    }

    // ------------------------------------------------------------ changes
    /// Changes the value through the workspace (one undo step, or part of the
    /// current one with a `merge` key). Problems are shown as a message.
    fn commit(&mut self, merge: Option<u64>, window: &mut Window, cx: &mut Context<Self>, edit: impl FnOnce(&mut Value) -> Result<bool, ModelError>) {
        let (id, index) = (self.id, self.index);
        let result = self.workspace.update(cx, |workspace, cx| workspace.edit_value(id, index, merge, edit, cx));
        if let Ok(Err(error)) = result {
            window.push_notification(Notification::error(error.to_string()), cx);
        }
    }

    /// Runs of bits outside every field (lowest, highest bit), when the value
    /// has fields: reserved bits, locked like reserved fields.
    pub(crate) fn gaps(&self) -> Vec<(usize, usize)> {
        let value = &self.value;
        if value.fields.is_empty() {
            return Vec::new();
        }
        let mut gaps = Vec::new();
        let mut start = None;
        for bit in 0..value.width {
            match (value.field_at(bit).is_none(), start) {
                (true, None) => start = Some(bit),
                (false, Some(lo)) => {
                    gaps.push((lo, bit - 1));
                    start = None;
                }
                _ => {}
            }
        }
        if let Some(lo) = start {
            gaps.push((lo, value.width - 1));
        }
        gaps
    }

    /// The bit is a reserved bit the user hasn't unlocked.
    pub(crate) fn gap_locked(&self, bit: usize) -> bool {
        self.in_gap(bit) && self.gaps().into_iter().find(|(lo, hi)| (*lo..=*hi).contains(&bit)).is_some_and(|key| !self.unlocked.contains(&key))
    }

    /// The bit is outside every field of a value that has fields.
    pub(crate) fn in_gap(&self, bit: usize) -> bool {
        !self.value.fields.is_empty() && bit < self.value.width && self.value.field_at(bit).is_none()
    }

    /// Protected bits (read-only or reserved fields, and the reserved bits
    /// between fields) that `next` would change and the user hasn't allowed yet.
    fn blocked(&self, next: Bits) -> Vec<Blocked> {
        let changed = self.value.value ^ next;
        let open = |key: &(usize, usize)| !self.unlocked.contains(key) && !self.typing_allowed.contains(key);
        let touches = |lo: usize, width: usize| (changed >> lo) & mask(width) != Bits::ZERO;
        let mut blocked: Vec<Blocked> = self
            .value
            .fields
            .iter()
            .filter(|field| field.protected() && open(&(field.lo, field.hi)) && touches(field.lo, field.width()))
            .map(|field| Blocked {
                key: (field.lo, field.hi),
                name: field.name.to_string(),
                label: field.label(),
                kind: if field.details.access == Access::ReadOnly { "read-only" } else { "reserved" },
                description: field.details.description.to_string(),
            })
            .collect();
        for (lo, hi) in self.gaps() {
            if open(&(lo, hi)) && touches(lo, hi - lo + 1) {
                let label = if lo == hi { format!("[{lo}]") } else { format!("[{hi}:{lo}]") };
                blocked.push(Blocked { key: (lo, hi), name: "Reserved".into(), label, kind: "reserved", description: String::new() });
            }
        }
        blocked
    }

    /// Sets the whole value, asking first when that changes a read-only or
    /// reserved field. `typing`: the text field the change comes from, so
    /// "Change it" holds until the user leaves it rather than asking again
    /// on every keystroke.
    fn set_value_guarded(&mut self, next: Bits, merge: Option<u64>, typing: Option<Slot>, window: &mut Window, cx: &mut Context<Self>) {
        let blocked = self.blocked(next);
        if blocked.is_empty() {
            self.commit(merge, window, cx, move |value| Ok(value.set_value(next)));
            return;
        }
        if self.asking {
            return;
        }
        self.asking = true;

        crate::sound::play(crate::sound::Sound::Error, cx);
        let keys: Vec<(usize, usize)> = blocked.iter().map(|item| item.key).collect();
        let one = blocked.len() == 1;
        let gap = |item: &Blocked| item.name == "Reserved" && item.description.is_empty() && self.in_gap(item.key.0);
        let title = match blocked.as_slice() {
            [item] if gap(item) => "Change reserved bits?".to_string(),
            [item] => format!("Change a {} field?", item.kind),
            _ => "Change protected bits?".to_string(),
        };
        let message = match blocked.as_slice() {
            [item] if gap(item) => format!("Bits {} are reserved: they belong to no field and are locked so they keep their reset value.", item.label),
            [item] => {
                let description = if item.description.is_empty() {
                    String::new()
                } else {
                    format!(
                        "

{}",
                        item.description
                    )
                };
                format!("This changes “{}” {}, which is marked {}.{description}", item.name, item.label, item.kind)
            }
            _ => {
                let list: Vec<String> = blocked.iter().map(|item| format!("“{}” {} ({})", item.name, item.label, item.kind)).collect();
                format!("This changes bits marked read-only or reserved: {}.", list.join(", "))
            }
        };

        let card = cx.entity().downgrade();
        let answer = move |choice: Choice| {
            let card = card.clone();
            let keys = keys.clone();
            move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                window.close_dialog(cx);
                card.update(cx, |card, cx| card.answered(choice, &keys, next, merge, typing, window, cx)).ok();
            }
        };
        let card_on_close = cx.entity().downgrade();
        window.open_dialog(cx, move |dialog, _, _| {
            let palette = theme::current();
            crate::modal::frame(dialog, "lock", title.clone(), false)
                .child(div().text_color(palette.muted).children(message.split('\n').map(|line| div().child(line.to_string())).collect::<Vec<_>>()))
                .footer(
                    crate::modal::footer()
                        .child(
                            crate::widgets::Btn::new("cancel", crate::widgets::Look::Ghost)
                                .label("Cancel")
                                .test_label("dialog-cancel")
                                .on_click(answer(Choice::Cancel)),
                        )
                        .child(
                            crate::widgets::Btn::new("always", crate::widgets::Look::Outline)
                                .label(if one { "Always allow these bits" } else { "Always allow all of them" })
                                .test_label("dialog-always")
                                .on_click(answer(Choice::Always)),
                        )
                        .child(
                            crate::widgets::Btn::new("change", crate::widgets::Look::Primary)
                                .label("Change it")
                                .test_label("dialog-change")
                                .on_click(answer(Choice::Change)),
                        ),
                )
                .on_close({
                    let card = card_on_close.clone();
                    move |_, _, cx| {
                        card.update(cx, |card, cx| {
                            card.asking = false;
                            cx.notify();
                        })
                        .ok();
                    }
                })
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn answered(
        &mut self,
        choice: Choice,
        keys: &[(usize, usize)],
        next: Bits,
        merge: Option<u64>,
        typing: Option<Slot>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.asking = false;
        match choice {
            Choice::Cancel => {
                // show the value as it is again
                if let Some(slot) = typing
                    && let Some(input) = self.inputs.get(&slot).cloned()
                {
                    let text = self.text_for(slot);
                    input.update(cx, |state, cx| state.set_value(text, window, cx));
                }
                cx.notify();
                return;
            }
            Choice::Always => self.unlocked.extend(keys.iter().copied()),
            Choice::Change if typing.is_some() => self.typing_allowed.extend(keys.iter().copied()),
            Choice::Change => {}
        }
        self.commit(merge, window, cx, move |value| Ok(value.set_value(next)));
    }

    pub(crate) fn open_field_editor(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(field) = self.value.fields.get(index).cloned() else {
            return;
        };
        let card = cx.entity().downgrade();
        let editor = cx.new(|cx| FieldEditor::new(card, index, &field, window, cx));
        let title = format!("Field “{}” {}", field.name, field.label());
        window.open_dialog(cx, move |dialog, _, cx| {
            let save = editor.clone();
            let changed = editor.clone();
            let formula_ok = editor.read(cx).formula_ok(cx);
            let dialog = crate::modal::guard(dialog, move |cx| changed.read(cx).has_changes(cx));
            crate::modal::frame(dialog, "sliders-vertical", title.clone(), true).child(editor.clone()).footer(
                crate::modal::footer()
                    .child(
                        crate::widgets::Btn::new("field-cancel", crate::widgets::Look::Ghost)
                            .label("Cancel")
                            .test_label("field-cancel")
                            .on_click(|_, window, cx| window.close_dialog(cx)),
                    )
                    .child(
                        crate::widgets::Btn::new("field-save", crate::widgets::Look::Primary)
                            .label("Save")
                            .disabled(!formula_ok)
                            .test_label("field-save")
                            .on_click(move |_, window, cx| {
                                if save.update(cx, |editor, cx| editor.save(window, cx)) {
                                    window.close_dialog(cx);
                                }
                            }),
                    ),
            )
        });
    }

    /// Saves the field details dialog (one undo step; none if nothing changed).
    pub fn set_field_details(&mut self, index: usize, draft: DetailsDraft, window: &mut Window, cx: &mut Context<Self>) {
        self.commit(None, window, cx, move |value| {
            let before = value.clone();
            value.set_field_details(index, draft);
            Ok(*value != before)
        });
    }

    pub(crate) fn flip(&mut self, bit: usize, window: &mut Window, cx: &mut Context<Self>) {
        let next = self.value.value ^ (Bits::from(1u8) << bit);
        self.set_value_guarded(next, None, None, window, cx);
        let sound = if self.value.bit(bit) { crate::sound::Sound::BitOn } else { crate::sound::Sound::BitOff };
        crate::sound::play(sound, cx);
    }

    pub(crate) fn apply_op(&mut self, op: Op, window: &mut Window, cx: &mut Context<Self>) {
        let mut preview = Value::clone(&self.value);
        let result = match self.selection {
            Some((lo, hi)) => preview.op_bits(lo, hi, op, None),
            None => preview.op_value(op, None),
        };
        match result {
            Ok(_) => {
                self.set_value_guarded(preview.value, None, None, window, cx);
                crate::sound::play(crate::sound::Sound::Op, cx);
            }
            Err(error) => {
                crate::sound::play(crate::sound::Sound::Error, cx);
                window.push_notification(Notification::error(error.to_string()), cx)
            }
        }
    }

    /// An operation with an argument (an amount or a mask) on the selection,
    /// or the value; on a row (or its compare row) when `row` is given.
    pub(crate) fn apply_op_on(&mut self, row: Option<(usize, bool)>, op: Op, argument: Bits, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((lo, true)) = row {
            self.commit(None, window, cx, move |v| v.op_compare(lo, op, Some(argument)));
            crate::sound::play(crate::sound::Sound::Op, cx);
            return;
        }
        let mut preview = Value::clone(&self.value);
        let result = match (row, self.selection) {
            (Some((lo, _)), _) => preview.op_row(lo, op, Some(argument)),
            (None, Some((lo, hi))) => preview.op_bits(lo, hi, op, Some(argument)),
            (None, None) => preview.op_value(op, Some(argument)),
        };
        match result {
            Ok(_) => {
                self.set_value_guarded(preview.value, None, None, window, cx);
                crate::sound::play(crate::sound::Sound::Op, cx);
            }
            Err(error) => {
                crate::sound::play(crate::sound::Sound::Error, cx);
                window.push_notification(Notification::error(error.to_string()), cx);
            }
        }
    }

    /// Runs `action` on the workspace with the window (after this event:
    /// it may open a dialog).
    fn workspace_do_in(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
        action: impl FnOnce(&mut WorkspaceView, ValueId, &mut Window, &mut Context<WorkspaceView>) + 'static,
    ) {
        let (id, workspace) = (self.id, self.workspace.clone());
        window.defer(cx, move |window, cx| {
            workspace.update(cx, |workspace, cx| action(workspace, id, window, cx)).ok();
        });
    }

    fn workspace_do(&self, cx: &mut Context<Self>, action: impl FnOnce(&mut WorkspaceView, ValueId, &mut Context<WorkspaceView>)) {
        let id = self.id;
        self.workspace.update(cx, |workspace, cx| action(workspace, id, cx)).ok();
    }

    /// For parts that work with the selection: a press on them keeps it.
    pub(crate) fn keeps_selection(&self, cx: &mut Context<Self>) -> impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static {
        cx.listener(|this, _: &MouseDownEvent, _, _| this.keep_press = true)
    }

    // ------------------------------------------------------------ painting
    /// Alt+drag: every bit the pointer passes sets to 1 (Alt+Shift: to 0).
    /// Protected fields are skipped; the stroke is one undo step.
    pub(crate) fn paint_start(&mut self, bit: usize, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.paint = Some(on);
        self.press = None;
        self.paint_bit(bit, window, cx);
    }

    pub(crate) fn paint_bit(&mut self, bit: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(on) = self.paint else { return };
        let protected = self.in_gap(bit) || self.value.field_at(bit).is_some_and(|index| self.value.fields[index].protected());
        if protected || self.value.bit(bit) == on {
            return;
        }
        let merge = Some((self.id.0 << 20) | 900_000);
        self.commit(merge, window, cx, move |v| Ok(v.set_bits_value(bit, 1, Bits::from(u8::from(on)))));
        crate::sound::play(if on { crate::sound::Sound::BitOn } else { crate::sound::Sound::BitOff }, cx);
    }

    /// Ends a stroke without telling the workspace (it does that itself).
    pub fn stop_paint(&mut self) -> bool {
        self.paint.take().is_some()
    }

    /// The stroke ends; the next change is a new undo step.
    pub(crate) fn paint_end(&mut self, cx: &mut Context<Self>) {
        if self.paint.take().is_some() {
            self.workspace.update(cx, |workspace, _| workspace.break_merge()).ok();
        }
    }

    // ------------------------------------------------------------ bit presses
    fn press_bit(&mut self, bit: usize, shift: bool, cx: &mut Context<Self>) {
        self.cursor = Some(bit);
        self.anchor = None;
        match (shift, self.selection) {
            // extends the selection; no press, so neither letting go (a
            // flip) nor moving within the bit (a drag) undoes it
            (true, Some((lo, hi))) => {
                self.selection = Some((lo.min(bit), hi.max(bit)));
                self.press = None;
            }
            // Shift+click with nothing selected: just this bit (a field can be one bit)
            (true, None) => {
                self.selection = Some((bit, bit));
                self.press = Some((bit, true));
                crate::sound::play(crate::sound::Sound::Select, cx);
            }
            _ => self.press = Some((bit, false)),
        }
        cx.notify();
    }

    /// A bit's number in the table header was pressed: selects that bit
    /// (Shift: extends the selection to it), without flipping anything. A
    /// drag from there, along the numbers or over the bits, selects a range.
    pub(crate) fn select_bit(&mut self, bit: usize, shift: bool, cx: &mut Context<Self>) {
        self.cursor = Some(bit);
        self.anchor = None;
        let selection = match (shift, self.selection) {
            (true, Some((lo, hi))) => Some((lo.min(bit), hi.max(bit))),
            _ => Some((bit, bit)),
        };
        // a drag from here selects; letting go on a bit never flips it
        self.press = if shift { None } else { Some((bit, true)) };
        if self.selection != selection {
            self.selection = selection;
            crate::sound::play(crate::sound::Sound::Select, cx);
        }
        cx.notify();
    }

    pub(crate) fn drag_over(&mut self, bit: usize, cx: &mut Context<Self>) {
        // a press on a bit starts selecting once the pointer reaches another
        // bit; once selecting, coming back to the first bit selects just it
        if let Some((start, dragging)) = self.press
            && (start != bit || dragging)
        {
            self.press = Some((start, true));
            // the pointer moves over the same bits many times: only a bit
            // joining or leaving the selection makes a sound
            let selection = Some((start.min(bit), start.max(bit)));
            if self.selection != selection {
                self.selection = selection;
                crate::sound::play(crate::sound::Sound::Select, cx);
                cx.notify();
            }
        }
    }

    fn release_bit(&mut self, bit: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.press == Some((bit, false)) {
            self.selection = None;
            self.flip(bit, window, cx);
        }
        self.press = None;
        cx.notify();
    }

    /// Ctrl+G: makes the selected bits a field.
    pub(crate) fn group_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((lo, hi)) = self.selection {
            self.open_group_dialog(lo, hi, window, cx);
        }
    }

    pub(crate) fn toggle_collapsed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let collapsed = self.value.collapsed;
        self.commit(None, window, cx, move |v| Ok(v.set_collapsed(!collapsed)));
        crate::sound::play(crate::sound::Sound::Toggle, cx);
    }

    pub(crate) fn toggle_bases(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let show = self.value.show_bases;
        self.commit(None, window, cx, move |v| Ok(v.set_show_bases(!show)));
        crate::sound::play(crate::sound::Sound::Toggle, cx);
    }

    /// Opens the expression bar with `text` in it, as if typed (--shot).
    pub(crate) fn type_expression(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        if !self.expr_open {
            self.toggle_expr(window, cx);
        }
        let input = self.input(Slot::Expr, window, cx);
        input.update(cx, |state, cx| state.set_value(text.to_string(), window, cx));
        self.typed(Slot::Expr, text, window, cx);
    }

    pub(crate) fn toggle_expr(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.expr_open = !self.expr_open;
        if self.expr_open {
            let input = self.input(Slot::Expr, window, cx);
            input.update(cx, |state, cx| state.focus(window, cx));
        }
        cx.notify();
    }

    /// Runs `op` on one row (or its compare row, which is never protected).
    pub(crate) fn row_op(&mut self, lo: usize, compare: bool, op: Op, window: &mut Window, cx: &mut Context<Self>) {
        if compare {
            self.commit(None, window, cx, move |v| v.op_compare(lo, op, None));
            return;
        }
        let mut preview = Value::clone(&self.value);
        match preview.op_row(lo, op, None) {
            Ok(_) => self.set_value_guarded(preview.value, None, None, window, cx),
            Err(error) => window.push_notification(Notification::error(error.to_string()), cx),
        }
    }

    pub(crate) fn copy_row_as(&mut self, lo: usize, compare: bool, base: Base, _: &mut Window, cx: &mut Context<Self>) {
        let value = &self.value;
        let bits = if compare { value.compare_value(lo).unwrap_or(Bits::ZERO) } else { value.row_value(lo) };
        let text = format_int(bits, base, value.row_width_at(lo), true, false);
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        crate::sound::play(crate::sound::Sound::Copy, cx);
    }

    /// Adds the compare row under the row at `lo`, or removes it.
    pub(crate) fn toggle_compare(&mut self, lo: usize, window: &mut Window, cx: &mut Context<Self>) {
        let has = self.value.has_compare(lo);
        self.commit(None, window, cx, move |v| if has { Ok(v.remove_compare(lo)) } else { v.add_compare(lo) });
        crate::sound::play(crate::sound::Sound::Toggle, cx);
    }

    /// Selects the row at `lo`; with Shift, extends the selection over it.
    pub(crate) fn select_row(&mut self, lo: usize, extend: bool, cx: &mut Context<Self>) {
        let hi = lo + self.value.row_width_at(lo) - 1;
        self.selection = match (extend, self.selection) {
            (true, Some((low, high))) => Some((low.min(lo), high.max(hi))),
            _ => Some((lo, hi)),
        };
        cx.notify();
    }

    /// Keys on the bits (the web app's keyboard.ts): arrows move the cursor
    /// (Shift+arrows select), Home / End jump to the ends, Space or Enter
    /// flips, 0 / 1 set.
    pub(crate) fn bit_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;
        let modifiers = keystroke.modifiers;
        if modifiers.control || modifiers.platform || modifiers.alt {
            return;
        }
        let width = self.value.width;
        let current = self.cursor.unwrap_or(width - 1);
        let msb_left = crate::app_state::settings(cx).msb_left;
        let left: isize = if msb_left { 1 } else { -1 };
        let per = if self.value.view == View::Line { self.line_bits.max(1) } else { self.value.row_width() } as isize;
        let higher_above = if self.value.view == View::Line { msb_left } else { self.value.msb_first };
        let up = if higher_above { per } else { -per };
        let step = match keystroke.key.as_str() {
            "left" => Some(left),
            "right" => Some(-left),
            "up" => Some(up),
            "down" => Some(-up),
            _ => None,
        };
        let next = match (step, keystroke.key.as_str()) {
            (Some(step), key) => {
                let next = current as isize + step;
                // up/down past the first/last line stays put; left/right stop at the ends
                let vertical = key == "up" || key == "down";
                Some(if vertical && (next < 0 || next >= width as isize) { current } else { next.clamp(0, width as isize - 1) as usize })
            }
            (None, "home") => Some(width - 1),
            (None, "end") => Some(0),
            _ => None,
        };
        if let Some(mut next) = next {
            if modifiers.shift {
                let anchor = *self.anchor.get_or_insert(match self.selection {
                    Some((lo, hi)) if lo == current => hi,
                    Some((lo, _)) => lo,
                    None => current,
                });
                self.selection = Some((anchor.min(next), anchor.max(next)));
            } else if self.cursor.is_none() {
                next = current;
            }
            self.cursor = Some(next);
            cx.stop_propagation();
            cx.notify();
            return;
        }
        if keystroke.key == "escape" && self.selection.is_some() {
            self.clear_selection(cx);
            cx.stop_propagation();
            return;
        }
        let Some(cursor) = self.cursor else { return };
        match keystroke.key.as_str() {
            "space" | "enter" => self.flip(cursor, window, cx),
            "0" | "1" => {
                if self.value.bit(cursor) != (keystroke.key == "1") {
                    self.flip(cursor, window, cx);
                }
            }
            _ => return,
        }
        cx.stop_propagation();
    }

    /// What the value's text field holds (for tests).
    #[cfg(all(test, not(target_os = "macos")))]
    pub fn value_field_text(&self, cx: &App) -> String {
        self.inputs.get(&Slot::Value).map(|input| input.read(cx).value().to_string()).unwrap_or_default()
    }

    pub fn has_selection(&self) -> bool {
        self.selection.is_some()
    }

    pub(crate) fn clear_selection(&mut self, cx: &mut Context<Self>) {
        self.selection = None;
        cx.notify();
    }

    // ------------------------------------------------------------ text fields
    /// The text field for `slot`, made on first use.
    fn input(&mut self, slot: Slot, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        if let Some(input) = self.inputs.get(&slot) {
            return input.clone();
        }
        let input = cx.new(|cx| InputState::new(window, cx));
        let subscription = cx.subscribe_in(&input, window, move |this, input, event: &InputEvent, window, cx| this.on_input(slot, input, event, window, cx));
        self.subscriptions.push(subscription);
        self.inputs.insert(slot, input.clone());
        input
    }

    /// What the field for `slot` shows when nobody is typing in it.
    fn text_for(&self, slot: Slot) -> String {
        let value = &self.value;
        match slot {
            Slot::Name => value.name.to_string(),
            Slot::Value => format_int(value.value, value.full_base, value.width, false, true),
            Slot::InBase(base) => format_int(value.value, base, value.width, false, true),
            Slot::FieldName(index) => value.fields.get(index).map(|field| field.name.to_string()).unwrap_or_default(),
            Slot::Float(index) => bitviewer_core::interpretations::float_kinds(value.width)
                .get(index)
                .map(|kind| {
                    use bitviewer_core::interpretations::{decode_float, format_float_kind};
                    format_float_kind(decode_float(value.value, *kind), *kind)
                })
                .unwrap_or_default(),
            Slot::Compare(lo) => {
                let line = value.view == View::Line;
                let base = if line { value.full_base } else { value.row_base(lo) };
                format_int(value.compare_value(lo).unwrap_or(Bits::ZERO), base, value.row_width_at(lo), false, line)
            }
            Slot::Row(lo) => {
                let base = value.row_base(lo);
                format_int(value.row_value(lo), base, value.row_width_at(lo), false, false)
            }
            Slot::Selection => match self.selection {
                Some((lo, hi)) => format_int(value.bits_value(lo, hi - lo + 1), self.selection_base, hi - lo + 1, false, false),
                None => String::new(),
            },
            Slot::Field(index) => match value.fields.get(index) {
                Some(field) => {
                    let raw = value.field_value(index);
                    if field.details.signed && field.base == Base::Dec {
                        signed_decimal(raw, field.width())
                    } else {
                        format_int(raw, field.base, field.width(), false, false)
                    }
                }
                None => String::new(),
            },
            // the number alone (no unit), so it can be edited
            Slot::Meaning(index) => match value.fields.get(index) {
                Some(field) => {
                    let number = field_number(field, value.field_value(index));
                    if field.details.formula.is_empty() {
                        number.to_string()
                    } else {
                        compile_formula(&field.details.formula)
                            .and_then(|formula| formula.evaluate(number.to_f64().unwrap_or(f64::NAN)))
                            .map(format_real)
                            .unwrap_or_default()
                    }
                }
                None => String::new(),
            },
            Slot::Expr => String::new(),
        }
    }

    /// The values of the names `text` uses: `x` (also this, value, v) is the
    /// value, field names give field values, other names other values.
    pub(crate) fn known_names(&self, text: &str, cx: &mut Context<Self>) -> HashMap<String, BigInt> {
        let mut known = HashMap::new();
        for name in crate::expr_field::names(text) {
            let lower = name.to_lowercase();
            let found = if ["x", "this", "value", "v"].contains(&lower.as_str()) {
                Some(self.value.value)
            } else if let Some(index) = self.value.fields.iter().position(|field| field.name.to_lowercase() == lower) {
                Some(self.value.field_value(index))
            } else {
                self.workspace.update(cx, |workspace, _| workspace.value_by_name(&name)).ok().flatten()
            };
            if let Some(bits) = found {
                known.insert(name, crate::expr_field::to_big(bits));
            }
        }
        known
    }

    /// Evaluates an expression for this card: `x` (also this, value, v) is
    /// the value, field names give field values, other names other values.
    fn evaluate(&self, text: &str, cx: &mut Context<Self>) -> Result<BigInt, String> {
        let expression = parse_expr(text).map_err(|error| error.0)?;
        let value = self.value.clone();
        let workspace = self.workspace.clone();
        let mut names: BTreeSet<String> = BTreeSet::new();
        names_in(&expression, &mut names);
        // look every name up once, before evaluating
        let mut known: HashMap<String, BigInt> = HashMap::new();
        for name in names {
            let lower = name.to_lowercase();
            let found = if ["x", "this", "value", "v"].contains(&lower.as_str()) {
                Some(value.value)
            } else if let Some(index) = value.fields.iter().position(|field| field.name.to_lowercase() == lower) {
                Some(value.field_value(index))
            } else {
                workspace.update(cx, |workspace, _| workspace.value_by_name(&name)).ok().flatten()
            };
            if let Some(bits) = found {
                known.insert(name, BigInt::from_bytes_le(Sign::Plus, &bits.to_le_bytes::<64>()));
            }
        }
        eval_int(&expression, &|name: &str| known.get(name).cloned()).map_err(|error| error.0)
    }

    /// What the expression applies to: the selection, or the whole value.
    fn target(&self) -> (usize, usize) {
        self.selection.map_or((0, self.value.width), |(lo, hi)| (lo, hi - lo + 1))
    }

    fn apply_expression(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(input) = self.inputs.get(&Slot::Expr).cloned() else {
            return;
        };
        let text = input.read(cx).value().to_string();
        match self.evaluate(&text, cx) {
            Ok(result) => {
                let (lo, width) = self.target();
                let next = self.value.with_bits(lo, width, wrap_big(&result, width));
                self.set_value_guarded(next, None, None, window, cx);
            }
            Err(message) => self.expr_result = Some(Err(message)),
        }
        cx.notify();
    }

    fn on_input(&mut self, slot: Slot, input: &Entity<InputState>, event: &InputEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            InputEvent::Change => {
                let text = input.read(cx).value().to_string();
                self.typed(slot, &text, window, cx);
            }
            // the expression bar keeps its text; Enter applies it
            InputEvent::PressEnter { .. } if slot == Slot::Expr => self.apply_expression(window, cx),
            InputEvent::Blur if slot == Slot::Expr => {}
            // a float chip applies what was typed on Enter or when left
            InputEvent::Blur | InputEvent::PressEnter { .. } if matches!(slot, Slot::Float(_)) => {
                let Slot::Float(index) = slot else { return };
                let text = input.read(cx).value().to_string();
                self.editing_float = None;
                if let Some(kind) = bitviewer_core::interpretations::float_kinds(self.value.width).get(index).copied() {
                    match parse_float_text(&text) {
                        Ok(number) => {
                            let next = bitviewer_core::interpretations::encode_float(number, kind);
                            if next != self.value.value {
                                self.set_value_guarded(next, None, None, window, cx);
                                crate::sound::play(crate::sound::Sound::BitOn, cx);
                            }
                        }
                        Err(error) => {
                            crate::sound::play(crate::sound::Sound::Error, cx);
                            window.push_notification(Notification::error(error.message), cx);
                        }
                    }
                }
                self.inputs.remove(&slot);
                cx.notify();
            }
            InputEvent::Blur | InputEvent::PressEnter { .. } => {
                self.typing_allowed.clear();
                // show the value as it is, and start a new undo step next time
                self.errors.remove(&slot);
                let text = self.text_for(slot);
                input.update(cx, |state, cx| state.set_value(text, window, cx));
                self.workspace.update(cx, |workspace, _| workspace.break_merge()).ok();
                cx.notify();
            }
            InputEvent::Focus => {}
        }
    }

    /// The user typed `text` into the field for `slot`.
    fn typed(&mut self, slot: Slot, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let merge = Some(slot.merge_key(self.id));
        let value = self.value.clone();
        let parse_error = |e: bitviewer_core::integers::ParseError| (e.message, e.incomplete);
        // the whole value the text stands for
        let next: Result<Bits, (String, bool)> = match slot {
            Slot::Name => {
                let name = text.to_string();
                self.commit(merge, window, cx, move |v| Ok(v.set_name(&name)));
                return;
            }
            Slot::FieldName(index) => {
                let name = text.to_string();
                self.commit(merge, window, cx, move |v| v.update_field(index, Some(&name), None, None));
                return;
            }
            Slot::Compare(lo) => {
                let line = value.view == View::Line;
                let base = if line { value.full_base } else { value.row_base(lo) };
                match parse_value(text, base, value.row_width_at(lo), true) {
                    Ok(bits) => {
                        self.errors.remove(&slot);
                        self.commit(merge, window, cx, move |v| v.set_compare(lo, bits));
                    }
                    Err(error) if error.incomplete => {
                        self.errors.remove(&slot);
                    }
                    Err(error) => {
                        self.errors.insert(slot, error.message);
                    }
                }
                cx.notify();
                return;
            }
            Slot::Float(_) => return,
            Slot::Expr => {
                self.expr_result = if text.trim().is_empty() {
                    None
                } else {
                    let (_, width) = self.target();
                    let known = self.known_names(text, cx);
                    Some(crate::expr_field::evaluate_for(text, width, &known))
                };
                cx.notify();
                return;
            }
            Slot::Value | Slot::InBase(_) => {
                let base = if let Slot::InBase(base) = slot { base } else { value.full_base };
                parse_value(text, base, value.width, true).map_err(parse_error)
            }
            Slot::Row(lo) => parse_value(text, value.row_base(lo), value.row_width_at(lo), true)
                .map(|bits| value.with_bits(lo, value.row_width_at(lo), bits))
                .map_err(parse_error),
            Slot::Selection => match self.selection {
                Some((lo, hi)) => {
                    parse_value(text, self.selection_base, hi - lo + 1, true).map(|bits| value.with_bits(lo, hi - lo + 1, bits)).map_err(parse_error)
                }
                None => return,
            },
            Slot::Field(index) => match value.fields.get(index) {
                Some(field) => {
                    parse_value(text, field.base, field.width(), true).map(|bits| value.with_bits(field.lo, field.width(), bits)).map_err(parse_error)
                }
                None => return,
            },
            Slot::Meaning(index) => match value.fields.get(index) {
                Some(field) => parse_float_text(text)
                    .map_err(parse_error)
                    .and_then(|number| raw_from_number(field, number).map_err(|e| (e.0, false)))
                    .map(|raw| value.with_bits(field.lo, field.width(), raw)),
                None => return,
            },
        };

        match next {
            Ok(next) => {
                self.errors.remove(&slot);
                self.set_value_guarded(next, merge, Some(slot), window, cx);
            }
            Err((message, incomplete)) => {
                if incomplete {
                    self.errors.remove(&slot);
                } else {
                    if !self.errors.contains_key(&slot) {
                        crate::sound::play(crate::sound::Sound::Error, cx);
                    }
                    self.errors.insert(slot, message);
                }
            }
        }
        cx.notify();
    }

    /// Turns the field for `slot` into a real text editor with the keyboard in it.
    fn activate(&mut self, slot: Slot, window: &mut Window, cx: &mut Context<Self>) {
        let input = self.input(slot, window, cx);
        let text = self.text_for(slot);
        input.update(cx, |state, cx| {
            state.set_value(text, window, cx);
            state.focus(window, cx);
        });
        cx.notify();
    }

    /// A label for tests to find an element of this card by: "v0-bit-3".
    fn label<W: std::fmt::Display>(&self, what: W) -> impl FnOnce() -> String + use<W> {
        let label = format!("v{}-{what}", self.index);
        move || label
    }
}

impl Render for CardView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let collapsed = self.value.collapsed;
        // a rounded card on the page
        let mut card = div()
            .flex()
            .flex_col()
            .gap(r(theme::space(14.0, 10.0)))
            .mb(r(theme::space(18.0, 10.0)))
            .px(r(CARD_PAD))
            .pt(r(if collapsed { 14.0 } else { theme::space(22.0, 14.0) }))
            .pb(r(if collapsed { 14.0 } else { theme::space(24.0, 16.0) }))
            .rounded(r(14.0))
            .bg(palette.surface)
            .border_1()
            .border_color(if palette.name == theme::ThemeName::Light { palette.surface_3 } else { palette.border })
            .shadow(vec![
                BoxShadow { color: hsla(0.7, 0.3, 0.2, 0.05), offset: point(px(0.0), px(1.0)), blur_radius: px(2.0), spread_radius: px(0.0), inset: false },
                BoxShadow { color: hsla(0.7, 0.3, 0.2, 0.06), offset: point(px(0.0), px(10.0)), blur_radius: px(28.0), spread_radius: px(0.0), inset: false },
            ])
            .when_some(self.flash.filter(|at| at.elapsed().as_secs_f32() < 0.9), |card, at| {
                // a wash in the selection colour that fades out
                window.request_animation_frame();
                let mut wash = palette.select_soft;
                wash.alpha *= 1.0 - at.elapsed().as_secs_f32() / 0.9;
                card.bg(wash)
            })
            // the card the user works in is the one "Value" commands act on
            .capture_any_mouse_down(cx.listener(|this, _: &MouseDownEvent, _, cx| {
                this.workspace_do(cx, |workspace, id, _| workspace.set_active(id));
            }))
            // pressing anything that doesn't work with the selection drops it
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, _, cx| {
                    if !std::mem::take(&mut this.keep_press) && this.selection.is_some() {
                        this.selection = None;
                        cx.notify();
                    }
                }),
            )
            // a press that ends outside the bits is not a click
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _: &MouseUpEvent, _, cx| {
                    this.press = None;
                    this.paint_end(cx);
                    cx.notify();
                }),
            )
            .child(self.render_header(window, cx));

        if collapsed {
            return card;
        }

        card =
            card.child(self.render_toolbar(window, cx)).children(self.expr_open.then(|| self.render_expr_bar(window, cx))).child(self.render_rows(window, cx));
        if self.value.show_bases {
            card = card.child(self.render_bases(window, cx));
        }
        card.child(self.render_fields_anchored(window, cx)).children(self.render_stats(window, cx))
    }
}
