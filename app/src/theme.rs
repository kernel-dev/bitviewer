//! Colours, the same tokens as the web app's theme.css / contrast.css and
//! accent.ts: a dark (default), light and high-contrast theme, and an accent
//! colour every accent-derived colour is mixed from. The UI calls these
//! functions (theme::surface(), theme::accent()…); they read the current
//! palette, which `set` replaces when the theme or accent changes.

use std::cell::RefCell;

use crate::kit::{Hsla, Rgba, rgb};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeName {
    Dark,
    Light,
    Contrast,
}

impl ThemeName {
    pub fn parse(text: &str) -> ThemeName {
        match text {
            "light" => ThemeName::Light,
            "contrast" => ThemeName::Contrast,
            _ => ThemeName::Dark,
        }
    }
}

/// The accent colours offered in Settings (accent.ts).
pub const ACCENTS: [(&str, u32); 8] = [
    ("Red", 0xe5383b),
    ("Orange", 0xf76707),
    ("Amber", 0xf59f00),
    ("Green", 0x2fb344),
    ("Teal", 0x0ca678),
    ("Blue", 0x3b82f6),
    ("Violet", 0x8b5cf6),
    ("Pink", 0xe64980),
];

#[derive(Clone, Copy, Debug)]
pub struct Palette {
    pub name: ThemeName,
    pub bg: Rgba,
    pub surface: Rgba,
    pub surface_2: Rgba,
    pub surface_3: Rgba,
    pub elevated: Rgba,
    pub track: Rgba,
    pub seg_on: Rgba,
    pub input: Rgba,
    pub border: Rgba,
    pub border_strong: Rgba,
    pub text: Rgba,
    pub muted: Rgba,
    pub faint: Rgba,
    pub accent: Rgba,
    pub accent_hover: Rgba,
    pub accent_press: Rgba,
    pub accent_soft: Rgba,
    pub accent_line: Rgba,
    pub on_accent: Rgba,
    pub bit_on: Rgba,
    pub bit_on_2: Rgba,
    pub bit_on_text: Rgba,
    pub bit_off: Rgba,
    pub bit_off_text: Rgba,
    /// The soft glow around set bits (None in high contrast).
    pub bit_glow: Option<Rgba>,
    pub cmp_bg: Rgba,
    pub cmp_on: Rgba,
    pub cmp_on_text: Rgba,
    pub cmp_off: Rgba,
    pub cmp_off_text: Rgba,
    pub row_linked: Rgba,
    pub link: Rgba,
    pub select: Rgba,
    pub select_soft: Rgba,
    pub diff: Rgba,
    pub error: Rgba,
    pub error_bg: Rgba,
    pub ok: Rgba,
    pub float: Rgba,
    #[allow(dead_code)] // the web token; cards draw their own shadow
    pub shadow: Rgba,
}

fn rgba(hex: u32, alpha: f32) -> Rgba {
    let mut color = rgb(hex);
    color.alpha = alpha;
    color
}

/// A colour for the parts of GPUI that take HSL (shadows, text runs, the
/// component library's theme). GPUI CE's colours are `palette` types, which
/// convert explicitly.
pub fn hsla(color: Rgba) -> Hsla {
    crate::kit::rgb_to_hsla(color)
}

/// CSS color-mix(in srgb, a p%, b): each channel (alpha too) weighted.
pub fn mix(a: Rgba, percent: f32, b: Rgba) -> Rgba {
    let p = percent / 100.0;
    // mixing with a translucent colour weights by alpha (premultiplied), as CSS does
    let alpha = a.alpha * p + b.alpha * (1.0 - p);
    if alpha == 0.0 {
        return TRANSPARENT;
    }
    let channel = |x: f32, y: f32| (x * a.alpha * p + y * b.alpha * (1.0 - p)) / alpha;
    Rgba::new(channel(a.red, b.red), channel(a.green, b.green), channel(a.blue, b.blue), alpha)
}

