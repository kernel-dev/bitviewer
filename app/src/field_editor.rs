//! The "Field details" dialog (the web app's dialogs/field.ts): description,
//! access, signedness, formula and unit, and named values. The name and
//! colour are edited in the fields panel.

use std::sync::Arc;

use crate::kit::component::input::{InputEvent, InputState};
use crate::kit::component::menu::PopupMenuItem;
use crate::kit::*;
use bitviewer_core::field::{Access, DetailsDraft, Field, ReadAction, WriteAction};
use bitviewer_core::meaning::{compile_formula, format_real};
use num_bigint::{BigInt, Sign};
use num_traits::{One, Signed, Zero};

use crate::card::CardView;
use crate::modal::{row, section, switch};
use crate::theme;
use crate::value_dialogs::field_box;
use crate::widgets::{Btn, Look, SegSize, r, seg_button, seg_track};

/// A named value's number as typed: decimal, 0x…, 0b… or 0o…, maybe negative.
pub fn parse_integer(text: &str) -> Result<BigInt, String> {
    let cleaned: String = text.trim().replace('_', "");
    let (negative, digits) = match cleaned.strip_prefix('-') {
        Some(rest) => (true, rest.to_string()),
        None => (false, cleaned.clone()),
    };
    let lower = digits.to_lowercase();
    let valid = |digits: &str, radix: u32| !digits.is_empty() && digits.chars().all(|c| c.is_digit(radix));
    let parsed = if let Some(hex) = lower.strip_prefix("0x") {
        valid(hex, 16).then(|| BigInt::parse_bytes(hex.as_bytes(), 16)).flatten()
    } else if let Some(binary) = lower.strip_prefix("0b") {
        valid(binary, 2).then(|| BigInt::parse_bytes(binary.as_bytes(), 2)).flatten()
    } else if let Some(octal) = lower.strip_prefix("0o") {
        valid(octal, 8).then(|| BigInt::parse_bytes(octal.as_bytes(), 8)).flatten()
    } else {
        valid(&lower, 10).then(|| BigInt::parse_bytes(lower.as_bytes(), 10)).flatten()
    };
    let value = parsed.ok_or_else(|| format!("\"{text}\" is not a whole number"))?;
    Ok(if negative { -value } else { value })
}

struct NamedRow {
    value: Entity<InputState>,
    label: Entity<InputState>,
    invalid: bool,
}

pub struct FieldEditor {
    card: WeakEntity<CardView>,
    index: usize,
    width: usize,
    description: Entity<InputState>,
    formula: Entity<InputState>,
    unit: Entity<InputState>,
    named: Vec<NamedRow>,
    signed: bool,
    access: Access,
    write: WriteAction,
    read: ReadAction,
    initial: String,
    _subscriptions: Vec<Subscription>,
}

