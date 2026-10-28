//! The window around the workspace, drawn like the web app's chrome.css:
//! the black title bar (logo, menu bar, file name, window buttons), the
//! toolbar, the status bar with the zoom, and the empty state. Buttons
//! dispatch the same actions as the menus and shortcuts (commands.rs).

use bitviewer_core::integers::Base;
use gpui_kit::*;

use super::WorkspaceView;
use crate::app_state;
use crate::commands::{Add32, Add64, AddCustom, Open, Redo, Save, Settings as OpenSettings, ToggleTheme, Undo, ZoomIn, ZoomOut, ZoomReset};
use crate::theme::{self, title};
use crate::widgets::{Btn, Look, icon, r};

/// The app mark: a 4×4 grid of bits on a rounded tile (logo.ts).
pub fn logo(size: f32) -> Div {
    const ACTIVE: [u8; 16] = [1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1];
    let unit = size / 64.0;
    let mut tile = div().relative().flex_none().size(r(size)).rounded(r(14.0 * unit)).bg(rgb(0x0e0e11)).border(r(1.5 * unit)).border_color(rgb(0x2c2c33));
    for (index, on) in ACTIVE.iter().enumerate() {
        let (column, row) = ((index % 4) as f32, (index / 4) as f32);
        tile = tile.child(
            div()
                .absolute()
                .left(r((8.0 + column * 12.0) * unit))
                .top(r((8.0 + row * 12.0) * unit))
                .size(r(10.0 * unit))
                .rounded(r(2.5 * unit))
                .bg(if *on == 1 { theme::accent() } else { rgb(0x2a2a31) }),
        );
    }
    tile
}

/// Dispatches `action` from a button.
fn run<A: Action + Clone>(action: A) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
    move |_, window, cx| window.dispatch_action(Box::new(action.clone()), cx)
}

impl WorkspaceView {
    /// The title bar (chrome.css .titlebar): logo, menu bar, the file name
    /// (where the window is dragged) and the window buttons. It keeps its
    /// dark colours in every theme, as the web app's does.
    pub(super) fn render_titlebar(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let file = format!("{}{}", self.file_name, if self.is_dirty() { " •" } else { "" });
        let mut menus = div().flex().gap(r(2.0));
        for (index, (name, _)) in crate::commands::MENUS.iter().enumerate() {
            let item = div()
                .id(("menubar", index))
                .flex()
                .items_center()
                .h(r(26.0))
                .px(r(10.0))
                .rounded(r(6.0))
                .text_size(r(13.0))
                .text_color(title::text())
                .cursor_pointer()
                .hover(|style| style.bg(title::hover()).text_color(gpui_kit::white()))
                .child(*name);
            menus = menus.child(crate::widgets::with_menu(item, Anchor::TopLeft, move |menu, window, cx| super::document::menu_items(index, menu, window, cx)));
        }
        let maximized = window.is_maximized();
        let button = |id: &'static str, icon_name: &'static str, area: WindowControlArea, close: bool| {
            let hover = if close { rgb(0xe5383b) } else { rgb(0x1f1f25) };
            div()
                .id(id)
                .w(r(46.0))
                .h_full()
                .flex()
                .items_center()
                .justify_center()
                .group(id)
                .hover(move |style| style.bg(hover))
                .window_control_area(area)
                .child(icon(icon_name, if close { 16.0 } else { 13.0 }).text_color(title::text()).group_hover(id, |style| style.text_color(gpui_kit::white())))
        };
        div()
            .id("titlebar")
            .flex()
            .flex_none()
            .items_center()
            .h(r(38.0))
            .bg(title::bg())
            .border_b_1()
            .border_color(title::border())
            .child(div().flex().items_center().h_full().pl(r(12.0)).pr(r(8.0)).child(logo(20.0)))
            .child(crate::tour::anchor("menubar", menus))
            .child(
                div()
                    .id("title-drag")
                    .flex_1()
                    .h_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .gap(r(10.0))
                    .min_w_0()
                    .text_size(r(12.5))
                    .window_control_area(WindowControlArea::Drag)
                    .child(div().font_weight(FontWeight::SEMIBOLD).text_color(rgb(0xd6d6dc)).child("Bit Viewer"))
                    .child(div().text_color(rgb(0x3b3b43)).child("—"))
                    .child(
                        div()
                            .text_color(rgb(0x77777f))
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .debug_selector(|| "title-file".into())
                            .child(file),
                    ),
            )
            .child(
                div()
                    .flex()
                    .h_full()
                    .child(button("win-min", "minus", WindowControlArea::Min, false).on_click(|_, window, _| window.minimize_window()))
                    .child(
                        button("win-max", if maximized { "copy" } else { "square" }, WindowControlArea::Max, false)
                            .on_click(|_, window, _| window.zoom_window()),
                    )
                    .child(
                        button("win-close", "x", WindowControlArea::Close, true)
                            .on_click(cx.listener(|_, _, window, cx| window.dispatch_action(Box::new(crate::commands::Quit), cx))),
                    ),
            )
    }

