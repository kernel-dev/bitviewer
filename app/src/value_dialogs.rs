//! Dialogs about values: picking a width (with presets) and a new value
//! computed from an expression, as the web app's dialogs/width.ts and
//! dialogs/new-value.ts.

use std::collections::HashMap;
use std::rc::Rc;

use bitviewer_core::integers::{Bits, MAX_WIDTH, MIN_WIDTH};
use gpui_kit::component::WindowExt;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::*;

use crate::expr_field::{self, Fitted};
use crate::modal;
use crate::theme;
use crate::widgets::{Btn, Look, SegSize, r, seg_button, seg_track};
use crate::workspace_view::WorkspaceView;

const PRESETS: [usize; 7] = [8, 16, 32, 64, 128, 256, 512];

/// A text field drawn like .field, around a text input.
pub fn field_box(input: &Entity<InputState>, invalid: bool, height: f32, mono: bool) -> Div {
    let palette = theme::current();
    div()
        .flex()
        .items_center()
        .h(r(height))
        .px(r(10.0))
        .rounded(r(8.0))
        .border_1()
        .border_color(if invalid { palette.error } else { palette.border_strong })
        .bg(if invalid { palette.error_bg } else { palette.input })
        .when(mono, |field| field.font_family(theme::mono()))
        .child(Input::new(input).appearance(false).w_full())
}

fn label(text: impl Into<SharedString>) -> Div {
    div().mt(r(4.0)).mb(r(8.0)).text_color(theme::current().muted).child(text.into())
}

/// A width typed as a whole number in range, else None.
fn parse_width(text: &str) -> Option<usize> {
    let text = text.trim();
    if text.is_empty() || !text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    text.parse().ok().filter(|width| (MIN_WIDTH..=MAX_WIDTH).contains(width))
}

fn presets(id: &'static str, current: Option<usize>, pick: impl Fn(usize, &mut Window, &mut App) + 'static) -> Div {
    let pick = Rc::new(pick);
    let mut track = seg_track();
    for preset in PRESETS {
        let pick = pick.clone();
        track = track.child(
            seg_button((id, preset), preset.to_string(), current == Some(preset), SegSize::Normal)
                .min_w(r(40.0))
                .justify_center()
                .font_family(theme::mono())
                .on_click(move |_, window, cx| pick(preset, window, cx)),
        );
    }
    track
}

pub struct WidthView {
    input: Entity<InputState>,
    _subscription: Subscription,
}

impl WidthView {
    fn width(&self, cx: &App) -> Option<usize> {
        parse_width(&self.input.read(cx).value())
    }
}

impl Render for WidthView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let text = self.input.read(cx).value().to_string();
        let width = parse_width(&text);
        let invalid = width.is_none() && !text.is_empty();
        let input = self.input.clone();
        div()
            .flex()
            .flex_col()
            .child(label(format!("Number of bits ({MIN_WIDTH}–{MAX_WIDTH})")))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(r(10.0))
                    .child(div().w(r(120.0)).debug_selector(|| "prompt-input".into()).child(field_box(&self.input, invalid, 36.0, true).text_size(r(16.0))))
                    .child(div().text_color(palette.muted).child("bits")),
            )
            .child(
                div()
                    .min_h(r(18.0))
                    .mt(r(6.0))
                    .text_size(r(12.0))
                    .text_color(palette.error)
                    .when(invalid, |error| error.child(format!("Enter a whole number from {MIN_WIDTH} to {MAX_WIDTH}"))),
            )
            .child(label("Presets"))
            .child(presets("width-preset", width, move |preset, window, cx| {
                input.update(cx, |input, cx| {
                    input.set_value(preset.to_string(), window, cx);
                    input.focus(window, cx);
                });
            }))
    }
}

/// Asks for a width; `on_ok` gets it.
pub fn pick_width(
    window: &mut Window,
    cx: &mut App,
    title: impl Into<SharedString>,
    current: usize,
    ok_label: &'static str,
    on_ok: impl Fn(usize, &mut Window, &mut App) + 'static,
) {
    let on_ok: Rc<dyn Fn(usize, &mut Window, &mut App)> = Rc::new(on_ok);
    let title: SharedString = title.into();
    let view = cx.new(|cx| {
        let input = cx.new(|cx| InputState::new(window, cx).default_value(current.to_string()));
        input.update(cx, |input, cx| {
            input.focus(window, cx);
            input.select_all(window, cx);
        });
        let on_enter = on_ok.clone();
        let subscription = cx.subscribe_in(&input, window, move |this: &mut WidthView, _, event: &InputEvent, window, cx| match event {
            InputEvent::Change => cx.notify(),
            InputEvent::PressEnter { .. } => {
                if let Some(width) = this.width(cx) {
                    window.close_dialog(cx);
                    on_enter(width, window, cx);
                }
            }
            _ => {}
        });
        WidthView { input, _subscription: subscription }
    });
    window.open_dialog(cx, move |dialog, _, cx| {
        let valid = view.read(cx).width(cx);
        let view_ok = view.clone();
        let on_ok = on_ok.clone();
        modal::frame(dialog, "ruler", title.clone(), false).child(view.clone()).footer(
            modal::footer().child(Btn::new("width-cancel", Look::Ghost).label("Cancel").on_click(|_, window, cx| window.close_dialog(cx))).child(
                Btn::new("width-ok", Look::Primary).label(ok_label).disabled(valid.is_none()).test_label("prompt-ok").on_click(move |_, window, cx| {
                    if let Some(width) = view_ok.read(cx).width(cx) {
                        window.close_dialog(cx);
                        on_ok(width, window, cx);
                    }
                }),
            ),
        )
    });
}

