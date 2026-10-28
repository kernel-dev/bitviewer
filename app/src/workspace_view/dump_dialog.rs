//! File › Import memory dump…: fills registers from a dump of memory (a
//! file, or debugger output pasted in), after a preview of what changes.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::kit::component::WindowExt;
use crate::kit::component::input::{InputEvent, InputState, Textarea, TextareaState};
use crate::kit::component::notification::Notification;
use crate::kit::*;
use bitviewer_core::dump::{Format, Matches, Memory, match_registers, read_dump};
use bitviewer_core::integers::{Base, Bits, format_int};
use bitviewer_core::workspace::{Peripheral, PeripheralSnapshot};

use super::WorkspaceView;
use crate::value_dialogs::field_box;
use crate::widgets::{Btn, Look, SegSize, r, seg_button, seg_track};
use crate::{modal, theme};

/// Dump files go to this dialog when dropped (debugger text is pasted).
pub fn is_dump(path: &Path) -> bool {
    let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    matches!(extension.as_str(), "bin" | "hex" | "ihex" | "srec" | "s19" | "s28" | "s37" | "mot")
}

/// Rows shown in the preview (the rest are counted).
const SHOWN: usize = 200;

impl WorkspaceView {
    /// Opens the dialog, with `path` already loaded when given.
    pub(crate) fn import_dump(&mut self, path: Option<PathBuf>, window: &mut Window, cx: &mut Context<Self>) -> Entity<DumpView> {
        let workspace = cx.entity().downgrade();
        let view = cx.new(|cx| {
            let paste = cx.new(|cx| {
                TextareaState::new(window, cx).soft_wrap(false).placeholder("Paste debugger output, e.g.\n0x40004400: 0x000000C0 0x00000041 0x00000683")
            });
            let start = cx.new(|cx| InputState::new(window, cx).default_value("0x0").placeholder("0x40004400"));
            let subscriptions = vec![
                cx.subscribe_in(&paste, window, |this: &mut DumpView, paste, event: &InputEvent, window, cx| {
                    if let InputEvent::Change = event {
                        // debugger output separates numbers with tabs, which the box
                        // doesn't show: they become spaces
                        let text = paste.read(cx).value().to_string();
                        if text.contains('\t') {
                            paste.update(cx, |paste, cx| paste.set_value(text.replace('\t', "  "), window, cx));
                        }
                        this.file = None;
                        this.reread(cx);
                    }
                }),
                cx.subscribe(&start, |this: &mut DumpView, _, event: &InputEvent, cx| {
                    if let InputEvent::Change = event {
                        this.reread(cx);
                    }
                }),
            ];
            DumpView { workspace, paste, start, file: None, little_endian: true, keep: true, read: None, changes: 0, _subscriptions: subscriptions }
        });
        if let Some(path) = path {
            view.update(cx, |view, cx| view.load(&path, cx));
        }
        let shown = view.clone();
        window.open_dialog(cx, move |dialog, _, cx| {
            let view = shown.clone();
            // (built while the workspace draws: only the dialog's own state)
            let changes = view.read(cx).changes;
            let apply = view.clone();
            let label = match changes {
                0 => "Update registers".to_string(),
                1 => "Update 1 register".to_string(),
                n => format!("Update {n} registers"),
            };
            modal::frame(dialog, "cpu", "Import memory dump", true).w(px(760.0)).child(view.clone()).footer(
                modal::footer().child(Btn::new("dump-cancel", Look::Ghost).label("Cancel").on_click(|_, window, cx| window.close_dialog(cx))).child(
                    Btn::new("dump-apply", Look::Primary)
                        .label(label)
                        .disabled(changes == 0)
                        .test_label("dump-apply")
                        .on_click(move |_, window, cx| apply.update(cx, |view, cx| view.apply(window, cx))),
                ),
            )
        });
        view
    }

