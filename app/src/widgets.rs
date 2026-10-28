//! Building blocks drawn like the web app's controls.css: buttons (ghost,
//! primary, outline, accent-ghost, danger), segmented controls, badges,
//! readout chips and icons. Sizes are the web app's pixels as rems (see
//! `r`), so zooming the window (its rem size) scales everything, as the
//! browser's zoom does.

use std::rc::Rc;

use crate::kit::component::Selectable;
use crate::kit::component::menu::{DropdownMenu, PopupMenu};
use crate::kit::component::tooltip::Tooltip;
use crate::kit::prelude::FluentBuilder as _;
use crate::kit::*;

use crate::theme;

/// A size given in the web app's CSS pixels, scaling with the zoom.
pub fn r(css_px: f32) -> Rems {
    rems(css_px / 16.0)
}

/// A Lucide icon (assets/icons), coloured by the text colour.
pub fn icon(name: &str, size: f32) -> Svg {
    svg().path(SharedString::from(format!("icons/{name}.svg"))).size(r(size)).flex_none()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Look {
    Ghost,
    Primary,
    Outline,
    AccentGhost,
    Danger,
    /// The "on" state of a toggle button (.btn.on).
    On,
    /// A destructive confirmation (.btn.danger-btn).
    DangerFill,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Size {
    Normal,
    #[allow(dead_code)]
    Small,
    Tiny,
}

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// A button: `Btn::new(id, look).icon("plus").label("32-bit").tip(…).on_click(…)`.
#[derive(IntoElement)]
pub struct Btn {
    id: ElementId,
    look: Look,
    size: Size,
    icon: Option<&'static str>,
    label: Option<SharedString>,
    tip: Option<SharedString>,
    disabled: bool,
    handler: Option<Handler>,
    selector: Option<String>,
}

impl Btn {
    pub fn new(id: impl Into<ElementId>, look: Look) -> Self {
        Btn { id: id.into(), look, size: Size::Normal, icon: None, label: None, tip: None, disabled: false, handler: None, selector: None }
    }

    pub fn icon(mut self, name: &'static str) -> Self {
        self.icon = Some(name);
        self
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn tip(mut self, tip: impl Into<SharedString>) -> Self {
        self.tip = Some(tip.into());
        self
    }

    pub fn small(mut self) -> Self {
        self.size = Size::Small;
        self
    }

    pub fn tiny(mut self) -> Self {
        self.size = Size::Tiny;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// A label for tests to find the button by.
    pub fn test_label(mut self, label: impl Into<String>) -> Self {
        self.selector = Some(label.into());
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.handler = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Btn {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        self.build()
    }
}

impl Btn {
    /// The button opening a dropdown menu (anchored at `anchor`).
    pub fn menu(self, anchor: Anchor, items: impl Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu + 'static) -> AnyElement {
        Trigger { inner: self.build(), selected: false }.dropdown_menu_with_anchor(anchor, items).into_any_element()
    }

    fn build(self) -> Stateful<Div> {
        let palette = theme::current();
        let icon_only = self.label.is_none();
        let (height, padding, font, radius) = match self.size {
            Size::Normal => (30.0, 12.0, 13.0, 8.0),
            Size::Small => (26.0, 8.0, 12.0, 7.0),
            Size::Tiny => (22.0, 0.0, 12.0, 6.0),
        };
        let mut button = div()
            .id(self.id)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .gap(r(6.0))
            .h(r(height))
            .rounded(r(radius))
            .border_1()
            .border_color(theme::transparent())
            .text_size(r(font))
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap();
        button = if icon_only { button.w(r(height)) } else { button.px(r(padding)) };

        let (text, icon_color) = match self.look {
            Look::Ghost => (palette.text, palette.muted),
            Look::Primary => (palette.on_accent, palette.on_accent),
            Look::Outline => (palette.text, palette.muted),
            Look::AccentGhost => (palette.accent, palette.accent),
            Look::Danger => (palette.text, palette.muted),
            Look::On => (palette.accent, palette.accent),
            Look::DangerFill => (crate::kit::rgb(0xffffff), crate::kit::rgb(0xffffff)),
        };
        let disabled = self.disabled;
        let text = if disabled { palette.faint } else { text };
        let icon_color = if disabled { palette.faint } else { icon_color };
        button = button.text_color(text);

        button = match self.look {
            Look::Primary if disabled => button.bg(palette.surface_3).border_color(palette.border_strong),
            Look::Primary => button
                .bg(linear_gradient(180.0, linear_color_stop(palette.accent_hover, 0.0), linear_color_stop(palette.accent, 1.0)))
                .border_color(palette.accent_press)
                .font_weight(FontWeight::SEMIBOLD)
                .hover(move |style| style.bg(palette.accent_hover))
                .active(move |style| style.bg(palette.accent_press)),
            Look::Outline => {
                button.border_color(palette.border_strong).when(!disabled, |b| b.hover(move |style| style.border_color(palette.muted).bg(palette.surface_2)))
            }
            Look::Ghost => button.when(!disabled, |b| b.hover(move |style| style.bg(palette.surface_3))),
            Look::AccentGhost => button.font_weight(FontWeight::SEMIBOLD).when(!disabled, |b| b.hover(move |style| style.bg(palette.accent_soft))),
            Look::Danger => button.when(!disabled, |b| b.hover(move |style| style.text_color(palette.error).bg(palette.error_bg))),
            Look::On => button.border_color(palette.accent_line).bg(palette.accent_soft),
            Look::DangerFill => {
                let hover = theme::mix(palette.error, 88.0, crate::kit::rgb(0xffffff));
                button.bg(palette.error).font_weight(FontWeight::SEMIBOLD).hover(move |style| style.bg(hover))
            }
        };

        if let Some(name) = self.icon {
            let size = if self.size == Size::Normal { 16.0 } else { 14.0 };
            button = button.child(icon(name, size).text_color(icon_color));
        }
        if let Some(label) = self.label {
            button = button.child(label);
        }
        if let Some(tip) = self.tip {
            button = button.tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx));
        }
        if let Some(selector) = self.selector {
            button = button.debug_selector(move || selector);
        }
        if !disabled {
            button = button.cursor_pointer();
            if let Some(handler) = self.handler {
                button = button.on_click(move |event, window, cx| handler(event, window, cx));
            }
        }
        button
    }
}

/// Any element opening a dropdown menu when clicked.
pub fn with_menu(element: Stateful<Div>, anchor: Anchor, items: impl Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu + 'static) -> AnyElement {
    Trigger { inner: element, selected: false }.dropdown_menu_with_anchor(anchor, items).into_any_element()
}

/// A built button that a dropdown menu can be attached to.
pub struct Trigger {
    inner: Stateful<Div>,
    selected: bool,
}

impl Styled for Trigger {
    fn style(&mut self) -> &mut StyleRefinement {
        self.inner.style()
    }
}

impl InteractiveElement for Trigger {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.inner.interactivity()
    }
}

impl IntoElement for Trigger {
    type Element = Stateful<Div>;

    fn into_element(self) -> Self::Element {
        if self.selected { self.inner.bg(theme::current().surface_3) } else { self.inner }
    }
}

impl Selectable for Trigger {
    fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    fn is_selected(&self) -> bool {
        self.selected
    }
}

impl DropdownMenu for Trigger {}

/// A segmented control (.seg): a track with buttons, one of which may be on.
pub fn seg_track() -> Div {
    let palette = theme::current();
    div().flex().flex_none().items_center().gap(r(2.0)).p(r(2.0)).bg(palette.track).border_1().border_color(palette.border).rounded(r(9.0))
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SegSize {
    Normal,
    #[allow(dead_code)] // the web .seg.sm size
    Small,
    Tiny,
}

/// One button of a segmented control (.seg-btn).
pub fn seg_button(id: impl Into<ElementId>, label: impl Into<SharedString>, on: bool, size: SegSize) -> Stateful<Div> {
    seg_icon_button(id, None, label, on, size)
}

/// A segment with an icon before its label (the icon turns accent when on).
pub fn seg_icon_button(id: impl Into<ElementId>, icon_name: Option<&'static str>, label: impl Into<SharedString>, on: bool, size: SegSize) -> Stateful<Div> {
    let palette = theme::current();
    let (height, padding, font, radius) = match size {
        SegSize::Normal => (26.0, 10.0, 12.0, 7.0),
        SegSize::Small => (24.0, 8.0, 11.5, 7.0),
        SegSize::Tiny => (22.0, 7.0, 10.5, 6.0),
    };
    let mut button = div()
        .id(id.into())
        .flex()
        .items_center()
        .gap(r(5.0))
        .h(r(height))
        .px(r(padding))
        .rounded(r(radius))
        .text_size(r(font))
        .font_weight(FontWeight::SEMIBOLD)
        .whitespace_nowrap()
        .cursor_pointer()
        .text_color(if on { palette.text } else { palette.muted });
    if let Some(name) = icon_name {
        let contrast = palette.name == theme::ThemeName::Contrast;
        let color = match (on, contrast) {
            (true, true) => Rgba::new(0.0, 0.0, 0.0, 1.0),
            (true, false) => palette.accent,
            (false, _) => palette.muted,
        };
        button = button.child(icon(name, 14.0).text_color(color));
    }
    let label: SharedString = label.into();
    if !label.is_empty() {
        button = button.child(label);
    }
    if on {
        button = button.bg(palette.seg_on).border_1().border_color(palette.border_strong).shadow(vec![BoxShadow {
            color: crate::theme::hsla(Rgba::new(0.0, 0.0, 0.0, 0.25)),
            offset: point(px(0.0), px(1.0)),
            blur_radius: px(3.0),
            spread_radius: px(0.0),
            inset: false,
        }]);
        if palette.name == theme::ThemeName::Contrast {
            button = button.text_color(Rgba::new(0.0, 0.0, 0.0, 1.0));
        }
    } else {
        button = button.hover(move |style| style.text_color(palette.text).bg(palette.surface_3));
    }
    button
}

/// A pill badge (.badge): accent-coloured, or neutral for widths over 32 bits.
pub fn badge(text: impl Into<SharedString>, neutral: bool) -> Div {
    let palette = theme::current();
    let (color, background, border) =
        if neutral { (palette.text, palette.surface_3, palette.border_strong) } else { (palette.accent, palette.accent_soft, palette.accent_line) };
    div()
        .flex_none()
        .px(r(8.0))
        .py(r(5.0))
        .rounded_full()
        .font_family(theme::mono())
        .font_weight(FontWeight::SEMIBOLD)
        .text_size(r(11.0))
        .line_height(r(11.0))
        .whitespace_nowrap()
        .text_color(color)
        .bg(background)
        .border_1()
        .border_color(border)
        .child(text.into())
}

// ------------------------------------------------------------ earlier helpers
// (the card still uses these; they now draw with the shared styles)
