//! What each command does (commands.rs lists them). "Value" commands act on
//! the active card: the one last clicked or typed in, else the first one on
//! screen, as in the web app.

use bitviewer_core::integers::{Base, Bits};
use bitviewer_core::ops::Op;
use bitviewer_core::value::Value;
use gpui_kit::component::WindowExt;
use gpui_kit::component::notification::Notification;
use gpui_kit::*;

use super::WorkspaceView;
use crate::app_state;
use crate::card::CardView;
use crate::commands::*;

impl WorkspaceView {
    /// The card "Value" commands act on.
    fn active_card(&self) -> Option<Entity<CardView>> {
        self.active
            .and_then(|id| self.cards.get(&id))
            .or_else(|| {
                let top = self.top_value();
                self.state.values.get(top).and_then(|value| self.cards.get(&value.id))
            })
            .map(|(card, _)| card.clone())
    }

    /// Runs `action` on the active card.
    fn on_card(&mut self, window: &mut Window, cx: &mut Context<Self>, action: impl FnOnce(&mut CardView, &mut Window, &mut Context<CardView>) + 'static) {
        // after this event: the card changes the value through the workspace,
        // which is busy handling the command right now
        if let Some(card) = self.active_card() {
            window.defer(cx, move |window, cx| card.update(cx, |card, cx| action(card, window, cx)));
        }
    }

    /// A new value of `width` bits with the default view and base, at the end.
    pub fn add_value(&mut self, width: usize, cx: &mut Context<Self>) {
        let settings = app_state::settings(cx);
        let value = Value::new(width, Bits::ZERO, &self.free_value_name(), settings.default_view, settings.default_base).expect("widths here are valid");
        self.insert_value(value, None, cx);
        crate::sound::play(crate::sound::Sound::Add, cx);
    }

    /// Switches every row of every value to `base`, and makes it the default.
    pub fn apply_global_base(&mut self, base: Base, window: &mut Window, cx: &mut Context<Self>) {
        self.edit_all(cx, |value| value.set_all_row_bases(base));
        app_state::update(cx, |settings| settings.default_base = base);
        window.push_notification(Notification::info(format!("All rows now use {}", base.name())), cx);
    }

    /// "Export code…" for one value.
    pub fn export_value(&mut self, id: bitviewer_core::value::ValueId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(value) = self.state.values.iter().find(|value| value.id == id).cloned() else { return };
        let peripheral = self.state.peripherals.get(&value.block).map(|p| (**p).clone());
        crate::export_dialog::open(crate::export_dialog::Target::Register { value, peripheral }, window, cx);
    }

    /// "Export code…" for a whole peripheral.
    pub fn export_peripheral(&mut self, block: &std::sync::Arc<str>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(peripheral) = self.state.peripherals.get(block).map(|p| (**p).clone()) else { return };
        let values = self.state.values.iter().filter(|value| value.block == *block).cloned().collect();
        crate::export_dialog::open(crate::export_dialog::Target::Peripheral { peripheral, values }, window, cx);
    }

    /// A value computed by "New value from expression…".
    pub fn add_computed_value(&mut self, name: &str, width: usize, bits: Bits, cx: &mut Context<Self>) {
        let settings = app_state::settings(cx);
        let name = if name.is_empty() { self.free_value_name() } else { name.to_string() };
        if let Ok(value) = Value::new(width, bits, &name, settings.default_view, settings.default_base) {
            self.insert_value(value, None, cx);
        }
    }

    /// A new value from a template the user picks, named after it.
    fn add_from_template(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let workspace = cx.entity().downgrade();
        crate::templates_dialog::pick(window, cx, "Add value from template".into(), "Add value", move |template, _, cx| {
            workspace
                .update(cx, |this, cx| {
                    let settings = app_state::settings(cx);
                    let Ok(mut value) = Value::new(template.width, Bits::ZERO, &template.name, settings.default_view, settings.default_base) else {
                        return;
                    };
                    if value.apply_template(&template).is_ok() {
                        this.insert_value(value, None, cx);
                    }
                })
                .ok();
        });
    }

