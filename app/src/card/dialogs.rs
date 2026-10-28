//! The card's dialogs that do more than ask for a line (the web app's
//! dialogs/bytes.ts, dialogs/compare.ts and the operand dialog of
//! card/more-ops.ts): pasting bytes, what to compare with, and the amount or
//! mask of an operation. Expressions preview their result as they are typed.

use bitviewer_core::integers::{Base, Bits, format_int};
use bitviewer_core::interpretations::{ByteOrder, bytes_to_value, parse_bytes};
use bitviewer_core::ops::Op;
use gpui_kit::component::WindowExt;
use gpui_kit::component::input::{InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::*;

use super::CardView;
use crate::expr_field::{self, Fitted};
use crate::modal;
use crate::theme;
use crate::value_dialogs::field_box;
use crate::widgets::{Btn, Look, SegSize, r, seg_button, seg_track};

fn label(text: impl Into<SharedString>) -> Div {
    div().mt(r(4.0)).mb(r(8.0)).text_color(theme::current().muted).child(text.into())
}

// ------------------------------------------------------------ paste bytes
pub struct BytesView {
    card: WeakEntity<CardView>,
    width: usize,
    area: Entity<TextareaState>,
    order: ByteOrder,
    _subscription: Subscription,
}

impl BytesView {
    /// The value the bytes make, or why not (None while empty).
    fn result(&self, cx: &App) -> Option<Result<(Bits, usize), String>> {
        let text = self.area.read(cx).value().to_string();
        if text.trim().is_empty() {
            return None;
        }
        Some(
            parse_bytes(&text)
                .and_then(|bytes| bytes_to_value(&bytes, self.width, self.order).map(|value| (value, bytes.len())))
                .map_err(|error| error.message),
        )
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(Ok((value, _))) = self.result(cx) {
            window.close_dialog(cx);
            self.card.update(cx, |card, cx| card.set_value_guarded(value, None, None, window, cx)).ok();
        }
    }
}

impl Render for BytesView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let result = self.result(cx);
        let preview = div().mt(r(6.0)).flex().min_h(r(18.0)).font_family(theme::mono()).text_size(r(12.5));
        let preview = match &result {
            None => preview.child(div().text_color(palette.muted).child(format!("Up to {} bytes", self.width.div_ceil(8)))),
            Some(Err(error)) => preview.child(div().font_family(theme::ui()).text_color(palette.error).child(error.clone())),
            Some(Ok((value, count))) => preview
                .child(div().text_color(palette.accent).font_weight(FontWeight::BOLD).child("= "))
                .child(format_int(*value, Base::Hex, self.width, true, true))
                .child(div().text_color(palette.muted).child(format!(" · {count} byte{}", if *count == 1 { "" } else { "s" }))),
        };
        let mut orders = seg_track();
        for (order, text) in [(ByteOrder::Big, "Big-endian"), (ByteOrder::Little, "Little-endian")] {
            orders = orders.child(seg_button(text, text, self.order == order, SegSize::Normal).on_click(cx.listener(move |this, _, _, cx| {
                this.order = order;
                cx.notify();
            })));
        }
        let invalid = matches!(result, Some(Err(_)));
        div()
            .flex()
            .flex_col()
            .child(label("Bytes"))
            .child(
                div()
                    .debug_selector(|| "prompt-input".into())
                    .h(r(72.0))
                    .px(r(10.0))
                    .py(r(8.0))
                    .rounded(r(8.0))
                    .border_1()
                    .border_color(if invalid { palette.error } else { palette.border_strong })
                    .bg(if invalid { palette.error_bg } else { palette.input })
                    .font_family(theme::mono())
                    .child(Textarea::new(&self.area).appearance(false).h_full()),
            )
            .child(preview)
            .child(label("Byte order"))
            .child(div().flex().child(orders))
    }
}

