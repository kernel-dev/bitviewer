//! The main window's content: the title bar, toolbar and status bar around
//! the values, which are a virtualized list. The list keeps measured heights
//! in a sum tree, so scrolling and jumping cost the same at 150 values or
//! 150,000. Only values on (or near) the screen have a CardView; the rest
//! are just data.
//!
//!   chrome.rs    title bar, toolbar, status bar, empty state
//!   actions.rs   what each command does
//!   document.rs  open, save, new workspace, unsaved changes, recent files
//!   bench.rs     --bench

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::kit::component::menu::AppMenuBar;
use crate::kit::component::scroll::ScrollableElement;
use crate::kit::*;
use bitviewer_core::ModelError;
use bitviewer_core::history::History;
use bitviewer_core::integers::Bits;
use bitviewer_core::settings::Settings;
use bitviewer_core::value::{Value, ValueId};
use bitviewer_core::workspace::WorkspaceState;

mod actions;
mod bench;
mod blocks;
mod chrome;
mod document;
mod drag;
mod onboarding;
mod peripherals;
mod rows;
mod search;
mod svd_import;

use crate::card::CardView;
use crate::widgets::r;
use crate::{app_state, commands, theme};
use bench::Bench;
pub use bench::BenchOptions;
pub use chrome::logo;
pub use document::install_menus;
pub use search::{Matcher, match_value};

/// Sets up what every window needs: the component library, the bundled
/// fonts, the settings (theme, accent) and the shortcuts. Tests pass their
/// own settings so they never read the user's.
pub fn init(settings: Option<Settings>, cx: &mut App) {
    crate::kit::init(cx);
    app_state::init(settings, cx);
    commands::bind_keys(cx);
    install_menus(cx);
}

/// A name as expressions match it: lower case, runs of spaces and
/// underscores as one space.
pub fn normalize_name(name: &str) -> String {
    name.to_lowercase().split(|c: char| c.is_whitespace() || c == '_').filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
}

/// Cards not shown for this many frames are let go.
const CARD_KEEP_FRAMES: u64 = 120;

pub struct WorkspaceView {
    state: WorkspaceState,
    history: History,
    list: ListState,
    /// The workspace file, once opened or saved.
    path: Option<PathBuf>,
    file_name: String,
    /// The state as last opened or saved (None: never saved).
    saved: Option<WorkspaceState>,
    /// Goes up with every change; `dirty` is worked out once per version.
    version: u64,
    dirty: std::cell::Cell<Option<(u64, bool)>>,
    focus: FocusHandle,
    menu_bar: Entity<AppMenuBar>,
    /// The value last clicked or focused; "Value" commands act on it.
    active: Option<ValueId>,
    /// The cards on (or recently on) screen, and the frame each was last shown.
    cards: HashMap<ValueId, (Entity<CardView>, u64)>,
    /// Normalized value names to positions, for expressions; made on first
    /// use after a change.
    names: Option<HashMap<String, usize>>,
    frame: u64,
    bench: Option<Bench>,
    /// The pending write of the auto-saved session.
    session_save: Option<Task<()>>,
    /// The settings that change card heights, as last drawn.
    layout_settings: Option<(bool, u64, bool, bool, Vec<String>, bool)>,
    /// The command palette, while it is open.
    palette: Option<Entity<crate::palette::PaletteView>>,
    /// The search bar, while it is open.
    search: Option<search::Search>,
    /// The values on show while a page or search filters them (see rows.rs).
    rows: Option<Arc<Vec<usize>>>,
    /// A value being dragged to a new place.
    drag: Option<drag::Drag>,
    /// The tour, while it runs.
    tour: Option<crate::tour::Tour>,
    /// The window title as last set.
    title: String,
    /// The card a press landed in (its selection stays; others' go).
    pressed_card: Option<ValueId>,
    /// Ctrl+wheel distance not yet turned into a zoom step.
    wheel: f32,
    /// The peripheral page shown (Some("") for the values outside any
    /// peripheral); None shows everything.
    page: Option<Arc<str>>,
    /// The tabs: each peripheral (and "" for loose values) with its count,
    /// worked out once per version.
    pages: Option<(u64, Arc<Vec<(Arc<str>, usize)>>)>,
    /// The sidebar's rows, for a version and page.
    sidebar: Option<(u64, Option<Arc<str>>, Arc<Vec<chrome::SideRow>>)>,
}

