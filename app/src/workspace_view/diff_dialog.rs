//! Peripheral snapshots and the peripheral diff: every register of a
//! peripheral compared with a snapshot of it, or with the same registers in
//! another workspace file, down to the fields that changed.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::Arc;

use crate::kit::component::WindowExt;
use crate::kit::component::menu::PopupMenuItem;
use crate::kit::component::notification::Notification;
use crate::kit::component::tooltip::Tooltip;
use crate::kit::*;
use bitviewer_core::diff::{Diff, diff, diff_text};
use bitviewer_core::integers::{Base, Bits, format_int};
use bitviewer_core::workspace::{Peripheral, PeripheralSnapshot, parse_workspace_file};

use super::WorkspaceView;
use crate::widgets::{Btn, Look, icon, r};
use crate::{modal, prompt, theme};

/// What the registers are compared with.
#[derive(Clone)]
enum Source {
    /// The peripheral's snapshot at this index.
    Snapshot(usize),
    /// Another workspace: register values by name, and by address.
    File { label: String, by_name: HashMap<String, Bits>, by_address: HashMap<u64, Bits> },
}

fn now_millis() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn when(at: i64) -> String {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(at).single().map_or(String::new(), |when| when.format("%d/%m/%Y, %H:%M").to_string())
}

impl WorkspaceView {
    /// Peripheral ⋯ › Take snapshot…: keeps every register's value under a name.
    pub(crate) fn snapshot_peripheral(&mut self, name: &Arc<str>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(peripheral) = self.state.peripherals.get(name).cloned() else { return };
        let suggested = format!("Snapshot {}", peripheral.snapshots.len() + 1);
        let workspace = cx.entity().downgrade();
        let block = name.clone();
        prompt::ask_with(
            "camera",
            window,
            cx,
            format!("Snapshot of {name}"),
            "A name for its registers as they are now",
            suggested,
            move |text, window, cx| {
                let text = text.trim();
                if text.is_empty() {
                    return Err("Give the snapshot a name".into());
                }
                let (block, text) = (block.clone(), text.to_string());
                workspace
                    .update(cx, |this, cx| {
                        let count = this.keep_snapshot(&block, &text, cx);
                        window.push_notification(Notification::info(format!("Kept “{text}”: {count} registers of {block}")), cx);
                    })
                    .ok();
                Ok(None)
            },
        );
    }

    /// Keeps the registers of `block` as a snapshot called `name` (one undo
    /// step). Returns how many registers it holds.
    pub(super) fn keep_snapshot(&mut self, block: &Arc<str>, name: &str, cx: &mut Context<Self>) -> usize {
        let before = self.state.clone();
        let values: Vec<(Arc<str>, Bits)> =
            self.state.values.iter().filter(|value| value.block == *block).map(|value| (value.name.clone(), value.value)).collect();
        let count = values.len();
        let Some(old) = self.state.peripherals.get(block).cloned() else { return 0 };
        let mut peripheral = Peripheral::clone(&old);
        peripheral.snapshots.push(PeripheralSnapshot { name: name.into(), at: now_millis(), values });
        self.state.peripherals.insert(block.clone(), Arc::new(peripheral));
        self.history.record(&before, None);
        self.changed(cx);
        count
    }

    /// Peripheral ⋯ › Compare with…: opens the diff, on the newest snapshot.
    pub(crate) fn compare_peripheral(&mut self, name: &Arc<str>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(peripheral) = self.state.peripherals.get(name) else { return };
        let source = peripheral.snapshots.len().checked_sub(1).map(Source::Snapshot);
        let workspace = cx.entity().downgrade();
        let view = cx.new(|_| DiffView { workspace, peripheral: name.clone(), source, picked: BTreeSet::new() });
        let title = format!("Compare {name}");
        window.open_dialog(cx, move |dialog, _, cx| {
            // (built while the workspace draws: only the dialog's own state)
            let ready = !view.read(cx).picked.is_empty();
            let (copy, restore) = (view.clone(), view.clone());
            modal::frame(dialog, "git-compare-arrows", title.clone(), true).w(px(780.0)).child(view.clone()).footer(
                modal::footer()
                    .child(
                        Btn::new("diff-copy", Look::Ghost)
                            .icon("copy")
                            .label("Copy as text")
                            .on_click(move |_, window, cx| copy.update(cx, |view, cx| view.copy(window, cx))),
                    )
                    .child(
                        Btn::new("diff-restore", Look::Outline)
                            .label("Restore ticked")
                            .disabled(!ready)
                            .test_label("diff-restore")
                            .on_click(move |_, window, cx| restore.update(cx, |view, cx| view.restore(window, cx))),
                    )
                    .child(Btn::new("diff-close", Look::Primary).label("Close").on_click(|_, window, cx| window.close_dialog(cx))),
            )
        });
    }

