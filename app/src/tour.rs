//! The first-run tour (the web app's app/tour.ts): a spotlight on a few key
//! parts of the window with short explanations. Parts the tour points at are
//! wrapped in `anchor`, which notes where they were drawn.

use std::cell::RefCell;
use std::collections::HashMap;

use crate::kit::*;

use crate::theme;
use crate::widgets::{Btn, Look, r};

pub struct Step {
    pub target: &'static str,
    pub title: &'static str,
    pub text: &'static str,
}

pub const STEPS: [Step; 7] = [
    Step { target: "add", title: "Add values", text: "Add 32- or 64-bit values, or any width from 1 to 512 bits with Custom." },
    Step {
        target: "bits",
        title: "Bits",
        text: "Click a bit to flip it, drag to select, Alt+drag to paint 1s (Alt+Shift+drag for 0s). After clicking, the arrow keys move along the bits and Space flips.",
    },
    Step {
        target: "selection",
        title: "Selection",
        text: "Selected bits get their own editable value here. “Group selection” (Ctrl+G) turns them into a named register field.",
    },
    Step {
        target: "fields",
        title: "Register fields",
        text: "Fields can be signed and have a formula with a unit, named values and a description. “Templates” adds ready-made layouts like IEEE-754 floats.",
    },
    Step { target: "expr", title: "Expressions", text: "Type calculations like 0x1F << 3 | bit(31). Other values and fields can be used by name." },
    Step { target: "undo", title: "Undo & auto-save", text: "Ctrl+Z undoes any change. Your work is saved automatically and comes back after a restart." },
    Step {
        target: "menubar",
        title: "Find any command",
        text: "Press Ctrl+K for the command palette, F1 for help. Settings has themes, accent colours and optional sounds.",
    },
];

thread_local! {
    /// Where each anchor was drawn, and in which frame (the first one of a
    /// name in a frame wins: the topmost card).
    static PLACES: RefCell<HashMap<&'static str, (u64, Bounds<Pixels>)>> = RefCell::new(HashMap::new());
    static FRAME: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// A new frame starts: anchors drawn from now on replace older places.
pub fn new_frame() {
    FRAME.with(|frame| frame.set(frame.get() + 1));
}

/// Where the part was drawn most recently.
pub fn place(name: &str) -> Option<Bounds<Pixels>> {
    let frame = FRAME.with(std::cell::Cell::get);
    // only parts drawn in the last frame or this one are still on screen
    PLACES.with(|places| places.borrow().get(name).filter(|(drawn, _)| drawn + 1 >= frame).map(|(_, bounds)| *bounds))
}

/// Wraps `element` so the tour can find it.
pub fn anchor(name: &'static str, element: impl IntoElement) -> Div {
    div().relative().child(element).child(
        canvas(
            move |bounds, _, _| {
                let frame = FRAME.with(std::cell::Cell::get);
                PLACES.with(|places| {
                    let mut places = places.borrow_mut();
                    match places.get(name) {
                        Some((drawn, _)) if *drawn == frame => {}
                        _ => {
                            places.insert(name, (frame, bounds));
                        }
                    }
                });
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full(),
    )
}

/// The tour while it runs: which steps (those whose part is on screen) and where it is.
pub struct Tour {
    pub steps: Vec<usize>,
    pub at: usize,
}

impl Tour {
    /// None when nothing the tour points at is on screen.
    pub fn start() -> Option<Tour> {
        let steps: Vec<usize> = (0..STEPS.len()).filter(|index| place(STEPS[*index].target).is_some()).collect();
        (!steps.is_empty()).then_some(Tour { steps, at: 0 })
    }

    /// The overlay: everything dimmed but the part, and the explanation.
    pub fn render(
        &self,
        viewport: Size<Pixels>,
        back: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
        next: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
        skip: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Div {
        let palette = theme::current();
        let step = &STEPS[self.steps[self.at]];
        let padding = px(6.0);
        let target = place(step.target).unwrap_or(Bounds { origin: point(px(0.0), px(0.0)), size: size(px(0.0), px(0.0)) });
        let ring = Bounds {
            origin: point(target.origin.x - padding, target.origin.y - padding),
            size: size(target.size.width + padding * 2.0, target.size.height + padding * 2.0),
        };
        let dim = Rgba::new(0.0, 0.0, 0.0, 0.55);
        let shade = |left: Pixels, top: Pixels, width: Pixels, height: Pixels| {
            div().absolute().left(left).top(top).w(width.max(px(0.0))).h(height.max(px(0.0))).bg(dim)
        };
        let pop_width = px(360.0).min(viewport.width - px(24.0));
        let pop_height = px(150.0);
        let below = ring.bottom() + px(14.0) + pop_height < viewport.height;
        let left = px(12.0).max(ring.origin.x.min(viewport.width - pop_width - px(12.0)));
        let top = if below { ring.bottom() + px(14.0) } else { px(12.0).max(ring.origin.y - pop_height - px(14.0)) };
        let last = self.at + 1 == self.steps.len();
        div()
            .absolute()
            .inset_0()
            .occlude()
            .child(shade(px(0.0), px(0.0), viewport.width, ring.top()))
            .child(shade(px(0.0), ring.bottom(), viewport.width, viewport.height - ring.bottom()))
            .child(shade(px(0.0), ring.top(), ring.left(), ring.size.height))
            .child(shade(ring.right(), ring.top(), viewport.width - ring.right(), ring.size.height))
            .child(
                div()
                    .absolute()
                    .left(ring.left())
                    .top(ring.top())
                    .w(ring.size.width)
                    .h(ring.size.height)
                    .rounded(r(12.0))
                    .border_2()
                    .border_color(palette.accent),
            )
            .child(
                div()
                    .absolute()
                    .left(left)
                    .top(top)
                    .w(pop_width)
                    .px(r(16.0))
                    .pt(r(14.0))
                    .pb(r(12.0))
                    .rounded(r(14.0))
                    .bg(palette.elevated)
                    .border_1()
                    .border_color(palette.border_strong)
                    .shadow_lg()
                    .text_color(palette.text)
                    .child(div().mb(r(6.0)).text_size(r(15.0)).font_weight(FontWeight::BOLD).child(step.title))
                    .child(div().mb(r(12.0)).text_color(palette.muted).line_height(r(13.0 * 1.5)).child(step.text))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(r(6.0))
                            .child(div().text_size(r(12.0)).text_color(palette.muted).child(format!("{} of {}", self.at + 1, self.steps.len())))
                            .child(div().flex_1())
                            .child(Btn::new("tour-skip", Look::Ghost).small().label("Skip tour").on_click(skip))
                            .child(Btn::new("tour-back", Look::Ghost).small().label("Back").disabled(self.at == 0).on_click(back))
                            .child(
                                Btn::new("tour-next", Look::Primary).small().test_label("tour-next").label(if last { "Done" } else { "Next" }).on_click(next),
                            ),
                    ),
            )
    }
}