    /// Sets the registers a dump changes (one undo step), first keeping each
    /// touched peripheral's registers as a snapshot called `snapshot`.
    fn apply_dump(&mut self, values: Vec<(usize, Bits)>, snapshot: Option<&str>, cx: &mut Context<Self>) -> usize {
        let before = self.state.clone();
        if let Some(name) = snapshot {
            let mut blocks: Vec<Arc<str>> = values.iter().filter_map(|(index, _)| self.state.values.get(*index)).map(|value| value.block.clone()).collect();
            blocks.sort();
            blocks.dedup();
            let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64);
            for block in blocks {
                let Some(old) = self.state.peripherals.get(&block).cloned() else { continue };
                let kept = self.state.values.iter().filter(|value| value.block == block).map(|value| (value.name.clone(), value.value)).collect();
                let mut peripheral = Peripheral::clone(&old);
                peripheral.snapshots.push(PeripheralSnapshot { name: name.into(), at, values: kept });
                self.state.peripherals.insert(block, Arc::new(peripheral));
            }
        }
        let mut count = 0;
        for (index, bits) in values {
            if index < self.state.len() && self.state.edit(index, |value| value.set_value(bits)) {
                count += 1;
                self.remeasure_values(index..index + 1);
            }
        }
        self.history.record(&before, None);
        self.changed(cx);
        count
    }
}

pub struct DumpView {
    workspace: WeakEntity<WorkspaceView>,
    paste: Entity<TextareaState>,
    /// Where a binary file starts.
    start: Entity<InputState>,
    /// A loaded file: its name and bytes (else the pasted text is read).
    file: Option<(String, Vec<u8>)>,
    little_endian: bool,
    /// Keep the old values as a peripheral snapshot.
    keep: bool,
    read: Option<Result<(Memory, Format), String>>,
    /// How many registers the dump changes (for the footer).
    changes: usize,
    _subscriptions: Vec<Subscription>,
}

impl DumpView {
    /// Puts `text` in the paste box (--shot).
    pub(crate) fn paste(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let text = text.replace('\t', "  ");
        self.paste.update(cx, |paste, cx| paste.set_value(text, window, cx));
        self.file = None;
        self.reread(cx);
    }

    fn start_address(&self, cx: &App) -> Option<u64> {
        let text = self.start.read(cx).value().trim().replace('_', "");
        let digits = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")).unwrap_or(&text);
        u64::from_str_radix(digits, 16).ok()
    }

    fn reread(&mut self, cx: &mut Context<Self>) {
        let start = self.start_address(cx);
        self.read = match &self.file {
            Some((_, bytes)) => Some(match start {
                Some(start) => read_dump(bytes, start, self.little_endian).map_err(|error| error.0),
                None => Err("The start address isn't a hex number".into()),
            }),
            None => {
                let text = self.paste.read(cx).value().to_string();
                (!text.trim().is_empty()).then(|| read_dump(text.as_bytes(), start.unwrap_or(0), self.little_endian).map_err(|error| error.0))
            }
        };
        cx.notify();
    }

    fn load(&mut self, path: &Path, cx: &mut Context<Self>) {
        let name = path.file_name().map_or_else(|| "the file".to_string(), |name| name.to_string_lossy().into_owned());
        match std::fs::read(path) {
            Ok(bytes) => {
                self.file = Some((name, bytes));
                self.reread(cx);
            }
            Err(error) => {
                self.file = None;
                self.read = Some(Err(format!("Could not read {name}: {error}")));
                cx.notify();
            }
        }
    }

