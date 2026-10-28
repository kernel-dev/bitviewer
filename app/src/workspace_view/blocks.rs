//! Peripheral blocks: a header above a peripheral's registers, which sit
//! indented beside a rail (workspace.css .periph). In the list every value
//! is one item, so the header belongs to a block's first item and each item
//! of the block draws its piece of the rail.

use std::sync::Arc;

use crate::kit::component::WindowExt;
use crate::kit::component::menu::PopupMenuItem;
use crate::kit::component::notification::Notification;
use crate::kit::component::tooltip::Tooltip;
use crate::kit::*;
use bitviewer_core::workspace::Peripheral;

use super::WorkspaceView;
use crate::theme;
use crate::widgets::{Btn, Look, r};

/// Where a value sits in its peripheral.
struct Place {
    peripheral: Arc<Peripheral>,
    first: bool,
    last: bool,
}

impl WorkspaceView {
    fn place(&self, index: usize) -> Option<Place> {
        let values = &self.state.values;
        let block = &values[index].block;
        if block.is_empty() {
            return None;
        }
        let peripheral = self.state.peripherals.get(block)?.clone();
        // first and last of the block's values on show (a search may hide some)
        let shown_before = (0..index).rev().take_while(|&j| values[j].block == *block).any(|j| self.shown(j));
        let shown_after = (index + 1..values.len()).take_while(|&j| values[j].block == *block).any(|j| self.shown(j));
        let (first, last) = (!shown_before, !shown_after);
        Some(Place { peripheral, first, last })
    }

    /// The positions of the block's values (they are next to each other).
    pub(super) fn block_range(&self, block: &str) -> std::ops::Range<usize> {
        let values = &self.state.values;
        let Some(start) = values.iter().position(|value| &*value.block == block) else {
            return 0..0;
        };
        let count = values.iter().skip(start).take_while(|value| &*value.block == block).count();
        start..start + count
    }

    /// The positions of the block the value at `index` belongs to (looking
    /// only at its neighbours: cheap in any size of workspace).
    fn block_around(&self, index: usize) -> std::ops::Range<usize> {
        let values = &self.state.values;
        let block = &values[index].block;
        let start = (0..index).rev().take_while(|&j| values[j].block == *block).last().unwrap_or(index);
        let end = (index + 1..values.len()).take_while(|&j| values[j].block == *block).last().unwrap_or(index) + 1;
        start..end
    }

    /// Changes a peripheral (one undo step).
    fn change_peripheral(&mut self, name: &Arc<str>, edit: impl FnOnce(&mut Peripheral), cx: &mut Context<Self>) {
        let Some(peripheral) = self.state.peripherals.get(name).cloned() else { return };
        let before = self.state.clone();
        let mut changed = Peripheral::clone(&peripheral);
        edit(&mut changed);
        if changed == *peripheral {
            return;
        }
        self.state.peripherals.insert(name.clone(), Arc::new(changed));
        self.history.record(&before, None);
        let range = self.block_range(name);
        self.remeasure_values(range);
        self.changed(cx);
    }

    fn toggle_peripheral(&mut self, name: &Arc<str>, cx: &mut Context<Self>) {
        crate::sound::play(crate::sound::Sound::Toggle, cx);
        self.change_peripheral(name, |peripheral| peripheral.collapsed = !peripheral.collapsed, cx);
    }

    /// Puts the block's registers in address order (one undo step).
    fn sort_block(&mut self, name: &Arc<str>, cx: &mut Context<Self>) {
        let range = self.block_range(name);
        let before = self.state.clone();
        let mut members: Vec<_> = self.state.values.iter().skip(range.start).take(range.len()).cloned().collect();
        // values without an offset go last, keeping their order
        members.sort_by_key(|value| value.offset.unwrap_or(u64::MAX));
        if members.iter().zip(before.values.iter().skip(range.start)).all(|(a, b)| Arc::ptr_eq(a, b)) {
            return;
        }
        for (offset, value) in members.into_iter().enumerate() {
            self.state.values.set(range.start + offset, value);
        }
        self.history.record(&before, None);
        self.remeasure_values(range);
        self.changed(cx);
    }