impl FieldEditor {
    pub fn new(card: WeakEntity<CardView>, index: usize, field: &Field, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = |value: String, placeholder: &'static str, window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| InputState::new(window, cx).default_value(value).placeholder(placeholder))
        };
        let details = &field.details;
        let description = input(details.description.to_string(), "What this field does", window, cx);
        let formula = input(details.formula.to_string(), "e.g. x * 0.5 - 40   (x is the field's number)", window, cx);
        let unit = input(details.unit.to_string(), "°C", window, cx);
        let mut editor = FieldEditor {
            card,
            index,
            width: field.width(),
            description,
            formula,
            unit,
            named: Vec::new(),
            signed: details.signed,
            access: details.access,
            write: details.write,
            read: details.read,
            initial: String::new(),
            _subscriptions: Vec::new(),
        };
        for input in [editor.description.clone(), editor.formula.clone(), editor.unit.clone()] {
            editor.watch(&input, window, cx);
        }
        for named in &details.named {
            let value = BigInt::from_bytes_le(Sign::Plus, &named.value.to_le_bytes::<64>());
            editor.add_row(value.to_string(), named.label.to_string(), window, cx);
        }
        editor.initial = editor.snapshot(cx);
        editor
    }

    fn watch(&mut self, input: &Entity<InputState>, window: &mut Window, cx: &mut Context<Self>) {
        let subscription = cx.subscribe_in(input, window, |_, _, event: &InputEvent, _, cx| {
            if let InputEvent::Change = event {
                cx.notify();
            }
        });
        self._subscriptions.push(subscription);
    }

    fn add_row(&mut self, value: String, label: String, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        let value = cx.new(|cx| InputState::new(window, cx).default_value(value).placeholder("0"));
        let label = cx.new(|cx| InputState::new(window, cx).default_value(label).placeholder("Name"));
        self.watch(&value, window, cx);
        self.watch(&label, window, cx);
        self.named.push(NamedRow { value: value.clone(), label, invalid: false });
        value
    }

    fn snapshot(&self, cx: &App) -> String {
        let text = |input: &Entity<InputState>| input.read(cx).value().to_string();
        let rows: Vec<String> = self.named.iter().map(|row| format!("{}={}", text(&row.value), text(&row.label))).collect();
        format!(
            "{}\n{:?} {:?} {:?}\n{}\n{}\n{}\n{}",
            text(&self.description),
            self.access,
            self.write,
            self.read,
            self.signed,
            text(&self.formula),
            text(&self.unit),
            rows.join("\n")
        )
    }

    /// Something was edited since the editor opened.
    pub fn has_changes(&self, cx: &App) -> bool {
        self.snapshot(cx) != self.initial
    }

    pub fn formula_ok(&self, cx: &App) -> bool {
        let formula = self.formula.read(cx).value().trim().to_string();
        formula.is_empty() || compile_formula(&formula).is_ok()
    }

    /// Saves the details; false when they can't be (a named value is marked).
    pub fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let max: BigInt = (BigInt::one() << self.width) - 1;
        let mut named = Vec::new();
        for row in &mut self.named {
            row.invalid = false;
        }
        for position in 0..self.named.len() {
            let value_text = self.named[position].value.read(cx).value().to_string();
            let label_text = self.named[position].label.read(cx).value().trim().to_string();
            if value_text.trim().is_empty() && label_text.is_empty() {
                continue;
            }
            let parsed = parse_integer(&value_text).and_then(|mut value| {
                if value.is_negative() {
                    value &= &max; // -1 means all ones
                }
                if value > max {
                    return Err(format!("{value} doesn't fit in {} bits", self.width));
                }
                Ok(value)
            });
            match parsed {
                Ok(value) => {
                    let label = if label_text.is_empty() { format!("VALUE_{value}") } else { label_text };
                    named.push((value, Arc::<str>::from(label)));
                }
                Err(_) => {
                    self.named[position].invalid = true;
                    let input = self.named[position].value.clone();
                    input.update(cx, |input, cx| input.focus(window, cx));
                    cx.notify();
                    return false;
                }
            }
        }
        if !self.formula_ok(cx) {
            return false;
        }
        let text = |input: &Entity<InputState>| input.read(cx).value().trim().to_string();
        let draft = DetailsDraft {
            signed: Some(self.signed),
            formula: Some(text(&self.formula).into()),
            unit: Some(text(&self.unit).into()),
            named: Some(named),
            description: Some(text(&self.description).into()),
            access: Some(self.access),
            write: Some(self.write),
            read: Some(self.read),
        };
        let index = self.index;
        self.card.update(cx, |card, cx| card.set_field_details(index, draft, window, cx)).ok();
        crate::sound::play(crate::sound::Sound::Toggle, cx);
        true
    }

    /// "-128 → -64 °C  ·  127 → 63.5 °C  ·  linear: values can be typed in"
    fn formula_info(&self, cx: &App) -> Div {
        let palette = theme::current();
        let formula = self.formula.read(cx).value().trim().to_string();
        let line = div().mt(r(6.0)).flex().flex_wrap().text_size(r(12.5)).min_h(r(18.0));
        if formula.is_empty() {
            return line.child(div().text_color(palette.muted).child("No formula: the field shows its plain number."));
        }
        match compile_formula(&formula) {
            Err(error) => line.child(div().text_color(palette.error).child(error.0)),
            Ok(compiled) => {
                let width = self.width;
                let (lo, hi): (BigInt, BigInt) = if self.signed && width > 1 {
                    (-(BigInt::one() << (width - 1)), (BigInt::one() << (width - 1)) - 1)
                } else {
                    (BigInt::zero(), (BigInt::one() << width) - 1)
                };
                let unit = self.unit.read(cx).value().trim().to_string();
                let suffix = if unit.is_empty() { String::new() } else { format!(" {unit}") };
                let at = |number: &BigInt| {
                    let x: f64 = num_traits::ToPrimitive::to_f64(number).unwrap_or(f64::NAN);
                    compiled.evaluate(x).map(format_real).unwrap_or_else(|error| error.0)
                };
                let linear = compiled.linear.is_some();
                line.child(div().font_family(theme::mono()).text_color(palette.text).child(format!(
                    "{lo} → {}{suffix}  ·  {hi} → {}{suffix}",
                    at(&lo),
                    at(&hi)
                )))
                .child(div().text_color(if linear { palette.ok } else { palette.select }).child(if linear {
                    "  ·  linear: values can be typed in"
                } else {
                    "  ·  not linear: shown read-only"
                }))
            }
        }
    }
}