const TRANSPARENT: Rgba = Rgba::new(0.0, 0.0, 0.0, 0.0);
const WHITE: Rgba = Rgba::new(1.0, 1.0, 1.0, 1.0);
const BLACK: Rgba = Rgba::new(0.0, 0.0, 0.0, 1.0);

impl Palette {
    pub fn dark() -> Palette {
        Palette {
            name: ThemeName::Dark,
            bg: rgb(0x111113),
            surface: rgb(0x18181b),
            surface_2: rgb(0x1e1e22),
            surface_3: rgb(0x26262b),
            elevated: rgb(0x1e1e22),
            track: rgb(0x1e1e22),
            seg_on: rgb(0x2e2e34),
            input: rgb(0x18181b),
            border: rgb(0x2e2e34),
            border_strong: rgb(0x3a3a41),
            text: rgb(0xededf0),
            muted: rgb(0xa5a5ae),
            faint: rgb(0x77777f),
            accent: rgb(0xe5534b),
            accent_hover: rgb(0xef6a62),
            accent_press: rgb(0xc8433c),
            accent_soft: rgba(0xe5534b, 0.18),
            accent_line: rgba(0xe5534b, 0.5),
            on_accent: rgb(0xffffff),
            bit_on: rgb(0x3a1f1f),
            bit_on_2: rgb(0x3a1f1f),
            bit_on_text: rgb(0xff8f86),
            bit_off: rgb(0x18181b),
            bit_off_text: rgb(0xc9c9d0),
            bit_glow: None,
            cmp_bg: rgba(0xe5383b, 0.045),
            cmp_on: rgb(0x6d2729),
            cmp_on_text: rgb(0xf2c4c5),
            cmp_off: rgb(0x151519),
            cmp_off_text: rgb(0x474751),
            row_linked: rgba(0xe5383b, 0.035),
            link: rgb(0xa6393c),
            select: rgb(0xf5a524),
            select_soft: rgba(0xf5a524, 0.26),
            diff: rgb(0x22d3ee),
            error: rgb(0xff5d6c),
            error_bg: rgb(0x2a1217),
            ok: rgb(0x34d399),
            float: rgb(0xf5a524),
            shadow: rgba(0x000000, 0.55),
        }
    }

    pub fn light() -> Palette {
        Palette {
            name: ThemeName::Light,
            bg: rgb(0xf7f6f2),
            surface: rgb(0xffffff),
            surface_2: rgb(0xf3f2ee),
            surface_3: rgb(0xecebe6),
            elevated: rgb(0xffffff),
            track: rgb(0xf3f2ee),
            seg_on: rgb(0xffffff),
            input: rgb(0xffffff),
            border: rgb(0xd9d8d2),
            border_strong: rgb(0xc8c7c0),
            text: rgb(0x1b1b1e),
            muted: rgb(0x5a5a62),
            faint: rgb(0x84848b),
            accent: rgb(0xc22d30),
            accent_hover: rgb(0xd23a3d),
            accent_press: rgb(0xa32427),
            accent_soft: rgba(0xc22d30, 0.09),
            accent_line: rgba(0xc22d30, 0.45),
            bit_on: rgb(0xf9e7e7),
            bit_on_text: rgb(0xc22d30),
            bit_on_2: rgb(0xf9e7e7),
            bit_off: rgb(0xffffff),
            bit_off_text: rgb(0x1b1b1e),
            bit_glow: None,
            cmp_bg: rgba(0xd62c2f, 0.035),
            cmp_on: rgb(0xefa2a4),
            cmp_on_text: rgb(0xffffff),
            cmp_off: rgb(0xebebef),
            cmp_off_text: rgb(0xb5b5be),
            row_linked: rgba(0xd62c2f, 0.03),
            link: rgb(0xe58c8e),
            select: rgb(0xe8900c),
            select_soft: rgba(0xe8900c, 0.22),
            diff: rgb(0x0891b2),
            error: rgb(0xd6336c),
            error_bg: rgb(0xfff0f4),
            ok: rgb(0x0f9f6e),
            float: rgb(0xb45309),
            shadow: rgba(0x14141e, 0.16),
            ..Palette::dark()
        }
    }

