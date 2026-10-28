//! "Import CMSIS-SVD…" (the web app's dialogs/svd.ts and svd-import.ts):
//! pick registers from a device description and add them as values (with
//! fields and reset values, grouped into peripherals) or save them as
//! templates. An array is one row: its copies can be listed, or picked by
//! position ("0-7, 12"), so arrays of any size stay quick.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::rc::Rc;

use crate::kit::component::WindowExt;
use crate::kit::component::input::{InputEvent, InputState};
use crate::kit::component::notification::Notification;
use crate::kit::component::tooltip::Tooltip;
use crate::kit::*;
use bitviewer_core::svd::{IndexSet, SvdDevice, SvdRegister, hex_address, picked_registers, register_template};
use bitviewer_core::templates::template_to_json;

use crate::app_state;
use crate::modal;
use crate::theme;
use crate::value_dialogs::field_box;
use crate::widgets::{Btn, Look, icon, r};
use crate::workspace_view::WorkspaceView;

/// Above this many registers, the import asks first.
const MANY: usize = 50;
/// Rows drawn at once; the filter narrows the rest.
const MAX_ROWS: usize = 400;

/// "1,234 registers".
fn plural(count: usize, word: &str, words: &str) -> String {
    let digits = count.to_string();
    let mut grouped = String::new();
    for (index, c) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(c);
    }
    format!("{grouped} {}", if count == 1 { word } else { words })
}