// ------------------------------------------------------------ expressions
/// An expression field for the card, with its result previewed.
pub struct ExprView {
    card: WeakEntity<CardView>,
    input: Entity<InputState>,
    width: usize,
    result: Option<Result<Fitted, String>>,
    /// The shift / rotate kinds to choose from (the operand dialog of a shift).
    kinds: Option<Op>,
    /// Other values to take (compare): (name, width, value), a filter, and the one picked.
    candidates: Option<(Vec<(String, usize, Bits)>, Entity<InputState>, bool, Option<usize>)>,
    hint: SharedString,
    on_submit: Box<dyn Fn(&mut CardView, Option<Op>, Bits, &mut Window, &mut Context<CardView>)>,
    _subscriptions: Vec<Subscription>,
}

impl ExprView {
    fn refresh(&mut self, cx: &mut Context<Self>) {
        let text = self.input.read(cx).value().trim().to_string();
        self.result = (!text.is_empty()).then(|| {
            let known = self.card.update(cx, |card, cx| card.known_names(&text, cx)).unwrap_or_default();
            expr_field::evaluate_for(&text, self.width, &known)
        });
        cx.notify();
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Ok(fitted)) = self.result.clone() else { return };
        window.close_dialog(cx);
        let kind = self.kinds;
        let on_submit = std::mem::replace(&mut self.on_submit, Box::new(|_, _, _, _, _| {}));
        self.card.update(cx, |card, cx| on_submit(card, kind, fitted.value, window, cx)).ok();
    }

    fn fill(&mut self, value: Bits, width: usize, window: &mut Window, cx: &mut Context<Self>) {
        let text = format_int(value, Base::Hex, width, true, false);
        self.input.update(cx, |input, cx| input.set_value(text, window, cx));
        self.refresh(cx);
    }

    fn ready(&self) -> bool {
        matches!(self.result, Some(Ok(_)))
    }
}

impl Render for ExprView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let mut body = div().flex().flex_col();
        if let Some(chosen) = self.kinds {
            let mut kinds = seg_track();
            for (op, text, tip) in [
                (Op::Shl, "≪ SHL", "Shift left"),
                (Op::Shr, "≫ SHR", "Shift right"),
                (Op::Asr, "≫ ASR", "Arithmetic shift right"),
                (Op::Rol, "⟲ ROL", "Rotate left"),
                (Op::Ror, "⟳ ROR", "Rotate right"),
            ] {
                kinds = kinds.child(
                    seg_button(text, text, chosen == op, SegSize::Normal)
                        .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(tip).build(window, cx))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.kinds = Some(op);
                            cx.notify();
                        })),
                );
            }
            body = body.child(label("Operation")).child(div().flex().child(kinds));
        }
        body = body
            .child(label(self.hint.clone()))
            .child(div().debug_selector(|| "prompt-input".into()).child(field_box(&self.input, matches!(self.result, Some(Err(_))), 32.0, true)))
            .child(div().mt(r(6.0)).child(expr_field::preview(self.result.as_ref(), self.width)));
        let Some((candidates, filter, open, picked)) = &self.candidates else { return body };
        let (open, picked) = (*open, *picked);
        let summary = div()
            .id("compare-pick")
            .mt(r(14.0))
            .py(r(2.0))
            .flex()
            .items_center()
            .gap(r(6.0))
            .cursor_pointer()
            .text_color(palette.muted)
            .hover(move |style| style.text_color(palette.text))
            .on_click(cx.listener(|this, _, window, cx| {
                if let Some((_, filter, open, _)) = &mut this.candidates {
                    *open = !*open;
                    if *open {
                        filter.update(cx, |input, cx| input.focus(window, cx));
                    }
                }
                cx.notify();
            }))
            .child(crate::widgets::icon(if open { "chevron-down" } else { "chevron-right" }, 14.0).text_color(palette.muted))
            .child(format!("Or take the value of another one in the workspace ({})", candidates.len()));
        body = body.child(summary);
        if !open {
            return body;
        }
        let query = filter.read(cx).value().trim().to_lowercase();
        let matching: Vec<usize> = (0..candidates.len()).filter(|i| query.is_empty() || candidates[*i].0.to_lowercase().contains(&query)).collect();
        const MAX_LISTED: usize = 200;
        let mut list = div()
            .id("compare-list")
            .flex()
            .flex_col()
            .max_h(window.viewport_size().height * 0.34)
            .overflow_y_scroll()
            .border_1()
            .border_color(palette.border)
            .rounded(r(10.0))
            .bg(palette.surface_2);
        for &index in matching.iter().take(MAX_LISTED) {
            let (name, width, value) = candidates[index].clone();
            list = list.child(
                div()
                    .id(("candidate", index))
                    .flex()
                    .items_center()
                    .gap(r(10.0))
                    .px(r(10.0))
                    .py(r(6.0))
                    .border_b_1()
                    .border_color(palette.border)
                    .cursor_pointer()
                    .when(picked == Some(index), |item| item.bg(palette.accent_soft))
                    .hover(move |style| style.bg(palette.surface_3))
                    .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
                        this.fill(value, width, window, cx);
                        if let Some((_, _, _, picked)) = &mut this.candidates {
                            *picked = Some(index);
                        }
                        if event.click_count() >= 2 {
                            this.submit(window, cx);
                        }
                    }))
                    .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_ellipsis().child(name))
                    .child(
                        div()
                            .font_family(theme::mono())
                            .text_size(r(12.0))
                            .text_color(palette.muted)
                            .child(format!("{width}-bit · {}", format_int(value, Base::Hex, width, true, true))),
                    ),
            );
        }
        let note = if matching.is_empty() {
            "No values match".to_string()
        } else if matching.len() > MAX_LISTED {
            format!("{} more: type to narrow the list", matching.len() - MAX_LISTED)
        } else {
            String::new()
        };
        if !note.is_empty() {
            list = list.child(div().px(r(10.0)).py(r(8.0)).text_size(r(12.0)).text_color(palette.muted).child(note));
        }
        body.child(div().my(r(8.0)).child(field_box(filter, false, 32.0, false))).child(list)
    }
}