impl WorkspaceView {
    pub fn new(state: WorkspaceState, file_name: String, bench: Option<BenchOptions>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut state = state;
        state.tidy();
        let list = ListState::new(state.len(), ListAlignment::Top, px(1200.0)).with_uniform_item_height(px(420.0));
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        // closing the window asks about unsaved changes first, as Quit does
        let this = cx.entity().downgrade();
        window.on_window_should_close(cx, move |window, cx| {
            this.update(cx, |this, cx| this.quit(window, cx)).ok();
            false
        });
        WorkspaceView {
            saved: Some(state.clone()),
            state,
            history: History::new(),
            list,
            path: None,
            file_name,
            version: 0,
            dirty: std::cell::Cell::new(None),
            focus,
            menu_bar: AppMenuBar::new(cx),
            active: None,
            cards: HashMap::new(),
            names: None,
            frame: 0,
            bench: bench.map(Bench::new),
            session_save: None,
            layout_settings: None,
            palette: None,
            search: None,
            rows: None,
            drag: None,
            tour: None,
            title: String::new(),
            pressed_card: None,
            wheel: 0.0,
            page: None,
            pages: None,
            sidebar: None,
        }
    }

    #[cfg_attr(not(test), allow(dead_code))] // read by the interface tests
    pub fn state(&self) -> &WorkspaceState {
        &self.state
    }

    /// The card of the value at `index`, if it is on screen (for tests).
    #[cfg(all(test, not(target_os = "macos")))]
    pub fn card_at(&self, index: usize) -> Option<Entity<CardView>> {
        let id = self.state.values.get(index)?.id;
        self.cards.get(&id).map(|(card, _)| card.clone())
    }

    /// How many rows the list has (for tests).
    #[cfg(all(test, not(target_os = "macos")))]
    pub fn list_rows(&self) -> usize {
        self.row_count()
    }

    #[cfg(all(test, not(target_os = "macos")))]
    pub fn shown_values(&self) -> usize {
        (0..self.state.len()).filter(|index| self.shown(*index)).count()
    }

    /// Unsaved changes: the workspace differs from the one last opened or saved.
    pub fn is_dirty(&self) -> bool {
        if let Some((version, dirty)) = self.dirty.get()
            && version == self.version
        {
            return dirty;
        }
        let dirty = !self.saved.as_ref().is_some_and(|saved| saved.same_as(&self.state));
        self.dirty.set(Some((self.version, dirty)));
        dirty
    }