    pub fn contrast() -> Palette {
        Palette {
            name: ThemeName::Contrast,
            bg: rgb(0x000000),
            surface: rgb(0x000000),
            surface_2: rgb(0x0a0a0a),
            surface_3: rgb(0x262626),
            elevated: rgb(0x000000),
            track: rgb(0x000000),
            seg_on: rgb(0xffffff),
            input: rgb(0x000000),
            border: rgb(0x8a8a8a),
            border_strong: rgb(0xffffff),
            text: rgb(0xffffff),
            muted: rgb(0xe6e6e6),
            faint: rgb(0xbdbdbd),
            accent: rgb(0xff6b6b),
            accent_hover: rgb(0xff8a8a),
            accent_press: rgb(0xff4d4d),
            accent_soft: rgba(0xff6b6b, 0.25),
            accent_line: rgb(0xff6b6b),
            on_accent: rgb(0x000000),
            bit_on: rgb(0xff6b6b),
            bit_on_2: rgb(0xff6b6b),
            bit_on_text: rgb(0x000000),
            bit_off: rgb(0x000000),
            bit_off_text: rgb(0xe6e6e6),
            bit_glow: None,
            cmp_bg: rgb(0x000000),
            cmp_on: rgb(0xffb3b3),
            cmp_on_text: rgb(0x000000),
            cmp_off: rgb(0x000000),
            cmp_off_text: rgb(0xbdbdbd),
            row_linked: rgb(0x000000),
            link: rgb(0xffb3b3),
            select: rgb(0xffd400),
            select_soft: rgba(0xffd400, 0.3),
            diff: rgb(0x00e5ff),
            error: rgb(0xff8080),
            error_bg: rgb(0x330000),
            ok: rgb(0x4cff9f),
            float: rgb(0xffd400),
            shadow: rgb(0xffffff),
        }
    }

    /// The theme in colour `scheme` (see SCHEMES), with `accent` (or None
    /// for the scheme's own) mixed into every accent colour. High contrast
    /// keeps its own colours.
    pub fn new(name: ThemeName, scheme: &str, accent: Option<u32>) -> Palette {
        let mut palette = match name {
            ThemeName::Dark => Palette::dark(),
            ThemeName::Light => Palette::light(),
            ThemeName::Contrast => return Palette::contrast(),
        };
        if let Some(colors) = scheme_colors(scheme, name == ThemeName::Light) {
            palette.recolor(&colors);
        }
        if let Some(hex) = accent {
            let color = rgb(hex);
            palette.accent = color;
            palette.accent_hover = mix(color, 85.0, WHITE);
            palette.accent_press = mix(color, 82.0, BLACK);
            palette.accent_soft = mix(color, 14.0, TRANSPARENT);
            palette.accent_line = mix(color, 50.0, TRANSPARENT);
            let light = name == ThemeName::Light;
            palette.bit_on = mix(color, if light { 10.0 } else { 20.0 }, palette.surface);
            palette.bit_on_2 = palette.bit_on;
            palette.bit_on_text = if light { color } else { mix(color, 65.0, WHITE) };
            palette.bit_glow = None;
            palette.link = mix(color, 70.0, palette.muted);
            palette.cmp_on = mix(color, 45.0, palette.bg);
        }
        palette
    }
}

/// A colour scheme's own colours for one theme; everything else derives
/// from them. Signal red (the default) is Palette::light() and dark().
struct SchemeColors {
    bg: u32,
    paper: u32,
    soft: u32,
    hatch: u32,
    rule: u32,
    text: u32,
    muted: u32,
    accent: u32,
    on_accent: u32,
    on_bg: u32,
    on_text: u32,
    /// The selection colour, where the accent would clash with the usual amber.
    select: Option<u32>,
}

