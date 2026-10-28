//! The Settings dialog (the web app's dialogs/settings.ts). Every change
//! applies at once.

use bitviewer_core::integers::Base;
use bitviewer_core::rows::View;
use bitviewer_core::settings::{Settings, ZOOM_MAX, ZOOM_MIN};
use gpui_kit::component::WindowExt;
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::*;

use crate::modal::{self, row, section, switch};
use crate::sound::{self, Sound};
use crate::theme::{self, ACCENTS};
use crate::widgets::{Btn, Look, SegSize, icon, r, seg_icon_button, seg_track};
use crate::{app_state, prompt};

pub struct SettingsView {
    zoom: Entity<SliderState>,
    volume: Entity<SliderState>,
    _subscriptions: Vec<Subscription>,
}

/// Opens the Settings dialog.
pub fn open(window: &mut Window, cx: &mut App) {
    // each font card is drawn in its own fonts
    crate::fonts::load_all(cx);
    let view = cx.new(|cx| SettingsView::new(window, cx));
    window.open_dialog(cx, move |dialog, _, _| {
        modal::frame(dialog, "sliders-horizontal", "Settings", true)
            .child(view.clone())
            .footer(modal::footer().child(Btn::new("settings-done", Look::Primary).label("Done").on_click(|_, window, cx| window.close_dialog(cx))))
    });
}

fn value_of(event: &SliderEvent) -> f32 {
    match event {
        SliderEvent::Change(value) | SliderEvent::Release(value) => value.start(),
    }
}

impl SettingsView {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let settings = app_state::settings(cx).clone();
        let zoom = cx.new(|_| {
            SliderState::new().min((ZOOM_MIN * 100.0) as f32).max((ZOOM_MAX * 100.0) as f32).step(10.0).default_value((settings.zoom * 100.0).round() as f32)
        });
        let volume = cx.new(|_| SliderState::new().min(0.0).max(100.0).step(5.0).default_value((settings.sound_volume * 100.0).round() as f32));
        let subscriptions = vec![
            cx.subscribe_in(&zoom, window, |_, _, event: &SliderEvent, _, cx| {
                let zoom = f64::from(value_of(event)) / 100.0;
                app_state::update(cx, |settings| settings.zoom = zoom);
            }),
            cx.subscribe_in(&volume, window, |_, _, event: &SliderEvent, _, cx| {
                let volume = f64::from(value_of(event)) / 100.0;
                app_state::update(cx, |settings| settings.sound_volume = volume);
            }),
        ];
        SettingsView { zoom, volume, _subscriptions: subscriptions }
    }
}

/// A segmented choice that changes one setting.
fn choice<T: Copy + PartialEq + 'static>(id: &'static str, options: &[(T, &'static str, Option<&'static str>)], current: T, set: fn(&mut Settings, T)) -> Div {
    let mut track = seg_track();
    for (index, &(value, label, icon_name)) in options.iter().enumerate() {
        track = track.child(
            seg_icon_button((id, index), icon_name, label, value == current, SegSize::Normal)
                .on_click(move |_, _, cx| app_state::update(cx, |settings| set(settings, value))),
        );
    }
    track
}

