//! What the user can do with peripherals (the web app's peripherals.ts and
//! peripheral-ui.ts): edit one, create one from a value, move a value into
//! or out of one, change a register's offset, add a register, move a block.

use std::rc::Rc;
use std::sync::Arc;

use bitviewer_core::integers::{Base, Bits, parse_value};
use bitviewer_core::value::{Value, ValueId};
use bitviewer_core::workspace::Peripheral;
use gpui_kit::component::WindowExt;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::notification::Notification;
use gpui_kit::*;

use super::WorkspaceView;
use crate::app_state;
use crate::modal;
use crate::theme;
use crate::value_dialogs::field_box;
use crate::widgets::{Btn, Look, r};

fn hex(value: u64) -> String {
    format!("0x{value:X}")
}

/// An address or offset typed in hex ("4001 1000", "0x40011000"); empty: none.
pub fn parse_address(text: &str) -> Result<Option<u64>, String> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    parse_value(text, Base::Hex, 64, false).map(|bits| Some(bits.to::<u64>())).map_err(|error| error.message)
}

/// What the peripheral dialog asks for.
#[derive(Clone)]
pub struct PeripheralForm {
    pub name: String,
    pub base: Option<u64>,
    pub description: String,
    /// Only asked for when a value starts a new peripheral.
    pub offset: Option<Option<u64>>,
}

type Done = Rc<dyn Fn(PeripheralForm, &mut Window, &mut App)>;
type Taken = Rc<dyn Fn(&str, &App) -> bool>;

pub struct PeripheralDialog {
    name: Entity<InputState>,
    base: Entity<InputState>,
    description: Entity<InputState>,
    offset: Option<Entity<InputState>>,
    taken: Taken,
    done: Done,
    /// The fields as opened, to tell whether anything changed.
    initial: String,
    _subscriptions: Vec<Subscription>,
}

impl PeripheralDialog {
    fn snapshot(&self, cx: &App) -> String {
        [Some(&self.name), Some(&self.base), Some(&self.description), self.offset.as_ref()]
            .into_iter()
            .map(|input| input.map(|input| input.read(cx).value().to_string()).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(
                "
",
            )
    }

    fn read(&self, cx: &App) -> Result<PeripheralForm, String> {
        let name = self.name.read(cx).value().trim().to_string();
        if name.is_empty() {
            return Err("Give the peripheral a name".into());
        }
        if (self.taken)(&name, cx) {
            return Err(format!("There is already a peripheral called “{name}”"));
        }
        let base = parse_address(&self.base.read(cx).value())?;
        let offset = match &self.offset {
            Some(offset) => Some(parse_address(&offset.read(cx).value())?),
            None => None,
        };
        Ok(PeripheralForm { name, base, description: self.description.read(cx).value().trim().to_string(), offset })
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Ok(form) = self.read(cx) {
            window.close_dialog(cx);
            (self.done)(form, window, cx);
        }
    }
}

fn label(text: &'static str, hint: &'static str) -> Div {
    let palette = theme::current();
    div()
        .flex()
        .mt(r(4.0))
        .mb(r(8.0))
        .text_color(palette.muted)
        .child(text)
        .when(!hint.is_empty(), |label| label.child(div().text_size(r(12.0)).child(format!(" — {hint}"))))
}

impl Render for PeripheralDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let error = self.read(cx).err();
        let mut body = div()
            .flex()
            .flex_col()
            .child(label("Name", ""))
            .child(field_box(&self.name, false, 34.0, false))
            .child(label("Base address", "hex; registers' addresses are base + offset"))
            .child(field_box(&self.base, false, 34.0, true))
            .child(label("Description", ""))
            .child(field_box(&self.description, false, 34.0, false));
        if let Some(offset) = &self.offset {
            body = body.child(label("Offset of this value", "hex, in bytes from the base")).child(field_box(offset, false, 34.0, true));
        }
        body.child(div().mt(r(8.0)).min_h(r(18.0)).text_color(theme::current().error).children(error))
    }
}