impl Render for FieldEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let mut access = seg_track();
        for (label, choice) in [("Read / write", Access::ReadWrite), ("Read-only", Access::ReadOnly), ("Reserved", Access::Reserved)] {
            access = access.child(
                seg_button(SharedString::from(format!("access-{}", choice.as_str())), label, self.access == choice, SegSize::Normal)
                    .debug_selector(move || format!("access-{}", choice.as_str()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.access = choice;
                        cx.notify();
                    })),
            );
        }
        // what a write or a read does to the field (SVD modifiedWriteValues / readAction)
        let me = cx.entity().downgrade();
        let write_label = if self.write == WriteAction::Normal {
            "Takes the value written".to_string()
        } else {
            format!("{} ({})", self.write.describe(), self.write.as_str())
        };
        let (chosen, editor) = (self.write, me.clone());
        let write = Btn::new("write-action", Look::Outline).label(write_label).icon("chevron-down").test_label("write-action").menu(
            Anchor::TopLeft,
            move |mut menu, _, _| {
                for action in WriteAction::ALL {
                    let editor = editor.clone();
                    let label =
                        if action == WriteAction::Normal { action.describe().to_string() } else { format!("{}  ·  {}", action.describe(), action.as_str()) };
                    menu = menu.item(PopupMenuItem::new(label).checked(action == chosen).on_click(move |_, _, cx| {
                        editor
                            .update(cx, |this, cx| {
                                this.write = action;
                                cx.notify();
                            })
                            .ok();
                    }));
                }
                menu
            },
        );
        let read_label =
            if self.read == ReadAction::Normal { "Leaves it as it is".to_string() } else { format!("{} ({})", self.read.describe(), self.read.as_str()) };
        let (chosen, editor) = (self.read, me.clone());
        let read = Btn::new("read-action", Look::Outline).label(read_label).icon("chevron-down").test_label("read-action").menu(
            Anchor::TopLeft,
            move |mut menu, _, _| {
                for action in ReadAction::ALL {
                    let editor = editor.clone();
                    let label =
                        if action == ReadAction::Normal { "Leaves it as it is".to_string() } else { format!("{}  ·  {}", action.describe(), action.as_str()) };
                    menu = menu.item(PopupMenuItem::new(label).checked(action == chosen).on_click(move |_, _, cx| {
                        editor
                            .update(cx, |this, cx| {
                                this.read = action;
                                cx.notify();
                            })
                            .ok();
                    }));
                }
                menu
            },
        );
        let signed = switch("signed", self.signed, move |on, _, cx| {
            me.update(cx, |this, cx| {
                this.signed = on;
                cx.notify();
            })
            .ok();
        });
        let formula_invalid = !self.formula_ok(cx);
        let heading = |text: &'static str| {
            div().mt(r(14.0)).mb(r(8.0)).text_size(r(11.0)).font_weight(FontWeight::BOLD).text_color(palette.muted).child(text.to_uppercase())
        };

        let mut table = div().flex().flex_col().gap(r(6.0)).my(r(8.0));
        for (position, named) in self.named.iter().enumerate() {
            table = table.child(
                div()
                    .flex()
                    .items_center()
                    .gap(r(8.0))
                    .child(div().w(r(110.0)).flex_none().child(field_box(&named.value, named.invalid, 30.0, true)))
                    .child(div().flex_1().child(field_box(&named.label, false, 30.0, false)))
                    .child(Btn::new(("named-remove", position), Look::Danger).small().icon("trash").tip("Remove").on_click(cx.listener(
                        move |this, _, _, cx| {
                            if position < this.named.len() {
                                this.named.remove(position);
                            }
                            cx.notify();
                        },
                    ))),
            );
        }
        div()
            .id("field-details")
            .max_h(window.viewport_size().height * 0.7)
            .overflow_y_scroll()
            .pr(r(4.0))
            .flex()
            .flex_col()
            .child(div().mt(r(4.0)).mb(r(8.0)).text_color(palette.muted).child("Description"))
            .child(div().debug_selector(|| "field-description".into()).child(field_box(&self.description, false, 34.0, false)))
            .child(section(
                "Behaviour",
                vec![
                    row("Access", "", access),
                    row("When written", "Status flags often clear when 1 is written to them", write),
                    row("When read", "", read),
                    row("Signed", format!("Read the field as two's complement ({} bits)", self.width), signed),
                ],
            ))
            .child(heading("Formula & unit"))
            .child(
                div()
                    .flex()
                    .gap(r(8.0))
                    .child(div().flex_1().debug_selector(|| "field-formula".into()).child(field_box(&self.formula, formula_invalid, 34.0, true)))
                    .child(div().w(r(90.0)).debug_selector(|| "field-unit".into()).child(field_box(&self.unit, false, 34.0, false))),
            )
            .child(self.formula_info(cx))
            .child(heading("Named values"))
            .child(div().text_size(r(12.0)).text_color(palette.muted).child("Give specific numbers a name, e.g. 0 = Off, 1 = Auto. Numbers may be 0x… or 0b…."))
            .child(table)
            .child(div().child(Btn::new("named-add", Look::Ghost).small().icon("plus").label("Add named value").on_click(cx.listener(
                |this, _, window, cx| {
                    let value = this.add_row(String::new(), String::new(), window, cx);
                    value.update(cx, |input, cx| input.focus(window, cx));
                    cx.notify();
                },
            ))))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_whole_numbers_as_typed() {
        use super::parse_integer;
        use num_bigint::BigInt;
        assert_eq!(parse_integer("0x1F").unwrap(), BigInt::from(31));
        assert_eq!(parse_integer("-1").unwrap(), BigInt::from(-1));
        assert_eq!(parse_integer("0b1_01").unwrap(), BigInt::from(5));
        assert!(parse_integer("1.5").is_err());
        assert!(parse_integer("").is_err());
    }
}