/// A message with one OK button.
pub fn tell(window: &mut Window, cx: &mut App, title: &'static str, message: String) {
    window.open_dialog(cx, move |dialog, _, _| {
        modal::frame(dialog, "info", title, false).child(div().text_color(theme::current().muted).child(message.clone())).footer(
            modal::footer().child(Btn::new("tell-ok", Look::Primary).label("OK").test_label("dialog-ok").on_click(|_, window, cx| window.close_dialog(cx))),
        )
    });
}

// ------------------------------------------------------------ new value from an expression
pub struct NewValueView {
    expression: Entity<InputState>,
    width: Entity<InputState>,
    name: Entity<InputState>,
    result: Option<Result<Fitted, String>>,
    workspace: WeakEntity<WorkspaceView>,
    _subscriptions: Vec<Subscription>,
}

impl NewValueView {
    fn refresh(&mut self, cx: &mut Context<Self>) {
        let text = self.expression.read(cx).value().trim().to_string();
        let Some(width) = parse_width(&self.width.read(cx).value()) else {
            cx.notify();
            return;
        };
        self.result = (!text.is_empty()).then(|| {
            let mut known = HashMap::new();
            for name in expr_field::names(&text) {
                // "x" has no meaning here (there's no current value yet)
                if name.trim().eq_ignore_ascii_case("x") {
                    continue;
                }
                let found = self.workspace.update(cx, |workspace, _| workspace.value_by_name(&name)).ok().flatten();
                if let Some(bits) = found {
                    known.insert(name, expr_field::to_big(bits));
                }
            }
            expr_field::evaluate_for(&text, width, &known)
        });
        cx.notify();
    }

    /// The value to add, when everything is valid.
    fn ready(&self, cx: &App) -> Option<(String, usize, Bits)> {
        let width = parse_width(&self.width.read(cx).value())?;
        let value = self.result.as_ref()?.as_ref().ok()?.value;
        Some((self.name.read(cx).value().trim().to_string(), width, value))
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((name, width, value)) = self.ready(cx) else { return };
        window.close_dialog(cx);
        self.workspace.update(cx, |workspace, cx| workspace.add_computed_value(&name, width, value, cx)).ok();
    }
}

impl Render for NewValueView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let width_text = self.width.read(cx).value().to_string();
        let width = parse_width(&width_text);
        let expression_invalid = matches!(self.result, Some(Err(_)));
        let width_input = self.width.clone();
        div()
            .flex()
            .flex_col()
            .child(label("Expression — use other values by name; {braces} for names with spaces"))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(r(6.0))
                    .child(field_box(&self.expression, expression_invalid, 32.0, true))
                    .child(expr_field::preview(self.result.as_ref(), width.unwrap_or(32))),
            )
            .child(label("Width"))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(r(10.0))
                    .child(div().w(r(120.0)).child(field_box(&self.width, width.is_none(), 36.0, true).text_size(r(16.0))))
                    .child(div().text_color(palette.muted).child("bits"))
                    .child(presets("expr-width", width, move |preset, window, cx| {
                        width_input.update(cx, |input, cx| input.set_value(preset.to_string(), window, cx));
                    })),
            )
            .child(label("Name"))
            .child(field_box(&self.name, false, 34.0, false))
    }
}

/// "New value from expression…": a value computed from other values.
pub fn new_value_from_expression(workspace: WeakEntity<WorkspaceView>, default_width: usize, window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| {
        let expression = cx.new(|cx| InputState::new(window, cx).placeholder("e.g. {Value 1} ^ {Value 2}   ·   CTRL | bit(31)"));
        let width = cx.new(|cx| InputState::new(window, cx).default_value(default_width.to_string()));
        let name = cx.new(|cx| InputState::new(window, cx).placeholder("Name (optional)"));
        expression.update(cx, |input, cx| input.focus(window, cx));
        let mut subscriptions = Vec::new();
        for input in [&expression, &width, &name] {
            subscriptions.push(cx.subscribe_in(input, window, |this: &mut NewValueView, _, event: &InputEvent, window, cx| match event {
                InputEvent::Change => this.refresh(cx),
                InputEvent::PressEnter { .. } => this.submit(window, cx),
                _ => {}
            }));
        }
        NewValueView { expression, width, name, result: None, workspace, _subscriptions: subscriptions }
    });
    window.open_dialog(cx, move |dialog, _, cx| {
        let ready = view.read(cx).ready(cx).is_some();
        let submit = view.clone();
        modal::frame(dialog, "square-function", "New value from expression", true).child(view.clone()).footer(
            modal::footer().child(Btn::new("expr-cancel", Look::Ghost).label("Cancel").on_click(|_, window, cx| window.close_dialog(cx))).child(
                Btn::new("expr-add", Look::Primary)
                    .label("Add value")
                    .disabled(!ready)
                    .on_click(move |_, window, cx| submit.update(cx, |view, cx| view.submit(window, cx))),
            ),
        )
    });
}

use gpui_kit::prelude::FluentBuilder as _;