/// The colour schemes, each a small card of its colours in the current
/// theme (light or dark).
fn scheme_picker(settings: &Settings) -> Div {
    let palette = theme::current();
    let name = theme::ThemeName::parse(&settings.theme);
    let shown = if name == theme::ThemeName::Contrast { theme::ThemeName::Dark } else { name };
    let mut picker = div().flex().flex_wrap().gap(r(8.0)).max_w(r(420.0));
    for (index, &(id, label, about)) in theme::SCHEMES.iter().enumerate() {
        let colors = theme::Palette::new(shown, id, None);
        let on = settings.scheme == id;
        let dot = |color: Rgba| div().size(r(12.0)).rounded_full().bg(color).border_1().border_color(colors.border);
        picker = picker.child(
            div()
                .id(("scheme", index))
                .debug_selector(move || format!("scheme-{id}"))
                .w(r(128.0))
                .flex()
                .flex_col()
                .gap(r(6.0))
                .p(r(8.0))
                .rounded(r(8.0))
                .bg(colors.bg)
                .border_1()
                .border_color(if on { palette.accent } else { palette.border })
                .when(on, |card| {
                    card.shadow(vec![BoxShadow {
                        color: palette.accent.into(),
                        offset: point(px(0.0), px(0.0)),
                        blur_radius: px(0.0),
                        spread_radius: px(1.0),
                        inset: false,
                    }])
                })
                .cursor_pointer()
                .hover(move |style| style.border_color(palette.muted))
                .tooltip(move |window, cx| Tooltip::new(about).build(window, cx))
                .on_click(move |_, _, cx| app_state::update(cx, |settings| settings.scheme = id.into()))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(r(4.0))
                        .child(dot(colors.surface))
                        .child(dot(colors.text))
                        .child(dot(colors.accent))
                        .child(div().flex_1())
                        .child(
                            div()
                                .px(r(5.0))
                                .rounded(r(3.0))
                                .bg(colors.bit_on)
                                .text_color(colors.bit_on_text)
                                .font_family(theme::mono())
                                .text_size(r(11.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("1"),
                        ),
                )
                .child(div().text_size(r(12.0)).font_weight(FontWeight::MEDIUM).text_color(colors.text).child(label)),
        );
    }
    picker
}

/// The font pairings, each a card set in its own fonts.
fn font_picker(settings: &Settings) -> Div {
    let palette = theme::current();
    let mut picker = div().flex().flex_wrap().gap(r(8.0)).max_w(r(420.0));
    for (index, set) in crate::fonts::SETS.iter().enumerate() {
        let on = settings.fonts == set.id;
        let id = set.id;
        let about = set.about;
        picker = picker.child(
            div()
                .id(("fonts", index))
                .debug_selector(move || format!("fonts-{id}"))
                .w(r(128.0))
                .flex()
                .flex_col()
                .gap(r(2.0))
                .p(r(8.0))
                .rounded(r(8.0))
                .bg(palette.surface)
                .border_1()
                .border_color(if on { palette.accent } else { palette.border })
                .when(on, |card| {
                    card.shadow(vec![BoxShadow {
                        color: palette.accent.into(),
                        offset: point(px(0.0), px(0.0)),
                        blur_radius: px(0.0),
                        spread_radius: px(1.0),
                        inset: false,
                    }])
                })
                .cursor_pointer()
                .hover(move |style| style.border_color(palette.muted))
                .tooltip(move |window, cx| Tooltip::new(about).build(window, cx))
                .on_click(move |_, _, cx| app_state::update(cx, |settings| settings.fonts = id.into()))
                .child(
                    div()
                        .flex()
                        .items_baseline()
                        .justify_between()
                        .child(div().font_family(set.ui).text_size(r(20.0)).font_weight(FontWeight::SEMIBOLD).text_color(palette.text).child("Ag"))
                        .child(div().font_family(set.mono).text_size(r(13.0)).text_color(palette.muted).child("0x1F80")),
                )
                .child(div().font_family(set.ui).text_size(r(12.0)).font_weight(FontWeight::MEDIUM).text_color(palette.text).child(set.name)),
        );
    }
    picker
}

/// The accent presets and a custom colour.
fn accent_picker(settings: &Settings) -> Div {
    let palette = theme::current();
    let own = theme::current();
    let scheme_accent = (own.accent.r * 255.0).round() as u32 * 65536 + (own.accent.g * 255.0).round() as u32 * 256 + (own.accent.b * 255.0).round() as u32;
    let current = settings.accent_color();
    let is_preset = current.is_none() || ACCENTS.iter().skip(1).any(|(_, color)| Some(*color) == current);
    let current = current.unwrap_or(0x1000000);
    let swatch = |id: usize, on: bool| {
        div().id(("accent", id)).size(r(22.0)).flex_none().rounded_full().border_2().border_color(palette.surface_2).cursor_pointer().shadow(vec![BoxShadow {
            color: if on { palette.text } else { palette.border_strong }.into(),
            offset: point(px(0.0), px(0.0)),
            blur_radius: px(0.0),
            spread_radius: px(if on { 2.0 } else { 1.0 }),
            inset: false,
        }])
    };
    let mut picker = div().flex().items_center().gap(r(6.0));
    for (index, &(name, color)) in ACCENTS.iter().enumerate() {
        // the first swatch: the scheme's own accent
        let (name, color, on) =
            if index == 0 { ("The colour scheme's own", scheme_accent, settings.accent_color().is_none()) } else { (name, color, color == current) };
        picker = picker.child(swatch(index, on).bg(rgb(color)).tooltip(move |window, cx| Tooltip::new(name).build(window, cx)).on_click(move |_, _, cx| {
            app_state::update(cx, |settings| {
                settings.accent = if index == 0 { String::new() } else { format!("#{color:06x}") };
            })
        }));
    }
    let custom = swatch(99, !is_preset).tooltip(|window, cx| Tooltip::new("Custom colour…").build(window, cx)).on_click(|_, window, cx| {
        let current = app_state::settings(cx).accent.clone();
        prompt::ask_with("palette", window, cx, "Custom accent colour", "A colour as #rrggbb", current, |text, _, cx| {
            let text = text.trim().to_lowercase();
            let text = if text.starts_with('#') { text } else { format!("#{text}") };
            let valid = text.len() == 7 && text[1..].chars().all(|c| c.is_ascii_hexdigit());
            if !valid {
                return Err("Enter a colour like #3b82f6".into());
            }
            app_state::update(cx, |settings| settings.accent = text);
            Ok(None)
        });
    });
    let custom = if is_preset {
        // the colour wheel of the web app's custom swatch
        custom.child(
            canvas(
                |_, _, _| {},
                |bounds, _, window, _| {
                    let colors = [0xe5383b, 0xf59f00, 0x2fb344, 0x0ca678, 0x3b82f6, 0x8b5cf6, 0xe64980];
                    let center = bounds.center();
                    let radius = bounds.size.width / 2.0;
                    let slices = colors.len();
                    for (index, color) in colors.iter().enumerate() {
                        let angle = |step: f32| (step / slices as f32) * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
                        let mut path = PathBuilder::fill();
                        path.move_to(center);
                        for part in 0..=8 {
                            let a = angle(index as f32 + part as f32 / 8.0);
                            path.line_to(point(center.x + radius * a.cos(), center.y + radius * a.sin()));
                        }
                        path.close();
                        if let Ok(path) = path.build() {
                            window.paint_path(path, rgb(*color));
                        }
                    }
                },
            )
            .size_full()
            .rounded_full(),
        )
    } else {
        custom.bg(rgb(current & 0xffffff))
    };
    picker.child(custom)
}

impl Render for SettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let settings = app_state::settings(cx).clone();
        let max_height = window.viewport_size().height * 0.7;
        let value_label = |text: String| div().w(r(44.0)).flex().justify_end().font_family(theme::mono()).text_color(palette.muted).child(text);

        let appearance = section(
            "Appearance",
            vec![
                row(
                    "Theme",
                    "",
                    choice(
                        "theme",
                        &[("dark", "Dark", Some("moon")), ("light", "Light", Some("sun")), ("contrast", "High contrast", Some("contrast"))],
                        match settings.theme.as_str() {
                            "light" => "light",
                            "contrast" => "contrast",
                            _ => "dark",
                        },
                        |s, theme| s.theme = theme.into(),
                    ),
                ),
                row("Colour scheme", "The colours of the whole app, in its light and dark themes", scheme_picker(&settings)),
                row("Fonts", "The interface font and the number font, as a pair", font_picker(&settings)),
                row("Accent colour", "The scheme's own by default; used for bits that are 1, buttons and highlights", accent_picker(&settings)),
                row(
                    "Compact mode",
                    "Tighter spacing, so more values fit on screen",
                    switch("compact", settings.compact, |on, _, cx| app_state::update(cx, |s| s.compact = on)),
                ),
                row(
                    "Zoom",
                    "Ctrl + mouse wheel anywhere · Ctrl+0 resets",
                    div()
                        .flex()
                        .items_center()
                        .gap(r(10.0))
                        .child(div().w(r(170.0)).child(Slider::new(&self.zoom)))
                        .child(value_label(format!("{}%", (settings.zoom * 100.0).round()))),
                ),
            ],
        );
        let bits = section(
            "Bits",
            vec![
                row(
                    "Bit order in a row",
                    "",
                    choice("order", &[(true, "MSB left  7…0", None), (false, "LSB left  0…7", None)], settings.msb_left, |s, v| s.msb_left = v),
                ),
                row(
                    "Layout for new values",
                    "Line puts every bit on one line across the window",
                    choice(
                        "view",
                        &[(View::Line, "Line", None), (View::Byte, "Bytes", None), (View::Nibble, "Nibbles", None)],
                        settings.default_view,
                        |s, v| s.default_view = v,
                    ),
                ),
                row(
                    "Row base for new values",
                    "",
                    choice(
                        "base",
                        &[(Base::Bin, "BIN", None), (Base::Oct, "OCT", None), (Base::Dec, "DEC", None), (Base::Hex, "HEX", None)],
                        settings.default_base,
                        |s, v| s.default_base = v,
                    ),
                ),
            ],
        );
        let sounds_on = settings.sounds;
        let sounds = section(
            "Sounds",
            vec![
                row(
                    "Interface sounds",
                    "Short sounds for flipping bits, selecting, fields, operations and errors",
                    switch("sounds", sounds_on, |on, _, cx| {
                        app_state::update(cx, |s| s.sounds = on);
                        if on {
                            sound::play(Sound::BitOn, cx);
                        }
                    }),
                ),
                row(
                    "Volume",
                    "",
                    div()
                        .flex()
                        .items_center()
                        .gap(r(10.0))
                        .child(div().w(r(170.0)).when(!sounds_on, |d| d.opacity(0.4)).child(Slider::new(&self.volume).disabled(!sounds_on)))
                        .child(value_label(format!("{}%", (settings.sound_volume * 100.0).round())))
                        .child(
                            Btn::new("test-sound", Look::Ghost)
                                .small()
                                .icon("volume-2")
                                .tip("Play a test sound")
                                .on_click(|_, _, cx| sound::play_anyway(Sound::Group, cx)),
                        ),
                ),
            ],
        );
        let updates = section(
            "Updates",
            vec![row(
                "Check for updates at start-up",
                "Help › Check for updates… works either way",
                switch("updates", settings.check_updates, |on, _, cx| app_state::update(cx, |s| s.check_updates = on)),
            )],
        );
        let readouts = section(
            "Readouts",
            vec![
                row(
                    "Per-row readouts",
                    "hex · dec · oct next to each byte / nibble row",
                    switch("readouts", settings.show_readouts, |on, _, cx| app_state::update(cx, |s| s.show_readouts = on)),
                ),
                row(
                    "Interpretations",
                    "unsigned, signed, set bits and IEEE-754 float",
                    switch("interp", settings.show_interp, |on, _, cx| app_state::update(cx, |s| s.show_interp = on)),
                ),
            ],
        );
        let _ = icon;
        div()
            .id("settings-body")
            .max_h(max_height)
            .overflow_y_scroll()
            .pr(r(4.0))
            .flex()
            .flex_col()
            .child(appearance)
            .child(bits)
            .child(sounds)
            .child(updates)
            .child(readouts)
    }
}

use gpui_kit::prelude::FluentBuilder as _;