/// Asks for a peripheral's name, base address and description (and the
/// first register's offset when `start.offset` is given).
pub fn edit_peripheral_dialog(
    window: &mut Window,
    cx: &mut App,
    title: String,
    start: PeripheralForm,
    taken: impl Fn(&str, &App) -> bool + 'static,
    done: impl Fn(PeripheralForm, &mut Window, &mut App) + 'static,
) {
    let view = cx.new(|cx| {
        let input = |value: String, placeholder: &'static str, window: &mut Window, cx: &mut Context<PeripheralDialog>| {
            cx.new(|cx| InputState::new(window, cx).default_value(value).placeholder(placeholder))
        };
        let name = input(start.name.clone(), "e.g. UART0", window, cx);
        let base = input(start.base.map(hex).unwrap_or_default(), "e.g. 0x40011000 (optional)", window, cx);
        let description = input(start.description.clone(), "What it is", window, cx);
        let offset = start.offset.map(|offset| input(hex(offset.unwrap_or(0)), "e.g. 0x4", window, cx));
        name.update(cx, |input, cx| input.focus(window, cx));
        let mut subscriptions = Vec::new();
        for input in [Some(&name), Some(&base), Some(&description), offset.as_ref()].into_iter().flatten() {
            subscriptions.push(cx.subscribe_in(input, window, |this: &mut PeripheralDialog, _, event: &InputEvent, window, cx| match event {
                InputEvent::Change => cx.notify(),
                InputEvent::PressEnter { .. } => this.submit(window, cx),
                _ => {}
            }));
        }
        let mut dialog = PeripheralDialog {
            name,
            base,
            description,
            offset,
            taken: Rc::new(taken),
            done: Rc::new(done),
            initial: String::new(),
            _subscriptions: subscriptions,
        };
        dialog.initial = dialog.snapshot(cx);
        dialog
    });
    window.open_dialog(cx, move |dialog, _, cx| {
        let valid = view.read(cx).read(cx).is_ok();
        let submit = view.clone();
        let changed = view.clone();
        let dialog = modal::guard(dialog, move |cx| {
            let view = changed.read(cx);
            view.snapshot(cx) != view.initial
        });
        modal::frame(dialog, "cpu", title.clone(), false).child(view.clone()).footer(
            modal::footer().child(Btn::new("periph-cancel", Look::Ghost).label("Cancel").on_click(|_, window, cx| window.close_dialog(cx))).child(
                Btn::new("periph-ok", Look::Primary)
                    .label("OK")
                    .disabled(!valid)
                    .on_click(move |_, window, cx| submit.update(cx, |view, cx| view.submit(window, cx))),
            ),
        )
    });
}

impl WorkspaceView {
    fn position(&self, id: ValueId) -> Option<usize> {
        self.state.values.iter().position(|value| value.id == id)
    }

    /// Records a change made to `self.state` since `before` (one undo step).
    fn record_layout(&mut self, before: bitviewer_core::workspace::WorkspaceState, cx: &mut Context<Self>) {
        self.state.tidy();
        self.history.record(&before, None);
        self.reset_rows();
        self.changed(cx);
    }

    /// Renames a peripheral or changes its base address or description.
    pub(super) fn edit_peripheral(&mut self, name: &Arc<str>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(peripheral) = self.state.peripherals.get(name).cloned() else { return };
        let workspace = cx.entity().downgrade();
        let old = name.clone();
        let taken_by = workspace.clone();
        let original = old.clone();
        edit_peripheral_dialog(
            window,
            cx,
            format!("Peripheral “{name}”"),
            PeripheralForm { name: name.to_string(), base: peripheral.base, description: peripheral.description.to_string(), offset: None },
            move |candidate, cx| *candidate != *original && taken_by.upgrade().is_some_and(|w| w.read(cx).state.peripherals.contains_key(candidate)),
            move |form, _, cx| {
                let old = old.clone();
                workspace
                    .update(cx, |this, cx| {
                        let before = this.state.clone();
                        let new_name: Arc<str> = form.name.as_str().into();
                        this.state.peripherals.remove(&old);
                        this.state.peripherals.insert(
                            new_name.clone(),
                            Arc::new(Peripheral {
                                name: new_name.clone(),
                                base: form.base,
                                description: form.description.as_str().into(),
                                collapsed: peripheral.collapsed,
                            }),
                        );
                        for index in 0..this.state.len() {
                            if this.state.values[index].block != old {
                                continue;
                            }
                            let (old, new_name) = (old.clone(), new_name.clone());
                            this.state.edit(index, move |value| {
                                // "UART0.CTRL" follows a rename of UART0
                                if new_name != old && value.name.starts_with(&format!("{old}.")) {
                                    let renamed = format!("{new_name}{}", &value.name[old.len()..]);
                                    value.set_name(&renamed);
                                }
                                let offset = value.offset;
                                value.set_peripheral(&new_name, offset);
                            });
                        }
                        this.record_layout(before, cx);
                    })
                    .ok();
            },
        );
    }