/// The colour schemes offered in Settings: id, name, and a short description.
pub const SCHEMES: [(&str, &str, &str); 7] = [
    ("lavender", "Lavender", "Soft violet cards on a pale lilac page"),
    ("signal", "Signal red", "Paper and red ink"),
    ("blueprint", "Blueprint", "Drafting-table blue"),
    ("graphite", "Graphite & amber", "Neutral greys, one warm highlight"),
    ("phosphor", "Phosphor", "Oscilloscope green"),
    ("plum", "Plum", "Soft violet"),
    ("lagoon", "Lagoon", "Teal ink"),
];

#[rustfmt::skip]
fn scheme_colors(scheme: &str, light: bool) -> Option<SchemeColors> {
    let c = |bg, paper, soft, hatch, rule, text, muted, accent, on_accent, on_bg, on_text, select| {
        Some(SchemeColors { bg, paper, soft, hatch, rule, text, muted, accent, on_accent, on_bg, on_text, select })
    };
    match (scheme, light) {
        ("blueprint", true) => c(0xf3f5f9, 0xffffff, 0xeef2f8, 0xe3e9f2, 0xcfd8e6, 0x13203a, 0x4d5b75, 0x1f5fbf, 0xffffff, 0xe3edfc, 0x1a54ab, None),
        ("blueprint", false) => c(0x0c1424, 0x111b2e, 0x16223a, 0x1c2a45, 0x26365a, 0xe6edf8, 0x9aabc6, 0x5b9bff, 0x0c1424, 0x1a3260, 0x9cc3ff, None),
        ("graphite", true) => c(0xf5f5f4, 0xffffff, 0xf0f0ef, 0xe7e7e5, 0xd6d6d3, 0x1c1917, 0x57534e, 0xb45309, 0xffffff, 0xfdf0dc, 0x9a4a06, Some(0x2f7fd0)),
        ("graphite", false) => c(0x121212, 0x1a1a1a, 0x202020, 0x282828, 0x333333, 0xededed, 0xa3a3a3, 0xf59e0b, 0x1a1206, 0x3a2a0e, 0xfbbf4a, Some(0x4ea3f0)),
        ("phosphor", true) => c(0xf2f6f3, 0xffffff, 0xecf3ee, 0xe1ebe4, 0xcadbd0, 0x132018, 0x4a5d51, 0x1d7a46, 0xffffff, 0xe2f3e8, 0x17663a, None),
        ("phosphor", false) => c(0x0a110d, 0x0f1913, 0x142019, 0x1a2a21, 0x24382c, 0xe3f2e8, 0x93ad9c, 0x3ddc84, 0x06140c, 0x143a24, 0x6ff0a6, None),
        ("plum", true) => c(0xf7f5f9, 0xffffff, 0xf2eff6, 0xe8e3ef, 0xd7d0e2, 0x1e1828, 0x5c5469, 0x6d3fc0, 0xffffff, 0xefe7fb, 0x5b2fae, None),
        ("plum", false) => c(0x13101a, 0x1a1622, 0x201b2a, 0x282234, 0x342d42, 0xece8f3, 0xa79fb6, 0xa78bfa, 0x13101a, 0x2f2450, 0xc4b2ff, None),
        ("lagoon", true) => c(0xf1f7f6, 0xffffff, 0xeaf3f2, 0xdfecea, 0xc8dcd9, 0x10211f, 0x47605c, 0x0f766e, 0xffffff, 0xddf2ef, 0x0d655e, None),
        ("lavender", true) => c(0xf5f3fb, 0xffffff, 0xf0ecfa, 0xebe6f6, 0xddd6f0, 0x1f1a2e, 0x5e5674, 0x6a46d6, 0xffffff, 0xebe5fb, 0x5a37c4, None),
        ("lavender", false) => c(0x14111d, 0x1b1726, 0x221d30, 0x2a2439, 0x362f4a, 0xece8f6, 0xa79fbd, 0x9d84ff, 0x14111d, 0x2e2650, 0xc1b2ff, None),
        ("lagoon", false) => c(0x0a1413, 0x0f1c1b, 0x142423, 0x1a2e2c, 0x24403d, 0xe2f2f0, 0x8fb0ab, 0x2dd4bf, 0x06201d, 0x0f3b37, 0x5eead4, None),
        _ => None,
    }
}