    /// Sets registers to the given values (one undo step).
    pub(super) fn restore_registers(&mut self, values: Vec<(usize, Bits)>, cx: &mut Context<Self>) -> usize {
        let before = self.state.clone();
        let mut count = 0;
        for (index, bits) in values {
            if index < self.state.len() && self.state.edit(index, |value| value.set_value(bits)) {
                count += 1;
                self.remeasure_values(index..index + 1);
            }
        }
        if count > 0 {
            self.history.record(&before, None);
            self.changed(cx);
        }
        count
    }
}

pub struct DiffView {
    workspace: WeakEntity<WorkspaceView>,
    peripheral: Arc<str>,
    source: Option<Source>,
    /// Registers (by workspace index) ticked to restore.
    picked: BTreeSet<usize>,
}

impl DiffView {
    /// The comparison as it stands (the workspace may have changed since).
    fn current(&self, cx: &App) -> Option<(Diff, String)> {
        let workspace = self.workspace.upgrade()?;
        let state = &workspace.read(cx).state;
        let peripheral = state.peripherals.get(&self.peripheral)?;
        let values = state.values.iter().enumerate().filter(|(_, value)| value.block == self.peripheral).map(|(index, value)| (index, value.as_ref()));
        match self.source.as_ref()? {
            Source::Snapshot(index) => {
                let snapshot = peripheral.snapshots.get(*index)?;
                Some((diff(values, |value| snapshot.value_of(&value.name)), snapshot.name.to_string()))
            }
            Source::File { label, by_name, by_address } => {
                let base = peripheral.base;
                let then = |value: &bitviewer_core::value::Value| {
                    by_name.get(&*value.name).copied().or_else(|| {
                        let address = base?.checked_add(value.offset?)?;
                        by_address.get(&address).copied()
                    })
                };
                Some((diff(values, then), label.clone()))
            }
        }
    }

    fn copy(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(workspace) = self.workspace.upgrade() else { return };
        let Some((diff, label)) = self.current(cx) else { return };
        let values: Vec<_> = workspace.read(cx).state.values.iter().cloned().collect();
        let text = format!("{} compared with {label}\n{}", self.peripheral, diff_text(&diff, &label, &values));
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        window.push_notification(Notification::info("Copied the comparison"), cx);
    }

    fn restore(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((diff, label)) = self.current(cx) else { return };
        let values: Vec<(usize, Bits)> =
            diff.changes.iter().filter(|change| self.picked.contains(&change.value_index)).map(|change| (change.value_index, change.then)).collect();
        let count = self.workspace.update(cx, |workspace, cx| workspace.restore_registers(values, cx)).unwrap_or(0);
        self.picked.clear();
        if count > 0 {
            window.push_notification(
                Notification::info(format!("Restored {count} register{} from “{label}”; Ctrl+Z undoes it", if count == 1 { "" } else { "s" })),
                cx,
            );
        }
        cx.notify();
    }

