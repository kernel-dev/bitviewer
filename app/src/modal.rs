//! Dialogs drawn like the web app's modals (overlays.css .modal): a framed
//! panel with an icon tile and title, the content, and a footer of buttons.

use crate::kit::component::dialog::Dialog;
use crate::kit::*;

use crate::theme;
use crate::widgets::{icon, r};

/// Narrow (440 px) or wide (620 px), as .modal and .modal.wide.
pub fn frame(dialog: Dialog, icon_name: &'static str, title: impl Into<SharedString>, wide: bool) -> Dialog {
    let palette = theme::current();
    let title: SharedString = title.into();
    dialog
        .title(
            div()
                .flex()
                .items_center()
                .gap(r(10.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(r(30.0))
                        .rounded(r(8.0))
                        .bg(palette.accent_soft)
                        .child(icon(icon_name, 16.0).text_color(palette.accent)),
                )
                .child(div().text_size(r(16.0)).font_weight(FontWeight(650.0)).text_color(palette.text).child(title)),
        )
        .w(px(if wide { 620.0 } else { 440.0 }))
        .bg(palette.surface)
        .border_1()
        .border_color(palette.border_strong)
        .rounded(r(16.0))
        .text_color(palette.text)
        .font_family(theme::ui())
        .text_size(r(13.0))
}

/// A row of footer buttons, right-aligned.
pub fn footer() -> Div {
    div().flex().justify_end().gap(r(8.0)).w_full()
}

/// A settings-style section: an upper-case heading and a card of rows.
pub fn section(name: &'static str, rows: Vec<AnyElement>) -> Div {
    let palette = theme::current();
    let mut card = div().flex().flex_col().bg(palette.surface_2).border_1().border_color(palette.border).rounded(r(12.0)).px(r(14.0));
    for (index, row) in rows.into_iter().enumerate() {
        let mut wrapper = div().py(r(11.0));
        if index > 0 {
            wrapper = wrapper.border_t_1().border_color(palette.border);
        }
        card = card.child(wrapper.child(row));
    }
    div()
        .flex()
        .flex_col()
        .child(div().mt(r(14.0)).mb(r(8.0)).text_size(r(11.0)).font_weight(FontWeight::BOLD).text_color(palette.muted).child(name.to_uppercase()))
        .child(card)
}

/// One setting: its label (and a hint under it) on the left, the control on the right.
pub fn row(label: &'static str, hint: impl Into<SharedString>, control: impl IntoElement) -> AnyElement {
    let palette = theme::current();
    let hint: SharedString = hint.into();
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(r(18.0))
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .child(div().text_size(r(13.5)).child(label))
                .when(!hint.is_empty(), |text| text.child(div().mt(r(2.0)).text_size(r(12.0)).text_color(palette.muted).child(hint))),
        )
        .child(div().flex_none().child(control))
        .into_any_element()
}

/// An on/off switch (controls.css .switch).
pub fn switch(id: impl Into<ElementId>, on: bool, toggle: impl Fn(bool, &mut Window, &mut App) + 'static) -> Stateful<Div> {
    let palette = theme::current();
    div()
        .id(id)
        .relative()
        .flex_none()
        .w(r(38.0))
        .h(r(22.0))
        .rounded(r(11.0))
        .bg(if on { palette.accent } else { palette.border_strong })
        .cursor_pointer()
        .child(div().absolute().top(r(2.0)).left(r(if on { 18.0 } else { 2.0 })).size(r(18.0)).rounded_full().bg(crate::kit::white()).shadow(vec![BoxShadow {
            color: crate::theme::hsla(Rgba::new(0.0, 0.0, 0.0, 0.35)),
            offset: point(px(0.0), px(1.0)),
            blur_radius: px(3.0),
            spread_radius: px(0.0),
            inset: false,
        }]))
        .on_click(move |_, window, cx| toggle(!on, window, cx))
}

use crate::kit::prelude::FluentBuilder as _;