impl CardView {
    /// "Paste bytes…": bytes in any common notation, either byte order.
    pub(crate) fn paste_bytes_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let card = cx.entity().downgrade();
        let width = self.value.width;
        let view = cx.new(|cx| {
            let area = cx.new(|cx| TextareaState::new(window, cx).placeholder("DE AD BE EF   ·   {0xDE, 0xAD}   ·   deadbeef   ·   b'\\xde\\xad'"));
            area.update(cx, |area, cx| area.focus(window, cx));
            let subscription = cx.subscribe(&area, |_, _, _: &InputEvent, cx| cx.notify());
            BytesView { card, width, area, order: ByteOrder::Big, _subscription: subscription }
        });
        window.open_dialog(cx, move |dialog, _, cx| {
            let ready = matches!(view.read(cx).result(cx), Some(Ok(_)));
            let submit = view.clone();
            modal::frame(dialog, "clipboard-paste", "Paste bytes", true).child(view.clone()).footer(
                modal::footer().child(Btn::new("bytes-cancel", Look::Ghost).label("Cancel").on_click(|_, window, cx| window.close_dialog(cx))).child(
                    Btn::new("bytes-ok", Look::Primary)
                        .label("Set value")
                        .disabled(!ready)
                        .test_label("prompt-ok")
                        .on_click(move |_, window, cx| submit.update(cx, |view, cx| view.submit(window, cx))),
                ),
            )
        });
    }

    fn open_expr_dialog(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        options: (&'static str, String, &'static str, String, String, usize),
        kinds: Option<Op>,
        candidates: Option<Vec<(String, usize, Bits)>>,
        on_submit: impl Fn(&mut CardView, Option<Op>, Bits, &mut Window, &mut Context<CardView>) + 'static,
    ) {
        let (icon, title, ok_label, hint, initial, width) = options;
        let card = cx.entity().downgrade();
        // the starting text's result (the card can't be asked while it opens the dialog)
        let text = initial.trim().to_string();
        let first_result = (!text.is_empty()).then(|| expr_field::evaluate_for(&text, width, &self.known_names(&text, cx)));
        let view = cx.new(|cx| {
            let input = cx.new(|cx| InputState::new(window, cx).default_value(initial));
            input.update(cx, |input, cx| {
                input.focus(window, cx);
                input.select_all(window, cx);
            });
            let mut subscriptions = vec![cx.subscribe_in(&input, window, |this: &mut ExprView, _, event: &InputEvent, window, cx| match event {
                InputEvent::Change => this.refresh(cx),
                InputEvent::PressEnter { .. } => this.submit(window, cx),
                _ => {}
            })];
            let candidates = candidates.map(|list| {
                let filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter by name…"));
                subscriptions.push(cx.subscribe(&filter, |_, _, _: &InputEvent, cx| cx.notify()));
                (list, filter, false, None)
            });
            ExprView {
                card,
                input,
                width,
                result: first_result,
                kinds,
                candidates,
                hint: hint.into(),
                on_submit: Box::new(on_submit),
                _subscriptions: subscriptions,
            }
        });
        window.open_dialog(cx, move |dialog, _, cx| {
            let ready = view.read(cx).ready();
            let submit = view.clone();
            let wide = view.read(cx).candidates.is_some();
            modal::frame(dialog, icon, title.clone(), wide).child(view.clone()).footer(
                modal::footer().child(Btn::new("expr-dialog-cancel", Look::Ghost).label("Cancel").on_click(|_, window, cx| window.close_dialog(cx))).child(
                    Btn::new("expr-dialog-ok", Look::Primary)
                        .label(ok_label)
                        .disabled(!ready)
                        .test_label("prompt-ok")
                        .on_click(move |_, window, cx| submit.update(cx, |view, cx| view.submit(window, cx))),
                ),
            )
        });
    }

    /// The amount of a shift or rotate (with its kind), or the mask of AND / OR / XOR.
    #[cfg(test)]
    pub(crate) fn operand_prompt(&mut self, op: Op, window: &mut Window, cx: &mut Context<Self>) {
        self.operand_prompt_on(None, op, window, cx)
    }

    /// The operand dialog for a row (or its compare row) when `row` is given.
    pub(crate) fn operand_prompt_on(&mut self, row: Option<(usize, bool)>, op: Op, window: &mut Window, cx: &mut Context<Self>) {
        let shift = matches!(op, Op::Shl | Op::Shr | Op::Asr | Op::Rol | Op::Ror);
        let width = row.map_or(self.value.width, |(lo, _)| self.value.row_width_at(lo));
        let title = if shift {
            "Shift / rotate by…".to_string()
        } else {
            match op {
                Op::And => "AND with mask",
                Op::Or => "OR with mask",
                _ => "XOR with mask",
            }
            .to_string()
        };
        let hint = if shift { "Number of bits".to_string() } else { format!("Mask ({width} bits) — numbers, expressions, or names of values and fields") };
        let initial = if shift { "1".to_string() } else { String::new() };
        self.open_expr_dialog(
            window,
            cx,
            ("sigma", title, "Apply", hint, initial, if shift { 16 } else { width }),
            shift.then_some(op),
            None,
            move |card, kind, argument, window, cx| card.apply_op_on(row, kind.unwrap_or(op), argument, window, cx),
        );
    }

    /// "Compare with…": a number or expression, or another value's bits.
    pub(crate) fn compare_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let value = self.value.clone();
        let candidates: Vec<(String, usize, Bits)> = self
            .workspace
            .upgrade()
            .map(|workspace| {
                workspace
                    .read(cx)
                    .state()
                    .values
                    .iter()
                    .filter(|other| other.id != value.id)
                    .map(|other| (other.name.to_string(), other.width, other.value))
                    .collect()
            })
            .unwrap_or_default();
        let name = if value.name.is_empty() { "value".to_string() } else { value.name.to_string() };
        self.open_expr_dialog(
            window,
            cx,
            (
                "git-compare-arrows",
                format!("Compare “{name}” with…"),
                "Compare",
                "Value to compare with: a number or an expression. x is this value; use other values by name, {braces} for names with spaces.".to_string(),
                format_int(value.value, Base::Hex, value.width, true, false),
                value.width,
            ),
            None,
            (!candidates.is_empty()).then_some(candidates),
            |card, _, other, window, cx| {
                card.commit(None, window, cx, move |v| Ok(v.compare_with(other)));
                crate::sound::play(crate::sound::Sound::Toggle, cx);
            },
        );
    }
}

use gpui_kit::prelude::FluentBuilder as _;