    /// Asks for a workspace file and compares with its registers.
    fn pick_file(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: Some("Compare with".into()) });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else { return };
            let Some(path) = paths.into_iter().next() else { return };
            this.update_in(cx, |this, window, cx| this.load_file(&path, window, cx)).ok();
        })
        .detach();
    }

    fn load_file(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) {
        let read = std::fs::read_to_string(path).map_err(|error| error.to_string()).and_then(|text| parse_workspace_file(&text).map_err(|error| error.0));
        let file = match read {
            Ok(file) => file,
            Err(error) => {
                window.push_notification(Notification::error(format!("Could not read {}: {error}", path.display())), cx);
                return;
            }
        };
        let state = file.state;
        let mut by_name = HashMap::new();
        let mut by_address = HashMap::new();
        for value in state.values.iter() {
            by_name.insert(value.name.to_string(), value.value);
            let base = state.peripherals.get(&value.block).and_then(|peripheral| peripheral.base);
            if let (Some(base), Some(offset)) = (base, value.offset)
                && let Some(address) = base.checked_add(offset)
            {
                by_address.insert(address, value.value);
            }
        }
        let label = path.file_name().map_or_else(|| "the file".to_string(), |name| name.to_string_lossy().into_owned());
        self.source = Some(Source::File { label, by_name, by_address });
        self.picked.clear();
        cx.notify();
    }

    fn delete_snapshot(&mut self, index: usize, cx: &mut Context<Self>) {
        let block = self.peripheral.clone();
        self.workspace
            .update(cx, |this, cx| {
                let before = this.state.clone();
                let Some(old) = this.state.peripherals.get(&block).cloned() else { return };
                let mut peripheral = Peripheral::clone(&old);
                if index < peripheral.snapshots.len() {
                    peripheral.snapshots.remove(index);
                    this.state.peripherals.insert(block.clone(), Arc::new(peripheral));
                    this.history.record(&before, None);
                    this.changed(cx);
                }
            })
            .ok();
        let left = self.workspace.upgrade().and_then(|w| w.read(cx).state.peripherals.get(&self.peripheral).map(|p| p.snapshots.len())).unwrap_or(0);
        self.source = left.checked_sub(1).map(Source::Snapshot);
        self.picked.clear();
        cx.notify();
    }

    fn jump(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        window.close_dialog(cx);
        let page = Some(self.peripheral.clone());
        self.workspace
            .update(cx, |workspace, cx| {
                workspace.set_page(page, cx);
                workspace.reveal_value(index);
                cx.notify();
            })
            .ok();
    }
}