impl Palette {
    /// Puts a scheme's colours in, and the shades that follow from them.
    fn recolor(&mut self, c: &SchemeColors) {
        let light = self.name == ThemeName::Light;
        let accent = rgb(c.accent);
        self.bg = rgb(c.bg);
        self.surface = rgb(c.paper);
        self.surface_2 = rgb(c.soft);
        self.surface_3 = rgb(c.hatch);
        self.elevated = if light { rgb(c.paper) } else { rgb(c.soft) };
        self.track = rgb(c.soft);
        self.seg_on = if light { rgb(c.paper) } else { rgb(c.rule) };
        self.input = rgb(c.paper);
        self.border = rgb(c.rule);
        self.border_strong = mix(rgb(c.rule), 75.0, rgb(c.muted));
        self.text = rgb(c.text);
        self.muted = rgb(c.muted);
        self.faint = mix(rgb(c.muted), 70.0, rgb(c.paper));
        self.accent = accent;
        self.accent_hover = mix(accent, 85.0, WHITE);
        self.accent_press = mix(accent, 82.0, BLACK);
        self.accent_soft = mix(accent, if light { 10.0 } else { 18.0 }, TRANSPARENT);
        self.accent_line = mix(accent, 50.0, TRANSPARENT);
        self.on_accent = rgb(c.on_accent);
        self.bit_on = rgb(c.on_bg);
        self.bit_on_2 = rgb(c.on_bg);
        self.bit_on_text = rgb(c.on_text);
        self.bit_off = rgb(c.paper);
        self.bit_off_text = rgb(c.text);
        self.cmp_bg = mix(accent, 4.0, TRANSPARENT);
        self.cmp_on = mix(accent, 45.0, rgb(c.bg));
        self.cmp_off = rgb(c.soft);
        self.cmp_off_text = self.faint;
        self.row_linked = mix(accent, 3.0, TRANSPARENT);
        self.link = mix(accent, 70.0, rgb(c.muted));
        if let Some(select) = c.select {
            self.select = rgb(select);
            self.select_soft = mix(rgb(select), 24.0, TRANSPARENT);
        }
    }
}