    /// Takes the registers out of the peripheral (they stay as plain values),
    /// or removes them with it.
    pub(super) fn dissolve_block(&mut self, name: &Arc<str>, keep_values: bool, cx: &mut Context<Self>) {
        let range = self.block_range(name);
        let before = self.state.clone();
        if keep_values {
            for index in range.clone() {
                self.state.edit(index, |value| value.set_peripheral("", None));
            }
            self.remeasure_values(range);
        } else {
            for _ in range.clone() {
                self.state.values.remove(range.start);
            }
            self.splice_values(range, 0);
        }
        self.state.peripherals.remove(name);
        self.history.record(&before, None);
        self.changed(cx);
    }

    fn render_peripheral_header(&self, peripheral: &Arc<Peripheral>, count: usize, cx: &mut Context<Self>) -> Div {
        let palette = theme::current();
        let name = peripheral.name.clone();
        let collapsed = peripheral.collapsed;
        let toggle_name = name.clone();
        let collapse = Btn::new("periph-collapse", Look::Ghost)
            .small()
            .icon(if collapsed { "chevron-right" } else { "chevron-down" })
            .tip(if collapsed { "Show the registers" } else { "Hide the registers" })
            .on_click(cx.listener(move |this, _, _, cx| this.toggle_peripheral(&toggle_name, cx)));

        let base = match peripheral.base {
            Some(base) => div().child(format!("0x{:04X}_{:04X}", base >> 16, base & 0xFFFF)),
            None => div().child("not set"),
        };
        let base_tip = if peripheral.base.is_some() {
            "Base address. Click to change it."
        } else {
            "No base address yet: registers show their offsets. Click to set one."
        };

        let workspace = cx.entity().downgrade();
        let menu_name = name.clone();
        let more = Btn::new("periph-more", Look::Ghost).small().icon("ellipsis").tip("Peripheral actions").menu(Anchor::TopRight, move |menu, _, _| {
            let action = |label: &'static str, icon_name: &'static str, run: fn(&mut WorkspaceView, &Arc<str>, &mut Window, &mut Context<WorkspaceView>)| {
                let workspace = workspace.clone();
                let name = menu_name.clone();
                PopupMenuItem::new(label).icon(crate::kit::component::Icon::empty().path(format!("icons/{icon_name}.svg"))).on_click(move |_, window, cx| {
                    workspace.update(cx, |this, cx| run(this, &name, window, cx)).ok();
                })
            };
            menu.item(action("Edit name, base address, description…", "pencil-line", |this, name, window, cx| this.edit_peripheral(name, window, cx)))
                .item(action("Add register", "plus", |this, name, _, cx| this.add_register(name, cx)))
                .item(action("Sort registers by offset", "arrow-up-down", |this, name, _, cx| this.sort_block(name, cx)))
                .item(action("Export code…", "file-code-corner", |this, name, window, cx| this.export_peripheral(name, window, cx)))
                .separator()
                .item(action("Take snapshot…", "camera", |this, name, window, cx| this.snapshot_peripheral(name, window, cx)))
                .item(action("Compare with…", "git-compare-arrows", |this, name, window, cx| this.compare_peripheral(name, window, cx)))
                .separator()
                .item(action("Move up", "arrow-up", |this, name, _, cx| this.move_peripheral(name, -1, cx)))
                .item(action("Move down", "arrow-down", |this, name, _, cx| this.move_peripheral(name, 1, cx)))
                .separator()
                .item(action("Ungroup (keep the values)", "ungroup", |this, name, window, cx| {
                    this.dissolve_block(name, true, cx);
                    window.push_notification(Notification::info(format!("Ungrouped {name}; Ctrl+Z puts it back")), cx);
                }))
                .item(action("Remove peripheral and its registers", "trash", |this, name, window, cx| this.remove_peripheral(name, window, cx)))
        });

        let description = peripheral.description.clone();
        let edit = |name: Arc<str>| {
            cx.listener(move |this: &mut WorkspaceView, _: &ClickEvent, window: &mut Window, cx: &mut Context<WorkspaceView>| {
                this.edit_peripheral(&name, window, cx)
            })
        };
        let title = div()
            .id("periph-name")
            .px(r(4.0))
            .ml(r(-4.0))
            .rounded(r(6.0))
            .text_size(r(30.0))
            .line_height(r(38.0))
            .font_weight(FontWeight::SEMIBOLD)
            .cursor_pointer()
            .hover(move |style| style.bg(palette.surface_2))
            .tooltip(|window, cx| Tooltip::new("Edit the peripheral").build(window, cx))
            .on_click(edit(name.clone()))
            .child(name.to_string());
        let base = div()
            .id("periph-base")
            .flex()
            .items_center()
            .gap(r(5.0))
            .cursor_pointer()
            .tooltip(move |window, cx| Tooltip::new(base_tip).build(window, cx))
            .on_click(edit(name.clone()))
            .child("Base")
            .child(base.font_family(theme::mono()).text_color(palette.text).hover(move |style| style.text_color(palette.accent)));
        div()
            .flex()
            .flex_col()
            .gap(r(4.0))
            .pt(r(theme::space(40.0, 24.0)))
            .pb(r(theme::space(16.0, 10.0)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(r(10.0))
                    .min_w_0()
                    .child(div().ml(r(-34.0)).child(collapse))
                    .child(title)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_size(r(14.0))
                            .text_color(palette.muted)
                            .child(description.to_string()),
                    )
                    .child(
                        Btn::new("periph-export", Look::Ghost)
                            .small()
                            .icon("file-code-corner")
                            .label("Export code")
                            .tip("Export code for the whole peripheral: a C struct, #defines or Rust")
                            .on_click(cx.listener({
                                let name = name.clone();
                                move |this, _, window, cx| this.export_peripheral(&name, window, cx)
                            })),
                    )
                    .child(more),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(r(20.0))
                    .text_size(r(13.0))
                    .text_color(palette.muted)
                    .child(base)
                    .child(format!("{count} register{}", if count == 1 { "" } else { "s" })),
            )
    }