/// Asks a yes/no question; `on_yes` runs when the user agrees.
pub fn confirm(
    window: &mut Window,
    cx: &mut App,
    title: &'static str,
    message: String,
    yes_label: String,
    danger: bool,
    on_yes: impl Fn(&mut Window, &mut App) + 'static,
) {
    use crate::kit::component::WindowExt;
    let on_yes = std::rc::Rc::new(on_yes);
    window.open_dialog(cx, move |dialog, _, _| {
        let palette = theme::current();
        let on_yes = on_yes.clone();
        let yes = crate::widgets::Btn::new("confirm-yes", if danger { crate::widgets::Look::DangerFill } else { crate::widgets::Look::Primary })
            .label(yes_label.clone())
            .test_label("dialog-yes")
            .on_click(move |_, window, cx| {
                window.close_dialog(cx);
                on_yes(window, cx);
            });
        frame(dialog, "info", title, false).child(div().text_color(palette.muted).line_height(rems(1.55 * 13.0 / 16.0)).child(message.clone())).footer(
            footer()
                .child(
                    crate::widgets::Btn::new("confirm-cancel", crate::widgets::Look::Ghost)
                        .label("Cancel")
                        .test_label("dialog-cancel")
                        .on_click(|_, window, cx| window.close_dialog(cx)),
                )
                .child(yes),
        )
    });
}

/// Esc, the ✕ or a click outside: asks first when a form has edits
/// (`changed`), as the web app's forms do.
pub fn guard(dialog: Dialog, changed: impl Fn(&App) -> bool + 'static) -> Dialog {
    use crate::kit::component::WindowExt;
    dialog.on_cancel(move |_, window, cx| {
        if !changed(cx) {
            return true;
        }
        window.open_dialog(cx, |dialog, _, _| {
            let palette = theme::current();
            frame(dialog, "info", "Discard changes?", false)
                .child(div().text_color(palette.muted).child("Your changes in this dialog haven't been saved."))
                .footer(
                    footer()
                        .child(
                            crate::widgets::Btn::new("discard-keep", crate::widgets::Look::Ghost)
                                .label("Keep editing")
                                .test_label("dialog-keep")
                                .on_click(|_, window, cx| window.close_dialog(cx)),
                        )
                        .child(
                            crate::widgets::Btn::new("discard-yes", crate::widgets::Look::DangerFill).label("Discard").test_label("dialog-discard").on_click(
                                |_, window, cx| {
                                    // this question, then the form
                                    window.close_dialog(cx);
                                    window.close_dialog(cx);
                                },
                            ),
                        ),
                )
        });
        false
    })
}

/// Shows a long text in full (a description cut short where it is shown),
/// with Copy, and Edit… when `edit` is given (it opens the editor instead).
pub fn read_text(
    window: &mut Window,
    cx: &mut App,
    title: impl Into<SharedString>,
    text: impl Into<SharedString>,
    edit: Option<std::rc::Rc<dyn Fn(&mut Window, &mut App)>>,
) {
    use crate::kit::component::WindowExt;
    use crate::widgets::{Btn, Look};
    let (title, text): (SharedString, SharedString) = (title.into(), text.into());
    window.open_dialog(cx, move |dialog, _, _| {
        let palette = theme::current();
        let copied = text.clone();
        let mut buttons = footer().child(Btn::new("read-copy", Look::Ghost).icon("copy").label("Copy").on_click(move |_, window, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(copied.to_string()));
            window.close_dialog(cx);
        }));
        if let Some(edit) = edit.clone() {
            buttons = buttons.child(Btn::new("read-edit", Look::Outline).icon("pencil-line").label("Edit…").on_click(move |_, window, cx| {
                window.close_dialog(cx);
                edit(window, cx);
            }));
        }
        buttons = buttons.child(Btn::new("read-close", Look::Primary).label("Close").on_click(|_, window, cx| window.close_dialog(cx)));
        frame(dialog, "scroll-text", title.clone(), true)
            .child(
                div()
                    .id("read-text")
                    .max_h(r(420.0))
                    .overflow_y_scroll()
                    .pr(r(6.0))
                    .text_size(r(14.0))
                    .line_height(rems(1.6 * 14.0 / 16.0))
                    .text_color(palette.text)
                    .child(text.clone()),
            )
            .footer(buttons)
    });
}