    fn pick_file(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: Some("Import memory dump".into()) });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else { return };
            let Some(path) = paths.into_iter().next() else { return };
            this.update(cx, |this, cx| this.load(&path, cx)).ok();
        })
        .detach();
    }

    fn matches(&self, cx: &App) -> Option<Matches> {
        let Some(Ok((memory, _))) = &self.read else { return None };
        let workspace = self.workspace.upgrade()?;
        Some(match_registers(&workspace.read(cx).state, memory, self.little_endian))
    }

    fn apply(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(matches) = self.matches(cx) else { return };
        let values: Vec<(usize, Bits)> =
            matches.found.iter().filter(|found| found.dumped != found.now).map(|found| (found.value_index, found.dumped)).collect();
        if values.is_empty() {
            return;
        }
        let source = self.file.as_ref().map_or("the dump".to_string(), |(name, _)| name.clone());
        let snapshot = self.keep.then(|| format!("Before {source}"));
        window.close_dialog(cx);
        let count = self.workspace.update(cx, |workspace, cx| workspace.apply_dump(values, snapshot.as_deref(), cx)).unwrap_or(0);
        let kept = if self.keep { "; the old values are kept as a snapshot" } else { "" };
        window.push_notification(Notification::info(format!("Updated {count} register{} from {source}{kept}", if count == 1 { "" } else { "s" })), cx);
    }
}