impl Render for DiffView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let snapshots: Vec<(String, i64)> = self
            .workspace
            .upgrade()
            .and_then(|workspace| {
                workspace.read(cx).state.peripherals.get(&self.peripheral).map(|p| p.snapshots.iter().map(|s| (s.name.to_string(), s.at)).collect())
            })
            .unwrap_or_default();

        // what to compare with
        let chosen = match &self.source {
            Some(Source::Snapshot(index)) => snapshots.get(*index).map_or("Choose…".to_string(), |(name, at)| format!("Snapshot “{name}”  {}", when(*at))),
            Some(Source::File { label, .. }) => label.clone(),
            None => "Choose…".to_string(),
        };
        let me = cx.entity().downgrade();
        let list = snapshots.clone();
        let picker =
            Btn::new("diff-source", Look::Outline).label(chosen).icon("chevron-down").test_label("diff-source").menu(Anchor::TopLeft, move |mut menu, _, _| {
                for (index, (name, at)) in list.iter().enumerate() {
                    let me = me.clone();
                    menu = menu.item(PopupMenuItem::new(format!("Snapshot “{name}”  ·  {}", when(*at))).on_click(move |_, _, cx| {
                        me.update(cx, |this, cx| {
                            this.source = Some(Source::Snapshot(index));
                            this.picked.clear();
                            cx.notify();
                        })
                        .ok();
                    }));
                }
                if !list.is_empty() {
                    menu = menu.separator();
                }
                let me = me.clone();
                menu.item(PopupMenuItem::new("A workspace file…").on_click(move |_, window, cx| {
                    me.update(cx, |this, cx| this.pick_file(window, cx)).ok();
                }))
            });
        let mut top = div().flex().items_center().gap(r(10.0)).child(div().text_color(palette.muted).child("Compare with")).child(picker);
        if let Some(Source::Snapshot(index)) = self.source {
            top = top.child(
                Btn::new("diff-delete", Look::Ghost)
                    .icon("trash")
                    .tip("Delete this snapshot")
                    .on_click(cx.listener(move |this, _, _, cx| this.delete_snapshot(index, cx))),
            );
        }
        let mut body = div().flex().flex_col().gap(r(12.0)).child(top);

        let Some((diff, label)) = self.current(cx) else {
            let hint = if snapshots.is_empty() {
                "No snapshots of this peripheral yet. Take one with ⋯ › Take snapshot…, change its registers, then compare. Or compare with a workspace file."
            } else {
                "Choose a snapshot or a workspace file to compare with."
            };
            return body.child(div().text_color(palette.muted).child(hint));
        };
        let total = diff.changes.len() + diff.same + diff.missing.len();
        let fields: usize = diff.changes.iter().map(|change| change.fields.len()).sum();
        let mut summary = format!("{} of {total} registers differ", diff.changes.len());
        if fields > 0 {
            summary.push_str(&format!(" · {fields} field{}", if fields == 1 { "" } else { "s" }));
        }
        if !diff.missing.is_empty() {
            summary.push_str(&format!(" · {} not in “{label}”", diff.missing.len()));
        }
        body = body.child(div().font_weight(FontWeight::SEMIBOLD).debug_selector(|| "diff-summary".into()).child(summary));
        if diff.changes.is_empty() {
            return body.child(div().text_color(palette.muted).child("Every register matches."));
        }

        let values = self.workspace.upgrade().map(|w| w.read(cx).state.values.clone()).unwrap_or_default();
        let cell = |text: String, width: f32| div().w(r(width)).flex_none().font_family(theme::mono()).text_size(r(12.5)).child(text);
        let mut table = div().id("diff-table").flex().flex_col().max_h(r(420.0)).overflow_y_scroll();
        table = table.child(
            div()
                .flex()
                .items_center()
                .gap(r(10.0))
                .py(r(6.0))
                .border_b_1()
                .border_color(palette.border)
                .text_size(r(11.0))
                .font_weight(FontWeight::BOLD)
                .text_color(palette.muted)
                .child(div().w(r(22.0)).flex_none())
                .child(div().flex_1().child("REGISTER / FIELD"))
                .child(div().w(r(190.0)).flex_none().child(label.to_uppercase()))
                .child(div().w(r(190.0)).flex_none().child("NOW"))
                .child(div().w(r(70.0)).flex_none()),
        );
        for change in &diff.changes {
            let index = change.value_index;
            let ticked = self.picked.contains(&index);
            let hex = |bits: Bits| format_int(bits, Base::Hex, change.width, true, false);
            let tick = div()
                .id(("diff-tick", index))
                .size(r(16.0))
                .flex_none()
                .rounded(r(4.0))
                .border_1()
                .border_color(if ticked { palette.accent } else { palette.border_strong })
                .bg(if ticked { palette.accent } else { palette.input })
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .debug_selector(move || format!("diff-tick-{index}"))
                .tooltip(|window, cx| Tooltip::new("Tick to restore it").build(window, cx))
                .when(ticked, |tick| tick.child(icon("check", 12.0).text_color(palette.on_accent)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if !this.picked.remove(&index) {
                        this.picked.insert(index);
                    }
                    cx.notify();
                }));
            let name = div()
                .id(("diff-name", index))
                .flex_1()
                .min_w_0()
                .font_weight(FontWeight::SEMIBOLD)
                .cursor_pointer()
                .hover(move |style| style.text_color(palette.accent))
                .tooltip(|window, cx| Tooltip::new("Show this register").build(window, cx))
                .on_click(cx.listener(move |this, _, window, cx| this.jump(index, window, cx)))
                .child(change.name.to_string());
            table = table.child(
                div()
                    .flex()
                    .items_center()
                    .gap(r(10.0))
                    .pt(r(8.0))
                    .pb(r(4.0))
                    .child(div().w(r(22.0)).flex_none().child(tick))
                    .child(name)
                    .child(cell(hex(change.then), 190.0).text_color(palette.muted))
                    .child(cell(hex(change.now), 190.0).text_color(palette.accent))
                    .child(div().w(r(70.0)).flex_none().text_size(r(12.0)).text_color(palette.muted).child(format!(
                        "Δ {} bit{}",
                        change.bits(),
                        if change.bits() == 1 { "" } else { "s" }
                    ))),
            );
            let value = values.get(index);
            for field in &change.fields {
                let target = value.and_then(|value| value.fields.get(field.index));
                let width = target.map_or(1, |target| target.width());
                let shown = |bits: Bits| {
                    let number = format_int(bits, target.map_or(Base::Hex, |target| target.base), width, true, false);
                    match target.and_then(|target| target.name_of(bits)) {
                        Some(named) => format!("{number} {named}"),
                        None => number,
                    }
                };
                let color = target.map_or(palette.muted, |target| theme::field_color(&target.color, 1.0));
                table = table.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(r(10.0))
                        .py(r(3.0))
                        .text_size(r(12.5))
                        .child(div().w(r(22.0)).flex_none())
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .pl(r(14.0))
                                .flex()
                                .items_center()
                                .gap(r(6.0))
                                .child(div().size(r(8.0)).rounded(r(2.0)).bg(color))
                                .child(div().font_family(theme::mono()).child(field.name.to_string())),
                        )
                        .child(cell(shown(field.then), 190.0).text_color(palette.muted))
                        .child(cell(shown(field.now), 190.0))
                        .child(div().w(r(70.0)).flex_none()),
                );
            }
            table = table.child(div().h(px(1.0)).mt(r(4.0)).bg(palette.border));
        }
        body.child(table)
    }
}

use crate::kit::prelude::FluentBuilder as _;
