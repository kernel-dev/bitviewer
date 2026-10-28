//! `bitviewer --shot SCENE [FILE]`: sets the window up as one of the guide's
//! screenshots (docs/guide/img), so they can be taken again after the
//! interface changes (scripts/guide-shots/capture.ps1 takes all of them). The
//! settings are fixed (light, Lavender, Outfit) and nothing is saved: not
//! the settings, not the session.

use std::time::Duration;

use bitviewer_core::settings::Settings;

use super::WorkspaceView;
use crate::card::CardView;
use crate::kit::*;

/// The scenes, each with the workspace it is staged in (docs/guide/shots).
pub const SCENES: &[&str] = &[
    "bits-selection",
    "fields",
    "expr-bar",
    "compare",
    "template",
    "export-code",
    "export-struct",
    "export-editor",
    "svd-import",
    "peripheral",
    "search",
    "locked-bits",
    "settings",
    "peripheral-diff",
];

/// The settings every shot is taken with.
pub fn settings(scene: &str) -> Settings {
    Settings {
        tour_done: true,
        check_updates: false,
        sounds: false,
        last_seen_version: crate::help_dialog::VERSION.into(),
        export_last: if scene == "export-struct" { "cstruct" } else { "c" }.into(),
        search_regex: scene == "search",
        ..Settings::default()
    }
}

impl WorkspaceView {
    /// Stages `scene` once the window has drawn its first frames (cards are
    /// made when they are first drawn, so it waits again after paging).
    pub fn stage_shot(&mut self, scene: String, window: &mut Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |view, cx| {
            cx.background_executor().timer(Duration::from_millis(400)).await;
            view.update_in(cx, |view, window, cx| view.shot_layout(&scene, window, cx)).ok();
            cx.background_executor().timer(Duration::from_millis(400)).await;
            view.update_in(cx, |view, window, cx| view.shot_act(&scene, window, cx)).ok();
        })
        .detach();
    }

    /// The value called `name`, and its card (once it has been drawn).
    fn shot_card(&self, name: &str) -> Option<(usize, Entity<CardView>)> {
        let index = self.state.values.iter().position(|value| &*value.name == name)?;
        Some((index, self.card_at(index)?))
    }

    /// Scrolls so the value called `name` is on top, `down` px into it.
    fn shot_scroll(&mut self, name: &str, down: f32) {
        if let Some(index) = self.state.values.iter().position(|value| &*value.name == name) {
            let row = self.row_of(index);
            self.list.scroll_to(ListOffset { item_ix: row, offset_in_item: px(down) });
        }
    }

    /// First pass: which page, where scrolled, which search.
    fn shot_layout(&mut self, scene: &str, window: &mut Window, cx: &mut Context<Self>) {
        let uart = Some(std::sync::Arc::from("UART0"));
        match scene {
            "bits-selection" | "expr-bar" | "locked-bits" | "peripheral" => self.set_page(uart, cx),
            "peripheral-diff" => {
                // a snapshot, then two registers change: BAUD halves, CTRL's receiver goes off
                let block: std::sync::Arc<str> = "UART0".into();
                self.keep_snapshot(&block, "working build", cx);
                let index = |name: &str| self.state.values.iter().position(|value| &*value.name == name);
                let changes: Vec<(usize, bitviewer_core::integers::Bits)> = [("UART0.BAUD", 0x341u32), ("UART0.CTRL", 0x2103)]
                    .into_iter()
                    .filter_map(|(name, bits)| Some((index(name)?, bitviewer_core::integers::Bits::from(bits))))
                    .collect();
                self.restore_registers(changes, cx);
                self.set_page(uart, cx);
            }
            "fields" => {
                self.set_page(uart, cx);
                self.shot_scroll("UART0.CTRL", 330.0);
            }
            "search" => self.search_for("^uart0\\.(ctrl|baud)$", window, cx),
            "settings" => crate::settings_dialog::open(window, cx),
            _ => {}
        }
        cx.notify();
    }

    /// Second pass: what happens on the cards and in dialogs.
    fn shot_act(&mut self, scene: &str, window: &mut Window, cx: &mut Context<Self>) {
        match scene {
            "bits-selection" => {
                if let Some((_, card)) = self.shot_card("UART0.CTRL") {
                    card.update(cx, |card, cx| {
                        card.select_bit(15, false, cx);
                        card.drag_over(8, cx);
                    });
                }
            }
            "expr-bar" => {
                if let Some((_, card)) = self.shot_card("UART0.CTRL") {
                    card.update(cx, |card, cx| card.type_expression("(x & ~mask(8)) | 0xAB", window, cx));
                }
            }
            "locked-bits" => {
                if let Some((_, card)) = self.shot_card("UART0.CTRL") {
                    card.update(cx, |card, cx| card.flip(26, window, cx));
                }
            }
            "peripheral-diff" => self.compare_peripheral(&"UART0".into(), window, cx),
            "export-code" | "export-struct" | "export-editor" => {
                let name = if scene == "export-struct" { "TIMER.CFG" } else { "UART0.CTRL" };
                if let Some(id) = self.state.values.iter().find(|value| &*value.name == name).map(|value| value.id) {
                    let export = self.export_value(id, window, cx);
                    if scene == "export-editor"
                        && let Some(export) = export
                    {
                        export.update(cx, |export, cx| export.edit(false, window, cx));
                    }
                }
            }
            _ => {}
        }
        cx.notify();
    }
}