impl Render for DumpView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let label = |text: &'static str| div().text_size(r(12.5)).text_color(palette.muted).child(text);

        // where the dump comes from
        let source = match &self.file {
            Some((name, bytes)) => div()
                .flex()
                .items_center()
                .gap(r(10.0))
                .child(div().font_weight(FontWeight::SEMIBOLD).child(name.clone()))
                .child(div().text_color(palette.muted).child(format!("{} bytes", bytes.len())))
                .child(Btn::new("dump-unload", Look::Ghost).small().label("Paste instead").on_click(cx.listener(|this, _, _, cx| {
                    this.file = None;
                    this.reread(cx);
                }))),
            None => div().child(
                div()
                    .h(r(110.0))
                    .px(r(10.0))
                    .py(r(8.0))
                    .bg(palette.input)
                    .border_1()
                    .border_color(palette.border_strong)
                    .rounded(r(8.0))
                    .font_family(theme::mono())
                    .text_size(r(12.5))
                    .debug_selector(|| "dump-paste".into())
                    .child(Textarea::new(&self.paste).appearance(false).h_full()),
            ),
        };
        let mut order = seg_track();
        for (text, little) in [("Little-endian", true), ("Big-endian", false)] {
            order = order.child(seg_button(text, text, self.little_endian == little, SegSize::Normal).on_click(cx.listener(move |this, _, _, cx| {
                this.little_endian = little;
                this.reread(cx);
            })));
        }
        let keep = crate::modal::switch("dump-keep", self.keep, {
            let me = cx.entity().downgrade();
            move |on, _, cx| {
                me.update(cx, |this, cx| {
                    this.keep = on;
                    cx.notify();
                })
                .ok();
            }
        });
        let binary = matches!(&self.read, Some(Ok((_, Format::Binary))));
        let mut options = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(r(12.0))
            .child(
                Btn::new("dump-file", Look::Outline)
                    .icon("folder-open")
                    .label("Open a file…")
                    .on_click(cx.listener(|this, _, window, cx| this.pick_file(window, cx))),
            )
            .child(label("Byte order"))
            .child(order);
        if binary {
            options = options.child(label("Starts at")).child(div().w(r(150.0)).child(field_box(&self.start, self.start_address(cx).is_none(), 30.0, true)));
        }
        let mut body = div()
            .flex()
            .flex_col()
            .gap(r(12.0))
            .child(div().text_color(palette.muted).child(
                "A binary, Intel HEX or S-record file, or text a debugger printed (GDB x/…xw, OpenOCD mdw, or “ADDR: WORD WORD …” lines). Registers are found by their address: the peripheral's base address plus the register's offset.",
            ))
            .child(source)
            .child(options);

        let matches = self.matches(cx);
        self.changes = matches.as_ref().map_or(0, |matches| matches.found.iter().filter(|found| found.dumped != found.now).count());
        match (&self.read, matches) {
            (None, _) => {}
            (Some(Err(error)), _) => body = body.child(div().text_color(palette.error).child(error.clone())),
            (Some(Ok((memory, format))), Some(matches)) => {
                let mut summary = format!("Read as {}", format.describe());
                if let Some((bytes, low, high)) = memory.span() {
                    summary.push_str(&format!(" · {bytes} bytes, 0x{low:08X}–0x{high:08X}"));
                }
                summary.push_str(&format!(" · {} of {} registers found change", self.changes, matches.found.len()));
                body = body.child(div().font_weight(FontWeight::SEMIBOLD).debug_selector(|| "dump-summary".into()).child(summary));
                let mut notes = Vec::new();
                if !matches.partial.is_empty() {
                    notes.push(format!("{} only partly in the dump, left as they are: {}", matches.partial.len(), matches.partial.join(", ")));
                }
                if matches.found.is_empty() && matches.without_address > 0 {
                    notes.push(format!(
                        "{} values have no address (no peripheral base address or no offset), so nothing can match them",
                        matches.without_address
                    ));
                }
                for note in notes {
                    body = body.child(div().text_size(r(12.5)).text_color(palette.muted).child(note));
                }
                if !matches.found.is_empty() {
                    let cell = |text: String, width: f32| div().w(r(width)).flex_none().font_family(theme::mono()).text_size(r(12.5)).child(text);
                    let mut table = div().id("dump-table").flex().flex_col().max_h(r(300.0)).overflow_y_scroll().child(
                        div()
                            .flex()
                            .gap(r(10.0))
                            .py(r(6.0))
                            .border_b_1()
                            .border_color(palette.border)
                            .text_size(r(11.0))
                            .font_weight(FontWeight::BOLD)
                            .text_color(palette.muted)
                            .child(div().w(r(120.0)).flex_none().child("ADDRESS"))
                            .child(div().flex_1().child("REGISTER"))
                            .child(div().w(r(170.0)).flex_none().child("NOW"))
                            .child(div().w(r(170.0)).flex_none().child("FROM THE DUMP")),
                    );
                    let widths: Vec<usize> = {
                        let state = self.workspace.upgrade().map(|w| w.read(cx).state.values.clone()).unwrap_or_default();
                        matches.found.iter().map(|found| state.get(found.value_index).map_or(32, |value| value.width)).collect()
                    };
                    for (found, width) in matches.found.iter().zip(widths).take(SHOWN) {
                        let hex = |bits: Bits| format_int(bits, Base::Hex, width, true, false);
                        let changed = found.dumped != found.now;
                        table = table.child(
                            div()
                                .flex()
                                .items_center()
                                .gap(r(10.0))
                                .py(r(5.0))
                                .px(r(4.0))
                                .rounded(r(6.0))
                                .when(changed, |row| row.bg(palette.select_soft))
                                .child(cell(format!("0x{:08X}", found.address), 120.0).text_color(palette.muted))
                                .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_ellipsis().child(found.name.to_string()))
                                .child(cell(hex(found.now), 170.0).text_color(palette.muted))
                                .child(if changed {
                                    cell(hex(found.dumped), 170.0).text_color(palette.accent)
                                } else {
                                    cell("same".into(), 170.0).text_color(palette.muted)
                                }),
                        );
                    }
                    if matches.found.len() > SHOWN {
                        table = table.child(div().py(r(6.0)).text_color(palette.muted).child(format!("and {} more", matches.found.len() - SHOWN)));
                    }
                    body = body.child(table);
                }
                if self.changes > 0 {
                    body = body.child(div().flex().items_center().gap(r(10.0)).child(keep).child(
                        div().text_color(palette.muted).child("Keep the old values as a snapshot of each peripheral (Compare with… shows what changed)"),
                    ));
                }
            }
            (Some(Ok(_)), None) => {}
        }
        body
    }
}

use crate::kit::prelude::FluentBuilder as _;
