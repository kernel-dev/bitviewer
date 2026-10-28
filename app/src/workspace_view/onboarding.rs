//! The tour (first run and Help › Tour) and the start-up checks: after an
//! update the new version's changes are shown once, then (if allowed) a
//! check for a newer version, as the web app's app.ts does.

use std::time::Duration;

use crate::kit::*;

use super::WorkspaceView;
use crate::app_state;
use crate::help_dialog::VERSION;
use crate::tour::Tour;

impl WorkspaceView {
    pub fn start_tour(&mut self, cx: &mut Context<Self>) {
        if self.tour.is_none() {
            self.tour = Tour::start();
            cx.notify();
        }
    }

    pub(super) fn tour_by(&mut self, delta: isize, cx: &mut Context<Self>) {
        let Some(tour) = &mut self.tour else { return };
        let next = tour.at as isize + delta;
        if next < 0 {
            return;
        }
        if next as usize >= tour.steps.len() {
            self.finish_tour(cx);
            return;
        }
        tour.at = next as usize;
        cx.notify();
    }

    pub(super) fn finish_tour(&mut self, cx: &mut Context<Self>) {
        if self.tour.take().is_some() {
            app_state::update(cx, |settings| settings.tour_done = true);
            cx.notify();
        }
    }

    /// The tour's overlay, while it runs.
    pub(super) fn render_tour(&self, window: &Window, cx: &mut Context<Self>) -> Option<Div> {
        let tour = self.tour.as_ref()?;
        let me = cx.entity().downgrade();
        let (back, next, skip) = (me.clone(), me.clone(), me);
        Some(tour.render(
            window.viewport_size(),
            move |_, _, cx| {
                back.update(cx, |this, cx| this.tour_by(-1, cx)).ok();
            },
            move |_, _, cx| {
                next.update(cx, |this, cx| this.tour_by(1, cx)).ok();
            },
            move |_, _, cx| {
                skip.update(cx, |this, cx| this.finish_tour(cx)).ok();
            },
        ))
    }

    /// Keys while the tour runs: Esc ends it, → and Enter go on, ← goes back.
    pub(super) fn tour_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        if self.tour.is_none() {
            return false;
        }
        match event.keystroke.key.as_str() {
            "escape" => self.finish_tour(cx),
            "right" | "enter" => self.tour_by(1, cx),
            "left" => self.tour_by(-1, cx),
            _ => {}
        }
        true
    }

    /// A moment after start: the tour the first time, else the version's
    /// changes once after an update.
    pub fn startup_checks(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.keeps_session(cx) {
            return;
        }
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(700)).await;
            this.update_in(cx, |this, window, cx| {
                let settings = app_state::settings(cx).clone();
                if !settings.tour_done {
                    // nothing is "new" to a first-time user
                    app_state::update(cx, |settings| settings.last_seen_version = VERSION.into());
                    this.start_tour(cx);
                    return;
                }
                if settings.last_seen_version != VERSION {
                    app_state::update(cx, |settings| settings.last_seen_version = VERSION.into());
                    crate::help_dialog::open_whats_new(window, cx);
                }
                if settings.check_updates {
                    crate::updates::check(false, window, cx);
                }
            })
            .ok();
        })
        .detach();
    }
}