thread_local! {
    static CURRENT: RefCell<Palette> = RefCell::new(Palette::dark());
    static COMPACT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Makes `palette` the one the UI draws with (redraw the windows after).
pub fn set(palette: Palette) {
    CURRENT.with(|current| *current.borrow_mut() = palette);
}

pub fn current() -> Palette {
    CURRENT.with(|current| *current.borrow())
}

/// Compact mode (tighter spacing, compact.css) is on.
pub fn compact() -> bool {
    COMPACT.with(std::cell::Cell::get)
}

pub fn set_compact(on: bool) {
    COMPACT.with(|compact| compact.set(on));
}

/// `normal`, or `tight` in compact mode.
pub fn space(normal: f32, tight: f32) -> f32 {
    if compact() { tight } else { normal }
}

macro_rules! tokens {
    ($($name:ident),* $(,)?) => {
        $(pub fn $name() -> Rgba { current().$name })*
    };
}

// every web colour token, whether or not a widget reads it directly yet
#[allow(dead_code)]
mod token_fns {
    use super::*;
    tokens!(
        bg,
        surface,
        surface_2,
        surface_3,
        elevated,
        track,
        seg_on,
        input,
        border,
        border_strong,
        text,
        muted,
        faint,
        accent,
        accent_hover,
        accent_press,
        accent_soft,
        accent_line,
        on_accent,
        bit_on,
        bit_on_2,
        bit_on_text,
        bit_off,
        bit_off_text,
        cmp_bg,
        cmp_on,
        cmp_on_text,
        cmp_off,
        cmp_off_text,
        row_linked,
        link,
        select,
        select_soft,
        diff,
        error,
        error_bg,
        ok,
        float,
        shadow,
    );
}
pub use token_fns::*;

#[allow(dead_code)]
pub fn bit_glow() -> Option<Rgba> {
    current().bit_glow
}

pub fn transparent() -> Rgba {
    TRANSPARENT
}

/// The title bar stays black in every theme.
pub mod title {
    use crate::kit::{Rgba, rgb};
    pub fn bg() -> Rgba {
        rgb(0x060607)
    }
    pub fn border() -> Rgba {
        rgb(0x1b1b20)
    }
    pub fn text() -> Rgba {
        rgb(0xc8c8d0)
    }
    pub fn hover() -> Rgba {
        rgb(0x1c1c21)
    }
}

/// Switches the theme and accent everywhere: our own drawing, and the
/// component library's controls (inputs, buttons, menus, dialogs), which
/// get the same colours, fonts and corner radius as the web app's.
pub fn apply(name: ThemeName, scheme: &str, accent: Option<u32>, cx: &mut crate::kit::App) {
    use crate::kit::component::{Theme, ThemeMode};
    use crate::kit::px;

    let palette = Palette::new(name, scheme, accent);
    set(palette);
    let mode = if name == ThemeName::Light { ThemeMode::Light } else { ThemeMode::Dark };
    Theme::change(mode, None, cx);

    let h = hsla;
    let theme = Theme::global_mut(cx);
    theme.font_family = ui().into();
    theme.mono_font_family = mono().into();
    theme.font_size = px(13.0);
    theme.radius = px(8.0);
    let c = &mut theme.colors;
    c.background = h(palette.surface);
    c.foreground = h(palette.text);
    c.border = h(palette.border_strong);
    c.input = h(palette.border_strong);
    c.ring = h(palette.accent);
    c.caret = h(palette.text);
    c.selection = h(palette.accent_soft);
    c.muted = h(palette.surface_3);
    c.muted_foreground = h(palette.muted);
    c.accent = h(palette.accent_soft);
    c.accent_foreground = h(palette.text);
    c.primary = h(palette.accent);
    c.primary_hover = h(palette.accent_hover);
    c.primary_active = h(palette.accent_press);
    c.primary_foreground = h(palette.on_accent);
    c.secondary = h(palette.surface_2);
    c.secondary_hover = h(palette.surface_3);
    c.secondary_active = h(palette.surface_3);
    c.secondary_foreground = h(palette.text);
    c.button = h(palette.surface_2);
    c.button_hover = h(palette.surface_3);
    c.button_active = h(palette.surface_3);
    c.button_foreground = h(palette.text);
    c.button_primary = h(palette.accent);
    c.button_primary_hover = h(palette.accent_hover);
    c.button_primary_active = h(palette.accent_press);
    c.button_primary_foreground = h(palette.on_accent);
    c.danger = h(palette.error);
    c.danger_foreground = h(rgb(0xffffff));
    c.popover = h(palette.elevated);
    c.popover_foreground = h(palette.text);
    c.overlay = h(rgba(0x000000, 0.55));
    c.list_hover = h(palette.accent_soft);
    c.list_active = h(palette.accent_soft);
    c.scrollbar = h(TRANSPARENT);
    c.scrollbar_thumb = h(palette.border_strong);
    c.scrollbar_thumb_hover = h(palette.muted);
    c.switch = h(palette.border_strong);
    c.link = h(palette.accent);
    c.title_bar = h(title::bg());
    c.title_bar_border = h(title::border());
    c.status_bar = h(palette.surface);
    c.status_bar_border = h(palette.border);
    c.window_border = h(palette.border);
    cx.refresh_windows();
}

/// A field colour ("#rrggbb" or "#rgb") as a colour, faded to `alpha`.
pub fn field_color(hex: &str, alpha: f32) -> Rgba {
    let digits = hex.trim_start_matches('#');
    let full: String = if digits.len() == 3 { digits.chars().flat_map(|c| [c, c]).collect() } else { digits.to_string() };
    rgba(u32::from_str_radix(&full, 16).unwrap_or(0x868e96), alpha)
}

thread_local! {
    /// The interface and number fonts in use (bundled, see fonts.rs).
    static FONTS: std::cell::Cell<(&'static str, &'static str)> =
        const { std::cell::Cell::new(("Outfit", "Geist Mono")) };
    /// The number font's character width, in ems.
    static MONO_EM: std::cell::Cell<f32> = const { std::cell::Cell::new(0.6) };
}

/// Width of one character of the number font at `size` px.
pub fn mono_width(size: f32) -> f32 {
    size * MONO_EM.with(std::cell::Cell::get)
}

/// The interface font's family.
pub fn ui() -> &'static str {
    FONTS.with(|fonts| fonts.get().0)
}

