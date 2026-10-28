//! The template picker (the user's templates and the built-in ones) and
//! saving fields as a template, as the web app's dialogs/templates.ts.

use std::rc::Rc;

use bitviewer_core::templates::{Template, builtin_templates, template_from_json, template_to_json};
use gpui_kit::component::WindowExt;
use gpui_kit::component::notification::Notification;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::*;

use crate::app_state;
use crate::modal;
use crate::theme;
use crate::widgets::{Btn, Look, r};

/// The user's saved templates (unusable entries skipped), in saved order.
pub fn user_templates(cx: &App) -> Vec<Template> {
    app_state::settings(cx).templates.iter().filter_map(template_from_json).collect()
}

/// Saves `template` as the user's, replacing one with the same name.
pub fn save(template: &Template, window: &mut Window, cx: &mut App) {
    let name = template.name.to_lowercase();
    let json = template_to_json(template);
    app_state::update(cx, |settings| {
        settings.templates.retain(|saved| saved.get("name").and_then(|n| n.as_str()).is_none_or(|n| n.to_lowercase() != name));
        settings.templates.push(json);
    });
    window.push_notification(Notification::success(format!("Saved template “{}”", template.name)), cx);
}

type OnPick = Rc<dyn Fn(Template, &mut Window, &mut App)>;

pub struct PickerView {
    /// (user template?, position) of the chosen one.
    chosen: Option<(bool, usize)>,
    builtins: Vec<Template>,
}

impl PickerView {
    fn chosen(&self, cx: &App) -> Option<Template> {
        match self.chosen? {
            (true, index) => user_templates(cx).get(index).cloned(),
            (false, index) => self.builtins.get(index).cloned(),
        }
    }
}

/// Lets the user pick a template; `on_pick` gets it.
pub fn pick(window: &mut Window, cx: &mut App, title: String, ok_label: &'static str, on_pick: impl Fn(Template, &mut Window, &mut App) + 'static) {
    let on_pick: OnPick = Rc::new(on_pick);
    let picker = cx.new(|_| PickerView { chosen: None, builtins: builtin_templates() });
    let picker_for_view = picker.clone();
    let on_pick_view = on_pick.clone();
    window.open_dialog(cx, move |dialog, _, cx| {
        let picker = picker_for_view.clone();
        let on_pick = on_pick_view.clone();
        let has_choice = picker.read(cx).chosen.is_some();
        let list = TemplateList { picker: picker.clone(), on_pick: on_pick.clone() };
        modal::frame(dialog, "layout-template", title.clone(), true).child(list).footer(
            modal::footer().child(Btn::new("tpl-cancel", Look::Ghost).label("Cancel").on_click(|_, window, cx| window.close_dialog(cx))).child(
                Btn::new("tpl-ok", Look::Primary).label(ok_label).disabled(!has_choice).on_click(move |_, window, cx| {
                    if let Some(template) = picker.read(cx).chosen(cx) {
                        window.close_dialog(cx);
                        on_pick(template, window, cx);
                    }
                }),
            ),
        )
    });
}

/// A mini bar of the template's fields, MSB on the left.
fn preview(template: &Template) -> Div {
    let palette = theme::current();
    let mut fields: Vec<_> = template.fields.iter().collect();
    fields.sort_by_key(|field| std::cmp::Reverse(field.hi));
    let mut bar = div().flex().gap(px(2.0)).h(r(16.0));
    let gap = |count: usize| {
        let mut gap = div().rounded(px(3.0)).bg(palette.track);
        gap.style().flex_grow = Some(count as f32);
        gap.style().flex_basis = Some(px(0.0).into());
        gap
    };
    let mut next = template.width as isize - 1;
    for field in fields {
        if (field.hi as isize) < next {
            bar = bar.child(gap((next - field.hi as isize) as usize));
        }
        let width = field.hi - field.lo + 1;
        let color = field.color.as_deref().map_or(rgb(0x868e96), |color| theme::field_color(color, 1.0));
        let mut piece = div()
            .min_w(px(3.0))
            .rounded(px(3.0))
            .bg(color)
            .text_color(gpui_kit::white())
            .font_weight(FontWeight::BOLD)
            .text_size(r(9.5))
            .line_height(r(16.0))
            .flex()
            .justify_center()
            .overflow_hidden()
            .whitespace_nowrap();
        piece.style().flex_grow = Some(width as f32);
        piece.style().flex_basis = Some(px(0.0).into());
        if width as f32 >= (template.width as f32 / 12.0).max(3.0) {
            piece = piece.child(field.name.clone());
        }
        bar = bar.child(piece);
        next = field.lo as isize - 1;
    }
    if next >= 0 {
        bar = bar.child(gap(next as usize + 1));
    }
    bar
}