    /// Records that the workspace changed (after `history` has the step).
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.version += 1;
        self.names = None;
        self.refresh_search(cx);
        self.refilter_if_changed();
        self.save_session_soon(cx);
        cx.notify();
    }

    /// Where the value with `id` is: at `hint` when nothing moved, else found.
    fn index_of(&self, id: ValueId, hint: usize) -> Option<usize> {
        if self.state.values.get(hint).is_some_and(|value| value.id == id) {
            return Some(hint);
        }
        self.state.values.iter().position(|value| value.id == id)
    }

    /// Changes one value. An actual change becomes an undo step (or joins
    /// the current one, for the same `merge` key) and is redrawn; nothing
    /// is recorded when the value stays the same or the change is refused.
    pub fn edit_value(
        &mut self,
        id: ValueId,
        hint: usize,
        merge: Option<u64>,
        edit: impl FnOnce(&mut Value) -> Result<bool, ModelError>,
        cx: &mut Context<Self>,
    ) -> Result<bool, ModelError> {
        let Some(index) = self.index_of(id, hint) else {
            return Ok(false);
        };
        let before = self.state.clone(); // cheap: shares everything
        match self.state.edit(index, edit) {
            Ok(true) => {
                self.history.record(&before, merge);
                self.remeasure_values(index..index + 1);
                self.changed(cx);
                Ok(true)
            }
            other => {
                self.state = before; // keep sharing with the undo steps
                other
            }
        }
    }

    /// Changes every value at once (one undo step).
    pub fn edit_all(&mut self, cx: &mut Context<Self>, edit: impl Fn(&mut Value) -> bool) {
        let before = self.state.clone();
        let mut any = false;
        for index in 0..self.state.len() {
            any |= self.state.edit(index, &edit);
        }
        if any {
            self.history.record(&before, None);
            self.list.remeasure();
            self.changed(cx);
        } else {
            self.state = before;
        }
    }

    /// A value by name for expressions. Case, spaces and underscores don't matter.
    pub fn value_by_name(&mut self, name: &str) -> Option<Bits> {
        let state = &self.state;
        let names = self.names.get_or_insert_with(|| {
            let mut names = HashMap::with_capacity(state.len());
            for (index, value) in state.values.iter().enumerate() {
                names.entry(normalize_name(&value.name)).or_insert(index);
            }
            names
        });
        names.get(&normalize_name(name)).map(|index| state.values[*index].value)
    }

    /// Shows a different workspace (an opened file), with a fresh undo history.
    pub fn replace_state(&mut self, mut state: WorkspaceState) {
        state.tidy();
        self.reset_search();
        self.saved = Some(state.clone());
        self.state = state;
        self.reset_rows();
        self.history.reset();
        self.cards.clear();
        self.active = None;
        self.version += 1;
        self.names = None;
    }

    pub fn break_merge(&mut self) {
        self.history.break_merge();
    }

    /// Adds `value` at `index` (the end when None), one undo step, and shows it.
    pub fn insert_value(&mut self, value: Value, index: Option<usize>, cx: &mut Context<Self>) {
        let index = index.unwrap_or(self.state.len()).min(self.state.len());
        let before = self.state.clone();
        self.active = Some(value.id);
        self.state.values.insert(index, Arc::new(value));
        self.history.record(&before, None);
        self.splice_values(index..index, 1);
        self.reveal_value(index);
        self.changed(cx);
    }

    /// The first free "Value N" name.
    pub fn free_value_name(&self) -> String {
        let names: std::collections::HashSet<&str> = self.state.values.iter().map(|value| &*value.name).collect();
        let mut number = self.state.len() + 1;
        while names.contains(format!("Value {number}").as_str()) {
            number += 1;
        }
        format!("Value {number}")
    }

    pub fn duplicate_value(&mut self, id: ValueId, cx: &mut Context<Self>) {
        let Some(index) = self.index_of(id, 0) else {
            return;
        };
        let mut copy = Value::clone(&self.state.values[index]);
        copy.id = ValueId::fresh();
        copy.name = format!("{} copy", copy.name).into();
        self.insert_value(copy, Some(index + 1), cx);
    }

    /// Moves a value up (-1) or down (+1) one place.
    pub fn move_value(&mut self, id: ValueId, delta: isize, cx: &mut Context<Self>) {
        let Some(index) = self.index_of(id, 0) else {
            return;
        };
        let Some(target) = index.checked_add_signed(delta).filter(|target| *target < self.state.len()) else {
            return;
        };
        let before = self.state.clone();
        let moving = self.state.values.remove(index);
        self.state.values.insert(target, moving);
        self.history.record(&before, None);
        let (low, high) = (index.min(target), index.max(target));
        self.splice_values(low..high + 1, high - low + 1);
        self.changed(cx);
    }

    pub fn remove_value(&mut self, id: ValueId, cx: &mut Context<Self>) {
        let Some(index) = self.index_of(id, 0) else {
            return;
        };
        let before = self.state.clone();
        self.state.values.remove(index);
        self.history.record(&before, None);
        self.splice_values(index..index + 1, 0);
        crate::sound::play(crate::sound::Sound::Remove, cx);
        self.cards.remove(&id);
        if self.active == Some(id) {
            self.active = None;
        }
        self.changed(cx);
    }

    pub fn flip_bit(&mut self, index: usize, bit: usize, cx: &mut Context<Self>) {
        let id = self.state.values[index].id;
        self.edit_value(id, index, None, |value| value.flip_bit(bit), cx).ok();
    }

    /// The card the user last worked in.
    pub fn set_active(&mut self, id: ValueId) {
        self.active = Some(id);
        self.pressed_card = Some(id);
    }

    pub fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.is_none() {
            let workspace = cx.entity().downgrade();
            self.palette = Some(cx.new(|cx| crate::palette::PaletteView::new(workspace, window, cx)));
            cx.notify();
        }
    }

    /// Closes the palette; the keyboard goes back to the workspace.
    pub fn close_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.palette = None;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    pub fn undo_step(&mut self, cx: &mut Context<Self>) {
        if let Some(previous) = self.history.undo(&self.state) {
            self.restore(previous, cx);
        }
    }

    pub fn redo_step(&mut self, cx: &mut Context<Self>) {
        if let Some(next) = self.history.redo(&self.state) {
            self.restore(next, cx);
        }
    }

    fn restore(&mut self, state: WorkspaceState, cx: &mut Context<Self>) {
        let resized = state.len() != self.state.len();
        // only the values the step changed can change height; the others
        // are the very same shared values in both states
        let changed: Vec<usize> = if resized {
            Vec::new()
        } else {
            self.state.values.iter().zip(state.values.iter()).enumerate().filter(|(_, (old, new))| !Arc::ptr_eq(old, new)).map(|(index, _)| index).collect()
        };
        self.state = state;
        if resized {
            self.reset_rows();
        } else {
            for index in changed {
                self.remeasure_values(index..index + 1);
            }
        }
        self.changed(cx);
    }

    /// The pages to show tabs for, in workspace order: each peripheral, and
    /// "" for the values outside any (gathered in one tab).
    pub(super) fn pages(&mut self) -> Arc<Vec<(Arc<str>, usize)>> {
        if let Some((version, pages)) = &self.pages
            && *version == self.version
        {
            return pages.clone();
        }
        let mut pages: Vec<(Arc<str>, usize)> = Vec::new();
        let mut loose = 0;
        for value in self.state.values.iter() {
            if value.block.is_empty() {
                loose += 1;
            } else if let Some(last) = pages.last_mut().filter(|(name, _)| **name == *value.block) {
                last.1 += 1;
            } else {
                pages.push((value.block.clone(), 1));
            }
        }
        if loose > 0 {
            pages.push((Arc::from(""), loose));
        }
        let pages = Arc::new(pages);
        self.pages = Some((self.version, pages.clone()));
        pages
    }

    /// The sidebar's rows (see chrome.rs), worked out once per version and page.
    fn sidebar_rows(&mut self) -> Arc<Vec<chrome::SideRow>> {
        if let Some((version, page, rows)) = &self.sidebar
            && *version == self.version
            && *page == self.page
        {
            return rows.clone();
        }
        let pages = self.pages();
        let mut rows = vec![chrome::SideRow::Page(None, "All registers".into(), self.state.len())];
        for (name, count) in pages.iter() {
            let label = if name.is_empty() { "Values".to_string() } else { name.to_string() };
            rows.push(chrome::SideRow::Page(Some(name.clone()), label, *count));
            if self.page.as_deref() == Some(&**name) {
                for (index, value) in self.state.values.iter().enumerate() {
                    if value.block == *name {
                        rows.push(chrome::SideRow::Value(index, value.name.clone()));
                    }
                }
            }
        }
        let rows = Arc::new(rows);
        self.sidebar = Some((self.version, self.page.clone(), rows.clone()));
        rows
    }

    /// Shows one peripheral's page (or everything), from its top.
    pub(super) fn set_page(&mut self, page: Option<Arc<str>>, cx: &mut Context<Self>) {
        if self.page == page {
            return;
        }
        self.page = page;
        self.page_changed();
        self.refilter(false);
        cx.notify();
    }

    /// The card for the value at `index`, made when it first comes on screen.
    fn card(&mut self, index: usize, cx: &mut Context<Self>) -> Entity<CardView> {
        let highlight = self.highlight_for(index);
        let value = self.state.values[index].clone();
        let base = self.state.peripherals.get(&value.block).and_then(|peripheral| peripheral.base);
        let frame = self.frame;
        let workspace = cx.entity().downgrade();
        let id = value.id;
        let (card, last_shown) = self.cards.entry(id).or_insert_with(|| {
            let card = cx.new(|cx| CardView::new(index, value.clone(), base, workspace, cx));
            (card, frame)
        });
        *last_shown = frame;
        let card = card.clone();
        card.update(cx, |card, cx| {
            card.show(index, value, base);
            card.highlight(highlight.0.as_deref(), highlight.1);
            cx.notify();
        });
        card
    }
}