    /// The bar under the title bar (datasheet.dc.html's header): the
    /// peripheral tabs that page through the workspace, then find, undo,
    /// open and save, adding values, the theme and the settings.
    pub(super) fn render_toolbar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let settings = app_state::settings(cx);
        let dark = settings.theme != "light";
        let new_value = Btn::new("tb-new", Look::Primary).icon("plus").label("New value").tip("Add a value").menu(Anchor::TopRight, |menu, _, _| {
            menu.menu("32-bit value   Ctrl+1", Box::new(Add32))
                .menu("64-bit value   Ctrl+2", Box::new(Add64))
                .menu("Custom width…   Ctrl+3", Box::new(AddCustom))
                .separator()
                .menu("From an expression…", Box::new(crate::commands::AddFromExpr))
                .menu("From a template…", Box::new(crate::commands::AddFromTemplate))
                .separator()
                .menu("Import CMSIS-SVD…", Box::new(crate::commands::ImportSvd))
        });

        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(r(4.0))
            .h(r(48.0))
            .pl(r(16.0))
            .pr(r(10.0))
            .bg(palette.bg)
            .border_b_1()
            .border_color(palette.border)
            .child(div().flex_1())
            .child(
                div()
                    .id("tb-find")
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(r(8.0))
                    .h(r(30.0))
                    .w(r(220.0))
                    .px(r(10.0))
                    .rounded(r(6.0))
                    .border_1()
                    .border_color(palette.border)
                    .bg(palette.surface)
                    .text_color(palette.muted)
                    .cursor_text()
                    .hover(move |style| style.border_color(palette.muted))
                    .on_click(run(crate::commands::Find))
                    .child(icon("search", 14.0).text_color(palette.muted))
                    .child(div().flex_1().child("Jump to register"))
                    .child(div().font_family(theme::mono()).text_size(r(11.0)).child("Ctrl F")),
            )
            .child(div().w(r(4.0)).flex_none())
            .child(crate::tour::anchor(
                "undo",
                Btn::new("tb-undo", Look::Ghost)
                    .icon("undo-2")
                    .tip("Undo (Ctrl+Z)")
                    .disabled(!self.history.can_undo())
                    .test_label("toolbar-undo")
                    .on_click(run(Undo)),
            ))
            .child(Btn::new("tb-redo", Look::Ghost).icon("redo-2").tip("Redo (Ctrl+Y)").disabled(!self.history.can_redo()).on_click(run(Redo)))
            .child(Btn::new("tb-open", Look::Ghost).icon("folder-open").tip("Open a workspace (Ctrl+O)").on_click(run(Open)))
            .child(Btn::new("tb-save", Look::Ghost).icon("save").tip("Save the workspace (Ctrl+S)").on_click(run(Save)))
            .child({
                let workspace = cx.entity().downgrade();
                Btn::new("tb-bases", Look::Ghost).icon("binary").tip("Show every value in one base").menu(Anchor::TopRight, move |mut menu, _, _| {
                    for base in Base::ORDER {
                        let workspace = workspace.clone();
                        menu = menu.item(gpui_kit::component::menu::PopupMenuItem::new(format!("All values in {}", base.name())).on_click(
                            move |_, window, cx| {
                                workspace.update(cx, |this, cx| this.apply_global_base(base, window, cx)).ok();
                            },
                        ));
                    }
                    menu
                })
            })
            .child(div().w(r(4.0)).flex_none())
            .child(crate::tour::anchor("add", new_value))
            .child(
                Btn::new("tb-theme", Look::Ghost)
                    .icon(if dark { "sun" } else { "moon" })
                    .tip(if dark { "Light theme (Ctrl+T)" } else { "Dark theme (Ctrl+T)" })
                    .on_click(run(ToggleTheme)),
            )
            .child(Btn::new("tb-settings", Look::Ghost).icon("sliders-horizontal").tip("Settings (Ctrl+,)").on_click(run(OpenSettings)))
    }

    pub(super) fn render_statusbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let zoom = app_state::settings(cx).zoom;
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(r(8.0))
            .h(r(28.0))
            .pl(r(14.0))
            .pr(r(8.0))
            .bg(theme::surface())
            .border_t_1()
            .border_color(theme::border())
            .text_color(theme::muted())
            .text_size(r(12.0))
            .child(
                div()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .child("Click a bit to flip · drag to select · right-click for row actions · F1 for help"),
            )
            .child(div().flex_1())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(r(2.0))
                    .child(Btn::new("zoom-out", Look::Ghost).icon("minus").tiny().tip("Zoom out (Ctrl+-)").on_click(run(ZoomOut)))
                    .child(
                        div()
                            .id("zoom-reset")
                            .min_w(r(48.0))
                            .h(r(22.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(r(6.0))
                            .font_family(theme::mono())
                            .font_weight(FontWeight::MEDIUM)
                            .cursor_pointer()
                            .hover(|style| style.bg(theme::surface_3()).text_color(theme::text()))
                            .debug_selector(|| "zoom-label".into())
                            .child(format!("{}%", (zoom * 100.0).round()))
                            .on_click(run(ZoomReset)),
                    )
                    .child(Btn::new("zoom-in", Look::Ghost).icon("plus").tiny().tip("Zoom in (Ctrl+=)").on_click(run(ZoomIn))),
            )
    }

    /// Shown when there are no values.
    pub(super) fn render_empty(&self) -> impl IntoElement {
        div()
            .m_auto()
            .flex()
            .flex_col()
            .items_center()
            .gap(r(8.0))
            .py(r(60.0))
            .child(logo(56.0))
            .child(div().mt(r(10.0)).text_size(r(17.0)).font_weight(FontWeight::SEMIBOLD).child("No values yet"))
            .child(div().mb(r(10.0)).text_color(theme::muted()).child("Add a value to start inspecting bits."))
            .child(
                div()
                    .flex()
                    .gap(r(8.0))
                    .child(Btn::new("empty-add32", Look::Primary).icon("plus").label("32-bit value").on_click(run(Add32)))
                    .child(Btn::new("empty-add64", Look::Outline).icon("plus").label("64-bit value").on_click(run(Add64)))
                    .child(Btn::new("empty-custom", Look::Outline).icon("ruler").label("Custom width").on_click(run(AddCustom))),
            )
    }

    /// The sidebar: every register, each peripheral, and the registers of
    /// the open one (click to scroll to it). One virtual list, so huge
    /// SVD workspaces stay quick.
    pub(super) fn render_sidebar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let rows = self.sidebar_rows();
        let count = rows.len();
        let list = uniform_list(
            "sidebar",
            count,
            cx.processor(move |this, range: std::ops::Range<usize>, _window, cx| {
                let palette = theme::current();
                let rows = this.sidebar_rows();
                range
                    .filter_map(|index| rows.get(index).cloned().map(|row| (index, row)))
                    .map(|(index, row)| match row {
                        SideRow::Page(page, label, count) => {
                            let on = this.page == page;
                            div()
                                .id(("side-page", index))
                                .debug_selector({
                                    let key = if page.is_none() { "All".to_string() } else { label.clone() };
                                    move || format!("page-{key}")
                                })
                                .flex()
                                .items_center()
                                .gap(r(8.0))
                                .h(r(34.0))
                                .px(r(10.0))
                                .mt(r(2.0))
                                .rounded(r(8.0))
                                .text_size(r(13.5))
                                .font_weight(FontWeight::SEMIBOLD)
                                .bg(if on { palette.accent_soft } else { theme::transparent() })
                                .text_color(if on { palette.accent } else { palette.text })
                                .cursor_pointer()
                                .hover(move |style| if on { style } else { style.bg(palette.surface_2) })
                                .on_click(cx.listener(move |this, _, _, cx| this.set_page(page.clone(), cx)))
                                .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_ellipsis().child(label))
                                .child(
                                    div()
                                        .font_family(theme::mono())
                                        .text_size(r(11.0))
                                        .font_weight(FontWeight::NORMAL)
                                        .text_color(palette.faint)
                                        .child(count.to_string()),
                                )
                                .into_any_element()
                        }
                        SideRow::Value(value, name) => div()
                            .id(("side-value", index))
                            .flex()
                            .items_center()
                            .h(r(28.0))
                            .pl(r(26.0))
                            .pr(r(10.0))
                            .rounded(r(8.0))
                            .text_size(r(13.0))
                            .text_color(palette.muted)
                            .cursor_pointer()
                            .hover(move |style| style.text_color(palette.text).bg(palette.surface_2))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.scroll_to_value(value);
                                cx.notify();
                            }))
                            .child(div().min_w_0().overflow_hidden().whitespace_nowrap().text_ellipsis().child(SharedString::from(name)))
                            .into_any_element(),
                    })
                    .collect::<Vec<_>>()
            }),
        )
        .flex_1()
        .min_h_0()
        .px(r(10.0))
        .pb(r(16.0));
        div()
            .flex()
            .flex_col()
            .flex_none()
            .w(r(crate::card::SIDEBAR_WIDTH))
            .h_full()
            .bg(palette.surface)
            .border_r_1()
            .border_color(palette.border)
            .child(div().px(r(20.0)).pt(r(18.0)).pb(r(8.0)).text_size(r(11.5)).font_weight(FontWeight::SEMIBOLD).text_color(palette.muted).child("PERIPHERALS"))
            .child(list)
    }
}

/// A row of the sidebar.
#[derive(Clone)]
pub(super) enum SideRow {
    /// A page (None: everything), its label and how many values it has.
    Page(Option<std::sync::Arc<str>>, String, usize),
    /// A value of the open page: its index and name.
    Value(usize, std::sync::Arc<str>),
}