/// A checkbox: ticked, empty, or in between (some of many).
fn check(chosen: usize, total: usize) -> Div {
    let palette = theme::current();
    let on = chosen > 0 && chosen == total;
    let partial = chosen > 0 && chosen < total;
    let mut box_ = div()
        .size(r(14.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(r(3.0))
        .border_1()
        .border_color(if on || partial { palette.accent } else { palette.border_strong })
        .bg(if on || partial { palette.accent } else { palette.input });
    if on {
        box_ = box_.child(icon("check", 11.0).text_color(crate::kit::white()));
    } else if partial {
        box_ = box_.child(div().w(r(8.0)).h(r(2.0)).rounded(r(1.0)).bg(crate::kit::white()));
    }
    box_
}

/// (peripheral index, register array index)
type Key = (usize, usize);

pub struct SvdPicker {
    device: Rc<SvdDevice>,
    file_name: String,
    picked: HashMap<Key, IndexSet>,
    expanded: HashSet<usize>,
    open_arrays: HashSet<Key>,
    search: Entity<InputState>,
    positions: HashMap<Key, Entity<InputState>>,
    workspace: WeakEntity<WorkspaceView>,
    _subscriptions: Vec<Subscription>,
}

impl SvdPicker {
    fn keys(&self) -> Vec<Key> {
        self.device.peripherals.iter().enumerate().flat_map(|(p, peripheral)| (0..peripheral.registers.len()).map(move |a| (p, a))).collect()
    }

    fn array(&self, key: Key) -> &bitviewer_core::svd::SvdRegisterArray {
        &self.device.peripherals[key.0].registers[key.1]
    }

    fn picked_in(&self, keys: &[Key]) -> usize {
        keys.iter().map(|key| self.picked[key].size()).sum()
    }

    fn count_in(&self, keys: &[Key]) -> usize {
        keys.iter().map(|key| self.array(*key).count).sum()
    }

    fn query(&self, cx: &App) -> String {
        self.search.read(cx).value().trim().to_lowercase()
    }

    /// The peripherals the filter lets through, with their registers that do
    /// (all of them when the peripheral itself matches).
    fn filtered(&self, cx: &App) -> Vec<(usize, bool, Vec<Key>)> {
        let query = self.query(cx);
        let hit = |texts: &[&str]| texts.iter().any(|text| text.to_lowercase().contains(&query));
        self.device
            .peripherals
            .iter()
            .enumerate()
            .filter_map(|(p, peripheral)| {
                let peripheral_hit = query.is_empty() || hit(&[&peripheral.name, &peripheral.group_name, &peripheral.description]);
                let registers: Vec<Key> = (0..peripheral.registers.len())
                    .filter(|a| peripheral_hit || hit(&[&peripheral.registers[*a].label, &peripheral.registers[*a].description]))
                    .map(|a| (p, a))
                    .collect();
                (peripheral_hit || !registers.is_empty()).then_some((p, peripheral_hit, registers))
            })
            .collect()
    }

    fn in_scope(&self, cx: &App) -> Vec<Key> {
        self.filtered(cx).into_iter().flat_map(|(_, _, keys)| keys).collect()
    }

    fn all_picked(&self, keys: &[Key]) -> bool {
        !keys.is_empty() && self.picked_in(keys) == self.count_in(keys)
    }

    /// The text field for an array's positions, made on first use.
    fn positions_input(&mut self, key: Key, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        if let Some(input) = self.positions.get(&key) {
            return input.clone();
        }
        let text = self.picked[&key].to_string();
        let input = cx.new(|cx| InputState::new(window, cx).default_value(text).placeholder("none"));
        let count = self.array(key).count;
        let subscription = cx.subscribe_in(&input, window, move |this: &mut SvdPicker, input, event: &InputEvent, _, cx| match event {
            InputEvent::Change => cx.notify(),
            InputEvent::PressEnter { .. } | InputEvent::Blur => {
                if let Ok(set) = IndexSet::parse(&input.read(cx).value(), count) {
                    this.picked.insert(key, set);
                    cx.notify();
                }
            }
            _ => {}
        });
        self._subscriptions.push(subscription);
        self.positions.insert(key, input.clone());
        input
    }

    /// Shows the picked positions in an array's field (unless it is being typed in).
    fn sync_positions(&mut self, key: Key, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(input) = self.positions.get(&key).cloned() {
            let text = self.picked[&key].to_string();
            if !input.read(cx).focus_handle(cx).is_focused(window) && input.read(cx).value() != text {
                input.update(cx, |input, cx| input.set_value(text, window, cx));
            }
        }
    }

    fn finish(&mut self, adding: bool, window: &mut Window, cx: &mut Context<Self>) {
        let keys = self.keys();
        let count = self.picked_in(&keys);
        if count == 0 {
            return;
        }
        window.close_dialog(cx);
        let device = self.device.clone();
        let picks: Vec<(Key, IndexSet)> = keys.iter().filter(|key| self.picked[key].size() > 0).map(|key| (*key, self.picked[key].clone())).collect();
        let workspace = self.workspace.clone();
        let run = move |window: &mut Window, cx: &mut App| {
            let arrays: Vec<(&bitviewer_core::svd::SvdRegisterArray, &IndexSet)> =
                picks.iter().map(|(key, set)| (&device.peripherals[key.0].registers[key.1], set)).collect();
            let registers = picked_registers(&arrays);
            if adding {
                workspace.update(cx, |workspace, cx| workspace.add_svd_values(&registers, &device, window, cx)).ok();
            } else {
                save_as_templates(&registers, &device, window, cx);
            }
        };
        // ask before the copies are made: a big array can be millions of registers
        if count > MANY {
            let shown = plural(count, "", "").trim().to_string();
            let message = if adding {
                format!(
                    "This adds {shown} values to the workspace. Large workspaces get slower to scroll and edit{}.",
                    if count > 100_000 { ", and this many may take a long time or run out of memory" } else { "" }
                )
            } else {
                format!("This saves {shown} templates. Every template is kept in your settings and listed in the templates menu.")
            };
            let label = if adding { format!("Add {shown} values") } else { format!("Save {shown} templates") };
            modal::confirm(window, cx, if adding { "Add many values?" } else { "Save many templates?" }, message, label, false, run);
        } else {
            run(window, cx);
        }
    }
}

/// Adds the registers to the user's templates, replacing ones with the same name.
fn save_as_templates(registers: &[SvdRegister], device: &SvdDevice, window: &mut Window, cx: &mut App) {
    let templates: Vec<_> = registers.iter().map(|register| register_template(register, &device.name)).collect();
    let names: HashSet<String> = templates.iter().map(|template| template.name.to_lowercase()).collect();
    let mut replaced = 0;
    app_state::update(cx, |settings| {
        let before = settings.templates.len();
        settings.templates.retain(|saved| saved.get("name").and_then(|n| n.as_str()).is_none_or(|n| !names.contains(&n.to_lowercase())));
        replaced = before - settings.templates.len();
        settings.templates.extend(templates.iter().map(template_to_json));
    });
    let count = templates.len();
    let replaced = if replaced > 0 { format!(" ({replaced} replaced)") } else { String::new() };
    window.push_notification(Notification::success(format!("Saved {count} template{}{replaced}", if count == 1 { "" } else { "s" })), cx);
}

/// Whether a dropped file is an SVD rather than a workspace.
pub fn is_svd(path: &Path) -> bool {
    if path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("svd")) {
        return true;
    }
    let mut start = [0u8; 2048];
    let read = std::fs::File::open(path).and_then(|mut file| std::io::Read::read(&mut file, &mut start)).unwrap_or(0);
    bitviewer_core::svd::looks_like_svd("", &String::from_utf8_lossy(&start[..read]))
}

pub fn open_picker(device: SvdDevice, file_name: String, workspace: WeakEntity<WorkspaceView>, window: &mut Window, cx: &mut App) {
    let title = format!("Import from {}", device.name);
    let device = Rc::new(device);
    let picker = cx.new(|cx| {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Filter peripherals and registers by name or description…"));
        search.update(cx, |search, cx| search.focus(window, cx));
        let subscription = cx.subscribe(&search, |_, _, _: &InputEvent, cx| cx.notify());
        let mut picked = HashMap::new();
        for (p, peripheral) in device.peripherals.iter().enumerate() {
            for (a, array) in peripheral.registers.iter().enumerate() {
                picked.insert((p, a), IndexSet::all(array.count));
            }
        }
        SvdPicker {
            device: device.clone(),
            file_name,
            picked,
            expanded: HashSet::new(),
            open_arrays: HashSet::new(),
            search,
            positions: HashMap::new(),
            workspace,
            _subscriptions: vec![subscription],
        }
    });
    window.open_dialog(cx, move |dialog, _, cx| {
        let keys = picker.read(cx).keys();
        let chosen = picker.read(cx).picked_in(&keys);
        let (templates, add) = (picker.clone(), picker.clone());
        let changed = picker.clone();
        let dialog = modal::guard(dialog, move |cx| {
            let picker = changed.read(cx);
            picker.picked_in(&picker.keys()) > 0
        });
        modal::frame(dialog, "cpu", title.clone(), true).w(px(1040.0)).child(picker.clone()).footer(
            modal::footer()
                .child(Btn::new("svd-cancel", Look::Ghost).label("Cancel").on_click(|_, window, cx| window.close_dialog(cx)))
                .child(
                    Btn::new("svd-templates", Look::Outline)
                        .label("Save as templates")
                        .tip("Keep the field layouts in your templates, to apply to any value later")
                        .disabled(chosen == 0)
                        .on_click(move |_, window, cx| templates.update(cx, |picker, cx| picker.finish(false, window, cx))),
                )
                .child(
                    Btn::new("svd-add", Look::Primary)
                        .test_label("svd-add")
                        .label(if chosen > 1 { format!("Add {} values", plural(chosen, "", "").trim()) } else { "Add value".into() })
                        .disabled(chosen == 0)
                        .on_click(move |_, window, cx| add.update(cx, |picker, cx| picker.finish(true, window, cx))),
                ),
        )
    });
}

impl Render for SvdPicker {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let keys = self.keys();
        let chosen = self.picked_in(&keys);
        let register_count = self.count_in(&keys);
        let query = self.query(cx);
        let filtered = self.filtered(cx);
        let scope = self.in_scope(cx);
        let all = self.all_picked(&scope);

        let row = |indent: f32| {
            div()
                .flex()
                .items_center()
                .gap(r(8.0))
                .py(r(6.0))
                .pr(r(10.0))
                .pl(r(indent))
                .min_w_0()
                .border_b_1()
                .border_color(palette.border)
                .cursor_pointer()
                .hover(move |style| style.bg(palette.surface_3))
        };
        let mono_small = |text: String| div().flex_none().font_family(theme::mono()).text_size(r(12.0)).text_color(palette.muted).child(text);
        let description = |text: String| {
            div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_ellipsis().text_size(r(12.0)).text_color(palette.muted).child(text)
        };

        let mut list = div()
            .id("svd-list")
            .flex()
            .flex_col()
            .max_h(window.viewport_size().height * 0.52)
            .overflow_y_scroll()
            .border_1()
            .border_color(palette.border)
            .rounded(r(10.0))
            .bg(palette.surface_2);
        let mut rows = 0;
        let (mut hidden_registers, mut hidden_copies) = (0, 0);
        for (p, peripheral_hit, registers) in filtered {
            let peripheral = self.device.peripherals[p].clone();
            let all_keys: Vec<Key> = (0..peripheral.registers.len()).map(|a| (p, a)).collect();
            let open = self.expanded.contains(&p) || (!query.is_empty() && !peripheral_hit);
            let total = self.count_in(&all_keys);
            let picked = self.picked_in(&all_keys);
            let count_text = format!(
                "{}{} · {}",
                hex_address(&peripheral.base_address),
                if peripheral.count > 1 { format!(" · ×{}", plural(peripheral.count, "", "").trim()) } else { String::new() },
                plural(total, "register", "registers")
            );
            let summary = [peripheral.group_name.clone(), peripheral.description.clone()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
            let box_keys = all_keys.clone();
            list = list.child(
                row(10.0)
                    .id(("svd-p", p))
                    .bg(palette.surface_2)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.expanded.insert(p) {
                            this.expanded.remove(&p);
                        }
                        cx.notify();
                    }))
                    .child(icon(if open { "chevron-down" } else { "chevron-right" }, 15.0).text_color(palette.muted))
                    .child(div().id(("svd-pbox", p)).child(check(picked, total)).on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        let on = this.picked_in(&box_keys) != this.count_in(&box_keys) || this.picked_in(&box_keys) == 0;
                        for key in &box_keys {
                            this.picked.get_mut(key).unwrap().fill(on);
                        }
                        cx.notify();
                    })))
                    .child(div().flex_none().font_family(theme::mono()).font_weight(FontWeight::BOLD).child(peripheral.name.clone()))
                    .child(mono_small(count_text))
                    .child(description(summary)),
            );
            if !open {
                continue;
            }
            for key in registers {
                if rows >= MAX_ROWS {
                    hidden_registers += 1;
                    continue;
                }
                self.sync_positions(key, window, cx);
                let array = self.array(key).clone();
                let set = self.picked[&key].clone();
                let fields = plural(array.fields.len(), "field", "fields");
                let warn = if array.warnings.is_empty() { "" } else { " ⚠" };
                let details = format!("{}-bit · {fields}{warn}", array.size);
                let tip: Option<SharedString> = (!array.warnings.is_empty()).then(|| format!("Left out:\n{}", array.warnings.join("\n")).into());
                let first_address = hex_address(&array.at(0).address);
                let toggle_all = cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    let set = this.picked.get_mut(&key).unwrap();
                    let on = set.size() != set.limit || set.size() == 0;
                    set.fill(on);
                    cx.notify();
                });
                let mut line = if array.count == 1 {
                    row(38.0)
                        .id(("svd-r", key.0 * 100_000 + key.1))
                        .bg(palette.surface)
                        .on_click(toggle_all)
                        .child(check(set.size(), 1))
                        .child(div().flex_none().font_family(theme::mono()).font_weight(FontWeight::BOLD).child(array.label.clone()))
                        .child(mono_small(format!("{first_address} · {details}")))
                        .child(description(array.description.clone()))
                } else {
                    let open_array = self.open_arrays.contains(&key);
                    let input = self.positions_input(key, window, cx);
                    let invalid = IndexSet::parse(&input.read(cx).value(), array.count).is_err();
                    let copies = plural(array.count, "copy", "copies");
                    row(15.0)
                        .id(("svd-r", key.0 * 100_000 + key.1))
                        .bg(palette.surface)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !this.open_arrays.insert(key) {
                                this.open_arrays.remove(&key);
                            }
                            cx.notify();
                        }))
                        .child(icon(if open_array { "chevron-down" } else { "chevron-right" }, 15.0).text_color(palette.muted))
                        .child(div().id(("svd-abox", key.0 * 100_000 + key.1)).child(check(set.size(), array.count)).on_click(toggle_all))
                        .child(div().flex_none().font_family(theme::mono()).font_weight(FontWeight::BOLD).child(array.label.clone()))
                        .child(mono_small(format!("{first_address} · {copies} · {details}")))
                        .child(
                            div()
                                .id(("svd-pos", key.0 * 100_000 + key.1))
                                .w(r(150.0))
                                .flex_none()
                                .on_click(|_, _, cx| cx.stop_propagation())
                                .child(field_box(&input, invalid, 26.0, true).text_size(r(12.0))),
                        )
                        .child(description(array.description.clone()))
                };
                if let Some(tip) = tip {
                    line = line.tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx));
                }
                list = list.child(line);
                rows += 1;
                if array.count == 1 || !self.open_arrays.contains(&key) {
                    continue;
                }
                let shown = array.count.min(MAX_ROWS.saturating_sub(rows));
                for position in 0..shown {
                    let register = array.at(position);
                    let name = if peripheral.count > 1 { register.path.clone() } else { register.path[register.peripheral.len() + 1..].to_string() };
                    let on = set.has(position);
                    list = list.child(
                        row(61.0)
                            .id(SharedString::from(format!("svd-c-{p}-{}-{position}", key.1)))
                            .bg(palette.surface)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.picked.get_mut(&key).unwrap().set(position, !on);
                                cx.notify();
                            }))
                            .child(check(usize::from(on), 1))
                            .child(div().flex_none().font_family(theme::mono()).font_weight(FontWeight::BOLD).child(name))
                            .child(mono_small(format!("#{position} · {}", hex_address(&register.address)))),
                    );
                }
                rows += shown;
                hidden_copies += array.count - shown;
            }
        }
        let note = |text: String| div().px(r(12.0)).py(r(10.0)).text_size(r(12.0)).text_color(palette.muted).child(text);
        if hidden_registers > 0 {
            list = list.child(note(format!("{} more registers aren't shown; type in the filter to narrow the list.", plural(hidden_registers, "", "").trim())));
        }
        if hidden_copies > 0 {
            list = list.child(note(format!(
                "{} aren't listed; type their positions in the array's box, e.g. 0-99.",
                plural(hidden_copies, "more copy", "more copies")
            )));
        }
        if self.device.peripherals.is_empty() || (rows == 0 && !query.is_empty() && self.filtered(cx).is_empty()) {
            list = list.child(note("Nothing matches the filter.".into()));
        }

        let count = if chosen > 0 {
            format!("{} selected", plural(chosen, "register", "registers"))
        } else {
            format!("{} peripherals · {}", self.device.peripherals.len(), plural(register_count, "register", "registers"))
        };
        let intro = format!(
            "{}{}. Tick registers to add them as values (named after the register, set to its reset value, with its fields), or save their layouts as templates. Open an array to tick single copies, or type which ones in its box.",
            self.file_name,
            if self.device.description.is_empty() { String::new() } else { format!(" — {}", self.device.description) }
        );
        let problems = self.device.warnings.len();
        let all_label = format!("{} all{}", if all { "Unselect" } else { "Select" }, if query.is_empty() { "" } else { " matching" });
        div()
            .flex()
            .flex_col()
            .child(div().text_size(r(12.0)).text_color(palette.muted).child(intro))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(r(12.0))
                    .mt(r(4.0))
                    .mb(r(8.0))
                    .child(div().flex_1().child(field_box(&self.search, false, 34.0, false)))
                    .child(
                        Btn::new("svd-all", Look::Outline)
                            .label(all_label)
                            .tip("Select or unselect every register the filter shows")
                            .disabled(scope.is_empty())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let scope = this.in_scope(cx);
                                let on = !this.all_picked(&scope);
                                for key in scope {
                                    this.picked.get_mut(&key).unwrap().fill(on);
                                }
                                cx.notify();
                            })),
                    )
                    .child(div().whitespace_nowrap().text_size(r(12.0)).text_color(palette.muted).child(count)),
            )
            .child(list)
            .when(problems > 0, |body| {
                let warnings: SharedString = self.device.warnings.join("\n").into();
                body.child(
                    div()
                        .id("svd-problems")
                        .mt(r(8.0))
                        .text_size(r(12.0))
                        .text_color(palette.select)
                        .tooltip(move |window, cx| Tooltip::new(warnings.clone()).build(window, cx))
                        .child(format!("{} in the file (hover for details).", plural(problems, "problem", "problems"))),
                )
            })
    }
}

use crate::kit::prelude::FluentBuilder as _;