impl Render for WorkspaceView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.frame += 1;
        crate::tour::new_frame();
        // the taskbar's title follows the file and its unsaved changes
        let title = format!("{}{} — Bit Viewer", self.file_name, if self.is_dirty() { " •" } else { "" });
        if title != self.title {
            window.set_window_title(&title);
            self.title = title;
        }
        if self.bench.is_some() {
            self.bench_step(window, cx);
        }
        // let go of cards that have been off screen for a while
        if self.cards.len() > 32 {
            let frame = self.frame;
            self.cards.retain(|_, (_, last_shown)| frame - *last_shown < CARD_KEEP_FRAMES);
        }
        // after a dialog closes nothing may have the keyboard: the workspace takes it
        if window.focused(cx).is_none() {
            window.focus(&self.focus, cx);
        }
        // settings that change the heights of cards: measure them again
        let settings = app_state::settings(cx);
        let layout =
            (settings.compact, settings.zoom.to_bits(), settings.show_readouts, settings.show_interp, settings.readout_chips.clone(), settings.msb_left);
        if self.layout_settings.as_ref() != Some(&layout) {
            if self.layout_settings.is_some() {
                self.list.remeasure();
            }
            self.layout_settings = Some(layout);
        }
        // the zoom scales everything sized in rems (see widgets::r)
        window.set_rem_size(px(16.0 * app_state::settings(cx).zoom as f32));

        // a page whose peripheral is gone falls back to everything
        if let Some(page) = self.page.clone()
            && !self.pages().iter().any(|(name, _)| *name == page)
        {
            self.page = None;
            self.refilter(false);
        }
        let content = if self.state.is_empty() {
            div().flex_1().flex().child(self.render_empty()).into_any_element()
        } else {
            let values = list(
                self.list.clone(),
                cx.processor(|this, row: usize, _window, cx| {
                    let index = this.value_at_row(row);
                    this.render_item(index, cx)
                }),
            )
            .size_full()
            .pt(r(theme::space(6.0, 2.0)))
            .pb(r(48.0));
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .child(self.render_sidebar(cx))
                .child(div().flex_1().min_w_0().h_full().relative().child(values).vertical_scrollbar(&self.list))
                .into_any_element()
        };

        let root = div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme::bg())
            .text_color(theme::text())
            .font_family(theme::ui())
            .text_size(r(13.0))
            .key_context("Workspace")
            .track_focus(&self.focus);
        // Ctrl + mouse wheel zooms anywhere (before the list scrolls)
        let me = cx.entity().downgrade();
        let zoom_wheel = canvas(
            |_, _, _| {},
            move |_, _, window, _| {
                let me = me.clone();
                window.on_mouse_event(move |event: &ScrollWheelEvent, phase, _, cx| {
                    if phase != DispatchPhase::Capture || !(event.modifiers.control || event.modifiers.platform) {
                        return;
                    }
                    // as the browser: 100 units of wheel per zoom step (a notch is 100)
                    let notches = match event.delta {
                        ScrollDelta::Lines(lines) => lines.y,
                        ScrollDelta::Pixels(pixels) => f32::from(pixels.y) / 100.0,
                    };
                    let steps = me
                        .update(cx, |this, _| {
                            this.wheel += notches;
                            let steps = this.wheel.trunc();
                            this.wheel -= steps;
                            steps
                        })
                        .unwrap_or(0.0);
                    if steps != 0.0 {
                        app_state::update(cx, |settings| settings.zoom += f64::from(steps) * bitviewer_core::settings::ZOOM_STEP);
                    }
                    cx.stop_propagation();
                });
            },
        )
        .absolute()
        .size_0();
        let root = root
            .child(zoom_wheel)
            // Esc clears the selection of the value being worked on
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    window.dispatch_action(Box::new(crate::commands::ClearSelection), cx);
                    let _ = this;
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, _, cx| {
                    let pressed = this.pressed_card.take();
                    for (id, (card, _)) in &this.cards {
                        if Some(*id) != pressed && card.read(cx).has_selection() {
                            card.update(cx, |card, cx| card.clear_selection(cx));
                        }
                    }
                }),
            )
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| this.drag_moved(event, cx)))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _: &MouseUpEvent, _, cx| {
                    this.finish_drag(true, cx);
                    // a paint stroke always ends, wherever the button is let go
                    let mut painting = false;
                    for (card, _) in this.cards.values() {
                        painting |= card.update(cx, |card, _| card.stop_paint());
                    }
                    if painting {
                        this.break_merge();
                    }
                }),
            )
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if this.tour_key(event, cx) {
                    cx.stop_propagation();
                    return;
                }
                if this.drag.is_some() && event.keystroke.key == "escape" {
                    this.finish_drag(false, cx);
                    cx.stop_propagation();
                }
            }));
        self.register_actions(root, cx)
            .child(self.render_titlebar(window, cx))
            .child(self.render_toolbar(cx))
            .children(self.render_search(cx))
            .child(content)
            .child(self.render_statusbar(cx))
            .child(Self::drop_overlay().on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| this.files_dropped(paths, window, cx))))
            .children(self.palette.clone())
            .children(self.render_tour(window, cx))
            // the component library draws its sheets, dialogs and notifications
            // over the window when the content asks it to
            .children(crate::kit::component::Root::render_sheet_layer(window, cx))
            .children(crate::kit::component::Root::render_dialog_layer(window, cx))
            .children(crate::kit::component::Root::render_notification_layer(window, cx))
    }
}