    /// Makes a new peripheral with this value as its first register.
    pub fn create_peripheral(&mut self, id: ValueId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(index) = self.position(id) else { return };
        let value = self.state.values[index].clone();
        let stem = value.name.split_once('.').map_or("PERIPH", |(stem, _)| if stem.is_empty() { "PERIPH" } else { stem });
        let suggestion = self.state.free_peripheral_name(stem);
        let workspace = cx.entity().downgrade();
        let taken_by = workspace.clone();
        edit_peripheral_dialog(
            window,
            cx,
            "New peripheral".into(),
            PeripheralForm { name: suggestion, base: None, description: String::new(), offset: Some(Some(value.offset.unwrap_or(0))) },
            move |candidate, cx| taken_by.upgrade().is_some_and(|w| w.read(cx).state.peripherals.contains_key(candidate)),
            move |form, _, cx| {
                workspace
                    .update(cx, |this, cx| {
                        let Some(index) = this.position(id) else { return };
                        let before = this.state.clone();
                        let name: Arc<str> = form.name.as_str().into();
                        this.state.peripherals.insert(
                            name.clone(),
                            Arc::new(Peripheral { name: name.clone(), base: form.base, description: form.description.as_str().into(), collapsed: false }),
                        );
                        let offset = form.offset.flatten();
                        this.state.edit(index, |value| value.set_peripheral(&name, offset));
                        this.record_layout(before, cx);
                    })
                    .ok();
            },
        );
    }

    /// Adds a value to another peripheral, after its last register.
    pub fn move_to_peripheral(&mut self, id: ValueId, block: &Arc<str>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(index) = self.position(id) else { return };
        let before = self.state.clone();
        let offset = self.state.next_offset(block);
        let mut value = Value::clone(&self.state.values.remove(index));
        value.set_peripheral(block, Some(offset));
        let last = self.state.values.iter().rposition(|v| v.block == *block).map_or(self.state.len(), |last| last + 1);
        self.state.values.insert(last, Arc::new(value));
        self.record_layout(before, cx);
        window.push_notification(Notification::info(format!("Moved to {block} at offset {}", hex(offset))), cx);
    }

    pub fn take_out_of_peripheral(&mut self, id: ValueId, cx: &mut Context<Self>) {
        let Some(index) = self.position(id) else { return };
        let before = self.state.clone();
        self.state.edit(index, |value| value.set_peripheral("", None));
        self.record_layout(before, cx);
    }

    /// Asks for a register's offset (empty: none).
    pub fn edit_offset(&mut self, id: ValueId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(index) = self.position(id) else { return };
        let value = self.state.values[index].clone();
        if value.block.is_empty() {
            return;
        }
        let workspace = cx.entity().downgrade();
        crate::prompt::ask_with(
            "cpu",
            window,
            cx,
            format!("Offset of “{}”", value.name),
            "e.g. 0x4 (empty: no offset)",
            value.offset.map(hex).unwrap_or_default(),
            move |text, _, cx| {
                let offset = parse_address(text)?;
                workspace
                    .update(cx, |this, cx| {
                        if let Some(index) = this.position(id) {
                            this.edit_value(
                                id,
                                index,
                                None,
                                |value| {
                                    let block = value.block.clone();
                                    Ok(value.set_peripheral(&block, offset))
                                },
                                cx,
                            )
                            .ok();
                        }
                    })
                    .ok();
                Ok(None)
            },
        );
    }

    /// A new 32-bit register at the end of the block, at the next free offset.
    pub(super) fn add_register(&mut self, block: &Arc<str>, cx: &mut Context<Self>) {
        let range = self.block_range(block);
        let taken: std::collections::HashSet<&str> = self.state.values.iter().map(|value| &*value.name).collect();
        let mut number = range.len() + 1;
        while taken.contains(format!("{block}.REG{number}").as_str()) {
            number += 1;
        }
        let settings = app_state::settings(cx);
        let Ok(mut value) = Value::new(32, Bits::ZERO, &format!("{block}.REG{number}"), settings.default_view, settings.default_base) else {
            return;
        };
        value.set_peripheral(block, Some(self.state.next_offset(block)));
        let before = self.state.clone();
        if let Some(peripheral) = self.state.peripherals.get(block).cloned().filter(|p| p.collapsed) {
            let open = Peripheral { collapsed: false, ..Peripheral::clone(&peripheral) };
            self.state.peripherals.insert(block.clone(), Arc::new(open));
        }
        self.active = Some(value.id);
        self.state.values.insert(range.end, Arc::new(value));
        self.record_layout(before, cx);
        self.reveal_value(range.end);
    }

    pub(super) fn move_peripheral(&mut self, block: &Arc<str>, direction: isize, cx: &mut Context<Self>) {
        let before = self.state.clone();
        if self.state.move_block(block, direction) {
            self.record_layout(before, cx);
        }
    }

    /// Asks, then removes a peripheral and its registers.
    pub(super) fn remove_peripheral(&mut self, block: &Arc<str>, window: &mut Window, cx: &mut Context<Self>) {
        let count = self.block_range(block).len();
        let workspace = cx.entity().downgrade();
        let block = block.clone();
        let message = format!("Remove {block} and its {count} register{}?", if count == 1 { "" } else { "s" });
        modal::confirm(window, cx, "Remove peripheral", message, "Remove".into(), true, move |_, cx| {
            workspace.update(cx, |this, cx| this.dissolve_block(&block, false, cx)).ok();
        });
    }
}

use gpui_kit::prelude::FluentBuilder as _;
