//! Dragging a value by its grip to reorder the workspace (the web app's
//! drag.ts): a line shows where it will land, the list scrolls while the
//! pointer rests near its top or bottom edge, Esc cancels. Also dropping
//! files on the window to open them.

use std::time::Duration;

use crate::kit::*;
use bitviewer_core::value::ValueId;

use super::WorkspaceView;
use crate::theme;
use crate::widgets::{icon, r};

pub(super) struct Drag {
    pub id: ValueId,
    pub from: usize,
    /// Where it would land: before the value at this position.
    pub target: usize,
    y: Pixels,
    _scroll: Task<()>,
}

impl WorkspaceView {
    /// The grip of the value `id` was pressed.
    pub fn start_drag(&mut self, id: ValueId, y: Pixels, cx: &mut Context<Self>) {
        if self.state.len() < 2 {
            return;
        }
        let Some(from) = self.state.values.iter().position(|value| value.id == id) else { return };
        // keep scrolling while the pointer rests near the top or bottom edge
        let scroll = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(16)).await;
                let Ok(()) = this.update(cx, |this, cx| {
                    let Some(drag) = &this.drag else { return };
                    let viewport = this.list.viewport_bounds();
                    let edge = px(48.0);
                    let step = if drag.y < viewport.top() + edge {
                        px(-14.0)
                    } else if drag.y > viewport.bottom() - edge {
                        px(14.0)
                    } else {
                        return;
                    };
                    this.list.scroll_by(step);
                    this.place_drag(cx);
                }) else {
                    return;
                };
            }
        });
        self.drag = Some(Drag { id, from, target: from, y, _scroll: scroll });
        cx.notify();
    }

    /// Works out where the dragged value would land, from the pointer.
    fn place_drag(&mut self, cx: &mut Context<Self>) {
        let Some(y) = self.drag.as_ref().map(|drag| drag.y) else { return };
        let top = self.list.logical_scroll_top().item_ix;
        let mut row_target = top;
        let mut row = top;
        // the rows on screen (laid out): count those whose middle is above the pointer
        while let Some(bounds) = self.list.bounds_for_item(row) {
            if bounds.size.height > px(0.0) && y > bounds.top() + bounds.size.height / 2.0 {
                row_target = row + 1;
            }
            if bounds.top() > y {
                break;
            }
            row += 1;
        }
        // rows are values on show: land before the value in that row
        let target = self.value_at_row(row_target).min(self.state.len());
        if let Some(drag) = &mut self.drag
            && drag.target != target
        {
            drag.target = target;
            cx.notify();
        }
    }

    pub(super) fn drag_moved(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        if let Some(drag) = &mut self.drag {
            drag.y = event.position.y;
            self.place_drag(cx);
        }
    }

    pub(super) fn finish_drag(&mut self, commit: bool, cx: &mut Context<Self>) {
        let Some(drag) = self.drag.take() else { return };
        cx.notify();
        if !commit {
            return;
        }
        let destination = if drag.target > drag.from { drag.target - 1 } else { drag.target };
        let before = self.state.clone();
        if self.state.move_value_to(drag.from, destination) {
            self.history.record(&before, None);
            self.reset_rows();
            self.changed(cx);
        }
    }

    /// The drop line above the value at `index`, while a drag would land there.
    pub(super) fn drop_line(&self, index: usize) -> Option<Div> {
        let drag = self.drag.as_ref()?;
        (drag.target == index && drag.target != drag.from && drag.target != drag.from + 1).then(|| {
            let palette = theme::current();
            div().h(r(3.0)).mx(r(6.0)).mb(r(6.0)).rounded(r(3.0)).bg(palette.accent).shadow(vec![BoxShadow {
                color: crate::theme::hsla(palette.accent),
                offset: point(px(0.0), px(0.0)),
                blur_radius: px(10.0),
                spread_radius: px(0.0),
                inset: false,
            }])
        })
    }

    /// Whether the value `id` is being dragged (it shows faded).
    pub fn dragging(&self, id: ValueId) -> bool {
        self.drag.as_ref().is_some_and(|drag| drag.id == id)
    }

    /// Files dropped on the window: the first is opened.
    pub(super) fn files_dropped(&mut self, paths: &ExternalPaths, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = paths.paths().first().cloned() else { return };
        // an SVD adds values to the workspace; anything else replaces it
        if crate::svd_dialog::is_svd(&path) {
            self.import_svd(Some(path), window, cx);
        } else if super::dump_dialog::is_dump(&path) {
            let _ = self.import_dump(Some(path), window, cx);
        } else {
            self.open_dropped(path, window, cx);
        }
    }

    /// "Drop to open the workspace", shown while files are dragged over the window.
    pub(super) fn drop_overlay() -> Stateful<Div> {
        let palette = theme::current();
        div()
            .id("drop-overlay")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .opacity(0.0)
            .drag_over::<ExternalPaths>(move |style, _, _, _| style.opacity(1.0).bg(Rgba::new(0.0, 0.0, 0.0, 0.45)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(r(10.0))
                    .px(r(40.0))
                    .py(r(28.0))
                    .border_2()
                    .border_dashed()
                    .border_color(palette.accent)
                    .rounded(r(16.0))
                    .bg(palette.surface)
                    .text_color(palette.text)
                    .child(icon("folder-open", 28.0).text_color(palette.accent))
                    .child(div().font_weight(FontWeight::BOLD).child("Drop to open the workspace")),
            )
    }
}