    pub(super) fn register_actions(&mut self, root: Div, cx: &mut Context<Self>) -> Div {
        root.on_action(cx.listener(|this, _: &Undo, _, cx| this.undo_step(cx)))
            .on_action(cx.listener(|this, _: &Redo, _, cx| this.redo_step(cx)))
            .on_action(cx.listener(|this, _: &Add32, _, cx| this.add_value(32, cx)))
            .on_action(cx.listener(|this, _: &Add64, _, cx| this.add_value(64, cx)))
            .on_action(cx.listener(|_, _: &AddCustom, window, cx| {
                let workspace = cx.entity().downgrade();
                let last = app_state::settings(cx).last_width;
                crate::value_dialogs::pick_width(window, cx, "Add value", last, "Add value", move |width, _, cx| {
                    app_state::update(cx, |settings| settings.last_width = width);
                    workspace.update(cx, |workspace, cx| workspace.add_value(width, cx)).ok();
                });
            }))
            .on_action(cx.listener(|_, _: &ZoomIn, _, cx| app_state::update(cx, |s| s.zoom += bitviewer_core::settings::ZOOM_STEP)))
            .on_action(cx.listener(|_, _: &ZoomOut, _, cx| app_state::update(cx, |s| s.zoom -= bitviewer_core::settings::ZOOM_STEP)))
            .on_action(cx.listener(|_, _: &ZoomReset, _, cx| app_state::update(cx, |s| s.zoom = 1.0)))
            .on_action(cx.listener(|_, _: &ToggleTheme, _, cx| {
                // Ctrl+T switches dark ↔ light; high contrast is chosen in Settings
                app_state::update(cx, |s| s.theme = if s.theme == "dark" { "light" } else { "dark" }.into())
            }))
            .on_action(cx.listener(|_, _: &ToggleCompact, _, cx| app_state::update(cx, |s| s.compact = !s.compact)))
            .on_action(cx.listener(|_, _: &ToggleSounds, window, cx| {
                app_state::update(cx, |s| s.sounds = !s.sounds);
                let on = app_state::settings(cx).sounds;
                if on {
                    crate::sound::play(crate::sound::Sound::BitOn, cx);
                }
                window.push_notification(Notification::info(if on { "Sounds on" } else { "Sounds off" }), cx);
            }))
            .on_action(cx.listener(|this, _: &NewWorkspace, window, cx| this.new_workspace(window, cx)))
            .on_action(cx.listener(|this, _: &Open, window, cx| this.open(window, cx)))
            .on_action(cx.listener(|this, action: &OpenRecent, window, cx| this.open_recent(action.0, window, cx)))
            .on_action(cx.listener(|this, _: &ClearRecent, _, cx| this.clear_recent(cx)))
            .on_action(cx.listener(|this, _: &Save, window, cx| this.save(window, cx)))
            .on_action(cx.listener(|this, _: &SaveAs, window, cx| this.save_as(window, cx)))
            .on_action(cx.listener(|this, _: &Quit, window, cx| this.quit(window, cx)))
            .on_action(cx.listener(|this, _: &ClearSelection, window, cx| this.on_card(window, cx, |card, _, cx| card.clear_selection(cx))))
            .on_action(cx.listener(|this, _: &GroupSelection, window, cx| this.on_card(window, cx, |card, window, cx| card.group_selection(window, cx))))
            .on_action(cx.listener(|this, _: &CardCollapse, window, cx| this.on_card(window, cx, |card, window, cx| card.toggle_collapsed(window, cx))))
            .on_action(cx.listener(|this, _: &CardExpr, window, cx| this.on_card(window, cx, |card, window, cx| card.toggle_expr(window, cx))))
            .on_action(cx.listener(|this, _: &CardBases, window, cx| this.on_card(window, cx, |card, window, cx| card.toggle_bases(window, cx))))
            .on_action(cx.listener(|this, _: &CardSwap, window, cx| this.on_card(window, cx, |card, window, cx| card.apply_op(Op::Bswap, window, cx))))
            .on_action(cx.listener(|this, _: &CardNot, window, cx| this.on_card(window, cx, |card, window, cx| card.apply_op(Op::Invert, window, cx))))
            .on_action(cx.listener(|this, _: &CardClear, window, cx| this.on_card(window, cx, |card, window, cx| card.apply_op(Op::Clear, window, cx))))
            .on_action(cx.listener(|this, _: &CardSnapshot, window, cx| this.on_card(window, cx, |card, window, cx| card.take_snapshot_prompt(window, cx))))
            .on_action(cx.listener(|this, _: &CardPaste, window, cx| this.on_card(window, cx, |card, window, cx| card.paste_bytes_prompt(window, cx))))
            .on_action(cx.listener(|this, _: &CardCompare, window, cx| this.on_card(window, cx, |card, window, cx| card.compare_prompt(window, cx))))
            .on_action(cx.listener(|this, _: &CardWidth, window, cx| this.on_card(window, cx, |card, window, cx| card.width_prompt(window, cx))))
            .on_action(cx.listener(|this, _: &CardDuplicate, _, cx| {
                if let Some(id) = this.active_card().map(|card| card.read(cx).id) {
                    this.duplicate_value(id, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &CardRemove, _, cx| {
                if let Some(id) = this.active_card().map(|card| card.read(cx).id) {
                    this.remove_value(id, cx);
                }
            }))
            // not ported yet: each says so until it is
            .on_action(cx.listener(|this, _: &Find, window, cx| this.open_search(window, cx)))
            .on_action(cx.listener(|this, _: &Palette, window, cx| this.open_palette(window, cx)))
            .on_action(cx.listener(|_, _: &Settings, window, cx| crate::settings_dialog::open(window, cx)))
            .on_action(cx.listener(|this, _: &ImportSvd, window, cx| this.import_svd(None, window, cx)))
            .on_action(cx.listener(|this, _: &AddFromExpr, window, cx| {
                let widest = this.state.values.iter().map(|value| value.width).max().unwrap_or(0).clamp(32, 512);
                crate::value_dialogs::new_value_from_expression(cx.entity().downgrade(), widest, window, cx)
            }))
            .on_action(cx.listener(|this, _: &AddFromTemplate, window, cx| this.add_from_template(window, cx)))
            .on_action(cx.listener(|this, _: &CardTemplate, window, cx| this.on_card(window, cx, |card, window, cx| card.apply_template_prompt(window, cx))))
            .on_action(cx.listener(|this, _: &CardSaveTemplate, window, cx| this.on_card(window, cx, |card, window, cx| card.save_template_prompt(window, cx))))
            .on_action(cx.listener(|this, _: &CardExport, window, cx| {
                let Some(id) = this.active_card().map(|card| card.read(cx).id) else { return };
                this.export_value(id, window, cx);
            }))
            .on_action(cx.listener(|_, _: &HelpControls, window, cx| crate::help_dialog::open_help(window, cx)))
            .on_action(cx.listener(|_, _: &HelpGuide, window, cx| crate::guide_dialog::open(None, window, cx)))
            .on_action(cx.listener(|_, _: &HelpWhatsNew, window, cx| {
                crate::help_dialog::open_whats_new(window, cx);
            }))
            .on_action(cx.listener(|this, _: &HelpTour, _, cx| this.start_tour(cx)))
            .on_action(cx.listener(|_, _: &HelpUpdates, window, cx| crate::updates::check(true, window, cx)))
            .on_action(cx.listener(|_, _: &HelpAbout, window, cx| crate::help_dialog::open_about(window, cx)))
    }
}
