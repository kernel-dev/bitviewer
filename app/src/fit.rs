//! Text that fits the space layout gives it.
//!
//! Most of the app sizes text before layout, so a long name in a narrow
//! box gets cut off. `FitText` waits until layout is done: when it knows its
//! real width (a column, a pill, a box that shrank because the window did)
//! it draws its text at the largest size that fits, between `size` and
//! `min_size`, and only past that ends it with "…". It is re-fitted on every
//! frame, so it follows window resizes and zoom by itself.
//!
//! Give it a width from its parent (`w_full`, `flex_1` with `min_w_0`, a
//! fixed width) and a height; the text is centred in that height.

use gpui_kit::*;

use crate::theme;
use crate::widgets::r;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Align {
    Left,
    Center,
}

#[derive(IntoElement)]
pub struct FitText {
    text: SharedString,
    family: SharedString,
    weight: FontWeight,
    size: f32,
    min_size: f32,
    color: Hsla,
    align: Align,
    style: StyleRefinement,
}

/// Text that fits its box: in the interface font, 13 px down to 9 px, left aligned.
pub fn fit_text(text: impl Into<SharedString>) -> FitText {
    FitText {
        text: text.into(),
        family: theme::ui().into(),
        weight: FontWeight::NORMAL,
        size: 13.0,
        min_size: 9.0,
        color: theme::current().text.into(),
        align: Align::Left,
        style: StyleRefinement::default(),
    }
}

impl FitText {
    pub fn family(mut self, family: impl Into<SharedString>) -> Self {
        self.family = family.into();
        self
    }

    pub fn weight(mut self, weight: FontWeight) -> Self {
        self.weight = weight;
        self
    }

    /// The size it is drawn at when there is room (CSS px, before zoom).
    pub fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    /// The smallest size it shrinks to before it cuts the end off.
    pub fn min_size(mut self, size: f32) -> Self {
        self.min_size = size.min(self.size);
        self
    }

    pub fn color(mut self, color: impl Into<Hsla>) -> Self {
        self.color = color.into();
        self
    }

    pub fn align(mut self, align: Align) -> Self {
        self.align = align;
        self
    }
}

impl Styled for FitText {
    fn style(&mut self) -> &mut StyleRefinement {
        &mut self.style
    }
}

impl RenderOnce for FitText {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let FitText { text, family, weight, size, min_size, color, align, style } = self;
        let mut element = canvas(
            move |bounds, window, _| {
                let font = Font { weight, ..font(family) };
                fit(&text, &font, color, size, min_size, bounds.size.width, window)
            },
            move |bounds, (line, line_height): (ShapedLine, Pixels), window, cx| {
                let top = bounds.origin.y + (bounds.size.height - line_height) / 2.0;
                let align = match align {
                    Align::Left => TextAlign::Left,
                    Align::Center => TextAlign::Center,
                };
                line.paint(point(bounds.origin.x, top), line_height, align, Some(bounds.size.width), window, cx).ok();
            },
        );
        *element.style() = style;
        element
    }
}

/// Shapes `text` at the largest size from `size` down to `min_size` (CSS
/// px) that fits `width`; at `min_size` its end gives way to "…". Returns
/// the line and the height of a line of it.
pub fn fit(text: &SharedString, font: &Font, color: Hsla, size: f32, min_size: f32, width: Pixels, window: &Window) -> (ShapedLine, Pixels) {
    let rem = window.rem_size();
    let to_px = |css: f32| r(css).to_pixels(rem);
    let shape = |text: SharedString, css: f32| {
        let run = TextRun { len: text.len(), font: font.clone(), color, background_color: None, underline: None, strikethrough: None };
        window.text_system().shape_line(text, to_px(css), &[run], None)
    };
    let mut css = size;
    let mut line = shape(text.clone(), css);
    if width > px(0.0) && line.width() > width {
        // text width grows with its size: start from the size that should
        // fit, then step down until it does
        let guess = size * f32::from(width) / f32::from(line.width());
        css = ((guess * 2.0).floor() / 2.0).clamp(min_size, size);
        line = shape(text.clone(), css);
        while line.width() > width && css > min_size {
            css = (css - 0.5).max(min_size);
            line = shape(text.clone(), css);
        }
        if line.width() > width {
            line = shape(cut_to_fit(text, width, |cut| shape(cut, css).width()).into(), css);
        }
    }
    (line, to_px(css) * 1.3)
}

/// How wide `text` is at `size` (CSS px), from its characters' advances:
/// the width a box needs to hold it whole. Kerning aside, it matches what
/// is drawn; give such a box `flex_shrink` and `min_w_0` so FitText can
/// still fit it when there is less room.
pub fn text_width(text: &str, family: &str, weight: FontWeight, size: f32, cx: &App) -> f32 {
    let system = cx.text_system();
    let id = system.resolve_font(&Font { weight, ..font(SharedString::from(family.to_string())) });
    text.chars().map(|c| system.advance(id, px(size), c).map_or(size * 0.6, |advance| f32::from(advance.width))).sum()
}

/// The longest start of `text`, with "…" after it, no wider than `width`.
fn cut_to_fit(text: &str, width: Pixels, measure: impl Fn(SharedString) -> Pixels) -> String {
    let ends: Vec<usize> = text.char_indices().map(|(at, _)| at).skip(1).chain([text.len()]).collect();
    let cut = |count: usize| -> String { if count == 0 { "…".to_string() } else { format!("{}…", &text[..ends[count - 1]]) } };
    // how many characters stay: the most for which the cut text fits
    let (mut keep, mut over) = (0, ends.len());
    while keep < over {
        let mid = (keep + over).div_ceil(2);
        if measure(cut(mid).into()) <= width {
            keep = mid;
        } else {
            over = mid - 1;
        }
    }
    cut(keep)
}

#[cfg(test)]
mod tests {
    use super::cut_to_fit;
    use gpui_kit::px;

    #[test]
    fn cuts_the_end_off_at_a_character() {
        // 10 px a character, "…" included
        let measure = |text: gpui_kit::SharedString| px(text.chars().count() as f32 * 10.0);
        assert_eq!(cut_to_fit("BIST_DELAY_ENABLE", px(60.0), measure), "BIST_…");
        assert_eq!(cut_to_fit("ÅBC", px(25.0), measure), "Å…");
        assert_eq!(cut_to_fit("ABC", px(5.0), measure), "…");
    }
}