/// The number font's family.
pub fn mono() -> &'static str {
    FONTS.with(|fonts| fonts.get().1)
}

/// Makes these the fonts the UI draws with (apply the theme after); the
/// number font's character width is measured for the widths of fields.
pub fn set_fonts(ui: &'static str, mono: &'static str, cx: &crate::kit::App) {
    FONTS.with(|fonts| fonts.set((ui, mono)));
    let text = cx.text_system();
    let id = text.resolve_font(&crate::kit::font(mono));
    let em = text.advance(id, crate::kit::px(100.0), '0').map_or(0.6, |size| f32::from(size.width) / 100.0);
    MONO_EM.with(|cell| cell.set(if em > 0.3 && em < 1.0 { em } else { 0.6 }));
}

/// The width of `text` in the interface font (CSS px, before zoom).
pub fn ui_text_width(text: &str, size: f32, weight: crate::kit::FontWeight, window: &crate::kit::Window) -> f32 {
    if text.is_empty() {
        return 0.0;
    }
    let run = crate::kit::TextRun {
        len: text.len(),
        font: crate::kit::Font { weight, ..crate::kit::font(ui()) },
        color: crate::kit::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
        letter_spacing: None,
    };
    let line = window.text_system().shape_line(text.to_string().into(), crate::kit::px(size), &[run], None);
    f32::from(line.width())
}

#[cfg(test)]
mod tests {
    // not `use super::*`: that brings in GPUI's `test` macro, which shadows #[test]
    use super::{Palette, TRANSPARENT, ThemeName, mix};
    use crate::kit::rgb;

    #[test]
    fn mixes_like_css_color_mix() {
        let half = mix(rgb(0xff0000), 50.0, rgb(0x0000ff));
        assert!((half.red - 0.5).abs() < 1e-6 && (half.blue - 0.5).abs() < 1e-6);
        let soft = mix(rgb(0xe5383b), 14.0, TRANSPARENT);
        assert!((soft.alpha - 0.14).abs() < 1e-6);
        assert!((soft.red - rgb(0xe5383b).red).abs() < 1e-6); // transparent doesn't darken
    }

    #[test]
    fn every_scheme_has_a_light_and_a_dark_version() {
        for (id, _, _) in super::SCHEMES {
            let light = Palette::new(ThemeName::Light, id, None);
            let dark = Palette::new(ThemeName::Dark, id, None);
            assert_ne!(light.bg, dark.bg, "{id}");
            // the light one is light, the dark one dark
            assert!(light.bg.red > 0.8 && dark.bg.red < 0.2, "{id}");
        }
        assert_eq!(Palette::new(ThemeName::Light, "signal", None).accent, Palette::light().accent);
        assert_eq!(Palette::new(ThemeName::Light, "lagoon", None).accent, rgb(0x0f766e));
        assert_eq!(Palette::new(ThemeName::Contrast, "plum", None).accent, rgb(0xff6b6b));
    }

    #[test]
    fn accents_recolour_but_not_high_contrast() {
        let blue = Palette::new(ThemeName::Dark, "signal", Some(0x3b82f6));
        assert_eq!(blue.accent, rgb(0x3b82f6));
        assert_eq!(blue.bit_on_text, mix(rgb(0x3b82f6), 65.0, super::WHITE));
        let contrast = Palette::new(ThemeName::Contrast, "signal", Some(0x3b82f6));
        assert_eq!(contrast.accent, rgb(0xff6b6b));
    }
}