    /// One list item: the value's card, inside its peripheral's block if it
    /// has one (with the block's header above its first register).
    /// The card at `index`, faded while it is dragged.
    fn item_card(&mut self, index: usize, cx: &mut Context<Self>) -> Div {
        let palette = theme::current();
        let card = self.card(index, cx);
        let dragging = self.dragging(self.state.values[index].id);
        let mut wrapper = div().child(card);
        if dragging {
            wrapper = wrapper.opacity(0.55).rounded(r(14.0)).border_2().border_dashed().border_color(palette.accent_line);
        }
        wrapper
    }

    pub(super) fn render_item(&mut self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let line_before = self.drop_line(index);
        let line_after = if index + 1 == self.state.len() { self.drop_line(index + 1) } else { None };
        let item = self.render_item_inner(index, cx);
        div().children(line_before).child(item).children(line_after).into_any_element()
    }

    fn render_item_inner(&mut self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let palette = theme::current();
        if !self.shown(index) {
            return div().into_any_element();
        }
        let page = crate::card::PAGE_WIDTH;
        let pad = crate::card::PAGE_PAD;
        let item = div().w_full().max_w(r(page)).mx_auto().px(r(pad));
        let Some(place) = self.place(index) else {
            return item.child(self.item_card(index, cx)).into_any_element();
        };
        // while searching, collapsed peripherals open so their matches show
        let collapsed = place.peripheral.collapsed && !self.searching();
        let mut item = item;
        if place.first {
            let count = self.block_around(index).len();
            let header = self.render_peripheral_header(&place.peripheral, count, cx);
            item = item.child(header);
            if collapsed {
                return item.into_any_element();
            }
        } else if collapsed {
            return div().into_any_element();
        }
        let _ = (palette, place.last);
        item.child(self.item_card(index, cx)).into_any_element()
    }
}