#[derive(IntoElement)]
struct TemplateList {
    picker: Entity<PickerView>,
    on_pick: OnPick,
}

impl RenderOnce for TemplateList {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = theme::current();
        let chosen = self.picker.read(cx).chosen;
        let users = user_templates(cx);
        let builtins = self.picker.read(cx).builtins.clone();
        let mut list = div().id("tpl-list").flex().flex_col().gap(r(6.0)).max_h(r(480.0)).overflow_y_scroll().pr(r(4.0));
        for (user, items) in [(true, users), (false, builtins)] {
            if items.is_empty() {
                continue;
            }
            list = list.child(div().mt(r(10.0)).mb(r(2.0)).text_size(r(11.0)).font_weight(FontWeight::BOLD).text_color(palette.muted).child(if user {
                "YOUR TEMPLATES"
            } else {
                "BUILT-IN"
            }));
            for (index, template) in items.into_iter().enumerate() {
                let on = chosen == Some((user, index));
                let picker = self.picker.clone();
                let on_pick = self.on_pick.clone();
                let picked = template.clone();
                let count = template.fields.len();
                let mut head = div()
                    .flex()
                    .items_center()
                    .gap(r(10.0))
                    .child(div().font_weight(FontWeight::BOLD).child(template.name.clone()))
                    .child(div().font_family(theme::mono()).text_size(r(12.0)).text_color(palette.muted).child(format!(
                        "{}-bit · {count} field{}",
                        template.width,
                        if count == 1 { "" } else { "s" }
                    )))
                    .child(div().flex_1());
                if user {
                    let name = template.name.clone();
                    let picker = self.picker.clone();
                    head = head.child(Btn::new(("tpl-delete", index), Look::Danger).small().icon("trash").tip("Delete this template").on_click(
                        move |_, window, cx| {
                            cx.stop_propagation();
                            app_state::update(cx, |settings| {
                                settings.templates.retain(|saved| saved.get("name").and_then(|n| n.as_str()) != Some(&name));
                            });
                            picker.update(cx, |picker, cx| {
                                picker.chosen = None;
                                cx.notify();
                            });
                            window.refresh();
                        },
                    ));
                }
                let mut item = div()
                    .id(("tpl", index * 2 + user as usize))
                    .flex()
                    .flex_col()
                    .gap(r(6.0))
                    .px(r(12.0))
                    .py(r(10.0))
                    .bg(palette.surface_2)
                    .border_1()
                    .border_color(if on { palette.accent } else { palette.border })
                    .rounded(r(10.0))
                    .cursor_pointer()
                    .hover(move |style| if on { style } else { style.border_color(palette.border_strong) })
                    .child(head);
                if on {
                    item = item.shadow(vec![BoxShadow {
                        color: palette.accent_soft.into(),
                        offset: point(px(0.0), px(0.0)),
                        blur_radius: px(0.0),
                        spread_radius: px(3.0),
                        inset: false,
                    }]);
                }
                if let Some(description) = &template.description {
                    item = item.child(div().text_size(r(12.0)).text_color(palette.muted).child(description.clone()));
                }
                let tip = template.name.clone();
                item =
                    item.child(preview(&template)).tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx)).on_click(move |event, window, cx| {
                        if event.click_count() >= 2 {
                            window.close_dialog(cx);
                            on_pick(picked.clone(), window, cx);
                            return;
                        }
                        picker.update(cx, |picker, cx| {
                            picker.chosen = Some((user, index));
                            cx.notify();
                        });
                        window.refresh();
                    });
                list = list.child(item);
            }
        }
        list
    }
}
