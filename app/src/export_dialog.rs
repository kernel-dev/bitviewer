//! "Export code…" (the web app's dialogs/export.ts and export-editor.ts):
//! source for a value's fields or a whole peripheral, from a template (built
//! in or the user's own), to copy or save; and the template editor.

use std::sync::Arc;

use crate::kit::component::WindowExt;
use crate::kit::component::input::{InputEvent, InputState, Textarea, TextareaState};
use crate::kit::component::notification::Notification;
use crate::kit::*;
use bitviewer_core::export::language::{TemplateError, compile_template};
use bitviewer_core::export::{
    ExportOptions, ExportTemplate, NEW_PERIPHERAL_TEMPLATE_SOURCE, NEW_TEMPLATE_SOURCE, builtin_exports, custom_export, default_prefix, ident, render_export,
    render_peripheral_export, uses_words,
};
use bitviewer_core::value::Value;
use bitviewer_core::workspace::Peripheral;
use serde_json::json;

use crate::app_state;
use crate::modal::{self, switch};
use crate::theme;
use crate::value_dialogs::field_box;
use crate::widgets::{Btn, Look, SegSize, r, seg_button, seg_track};

/// What is exported.
#[derive(Clone)]
pub enum Target {
    Register { value: Arc<Value>, peripheral: Option<Peripheral> },
    Peripheral { peripheral: Peripheral, values: Vec<Arc<Value>> },
}

impl Target {
    fn scope(&self) -> &'static str {
        match self {
            Target::Register { .. } => "register",
            Target::Peripheral { .. } => "peripheral",
        }
    }
}

/// The user's saved export templates, as (name, extension, source).
fn saved(cx: &App) -> Vec<(String, String, String)> {
    app_state::settings(cx)
        .export_templates
        .iter()
        .filter_map(|json| {
            Some((json.get("name")?.as_str()?.to_string(), json.get("extension")?.as_str()?.to_string(), json.get("source")?.as_str()?.to_string()))
        })
        .collect()
}

fn templates_for(scope: &str, cx: &App) -> Vec<ExportTemplate> {
    builtin_exports()
        .into_iter()
        .chain(saved(cx).iter().map(|(name, extension, source)| custom_export(name, extension, source)))
        .filter(|template| template.scope == scope)
        .collect()
}

fn has_word(source: &str, word: &str) -> bool {
    let word_char = |c: char| c.is_ascii_alphanumeric() || c == '_';
    source
        .match_indices(word)
        .any(|(at, _)| !source[..at].chars().next_back().is_some_and(word_char) && !source[at + word.len()..].chars().next().is_some_and(word_char))
}

pub struct ExportView {
    target: Target,
    current: String,
    prefix: Entity<InputState>,
    include_value: bool,
    accessors: bool,
    platform: usize,
    _subscription: Subscription,
}

impl ExportView {
    fn current(&self, cx: &App) -> ExportTemplate {
        let list = templates_for(self.target.scope(), cx);
        list.iter().find(|template| template.id == self.current).cloned().unwrap_or_else(|| list[0].clone())
    }

    /// Renders any template source for this target (the editor's preview too).
    fn render_source(&self, source: &str, cx: &App) -> Result<String, TemplateError> {
        let prefix = self.prefix.read(cx).value().to_string();
        match &self.target {
            Target::Register { value, peripheral } => {
                let options = ExportOptions {
                    prefix: if prefix.is_empty() { "REG".into() } else { prefix },
                    include_value: self.include_value,
                    accessors: self.accessors,
                    platform: self.platform,
                };
                render_export(source, value, &options, peripheral.as_ref())
            }
            Target::Peripheral { peripheral, values } => {
                let values: Vec<&Value> = values.iter().map(|value| &**value).collect();
                let prefix = if prefix.is_empty() { "PERIPH".to_string() } else { prefix };
                render_peripheral_export(source, peripheral, &values, &prefix, self.include_value)
            }
        }
    }

    fn output(&self, cx: &App) -> Result<String, String> {
        self.render_source(&self.current(cx).source, cx).map_err(|error| error.to_string())
    }

    fn copy(&self, window: &mut Window, cx: &mut App) {
        if let Ok(text) = self.output(cx) {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
            crate::sound::play(crate::sound::Sound::Copy, cx);
            window.push_notification(Notification::success("Code copied"), cx);
        }
    }

    fn save(&self, window: &mut Window, cx: &mut Context<Self>) {
        let Ok(text) = self.output(cx) else { return };
        let prefix = self.prefix.read(cx).value().to_lowercase();
        let name = format!("{}.{}", if prefix.is_empty() { "reg".into() } else { prefix }, self.current(cx).extension);
        let dir = std::path::PathBuf::from(&app_state::settings(cx).last_dir);
        let chosen = cx.prompt_for_new_path(&dir, Some(&name));
        cx.spawn_in(window, async move |_, cx| {
            let Ok(Ok(Some(path))) = chosen.await else { return };
            let result = std::fs::write(&path, text);
            cx.update(|window, cx| {
                let message = match result {
                    Ok(()) => Notification::success(format!("Saved {}", path.file_name().map_or(String::new(), |name| name.to_string_lossy().into_owned()))),
                    Err(error) => Notification::error(format!("Could not save: {error}")),
                };
                window.push_notification(message, cx);
            })
            .ok();
        })
        .detach();
    }

    /// Opens the template editor: a new template, or the current one (a
    /// copy when it is built in).
    pub(crate) fn edit(&mut self, fresh: bool, window: &mut Window, cx: &mut Context<Self>) {
        let current = self.current(cx);
        let scope = self.target.scope();
        let (title, source) = if fresh {
            ("New export template".to_string(), if scope == "peripheral" { NEW_PERIPHERAL_TEMPLATE_SOURCE } else { NEW_TEMPLATE_SOURCE }.to_string())
        } else if current.builtin {
            let source = current
                .source
                .lines()
                .map(|line| if line.starts_with("@name ") { format!("@name {} (custom)", current.name) } else { line.to_string() })
                .collect::<Vec<_>>()
                .join("\n");
            let source = if current.source.ends_with('\n') { source + "\n" } else { source };
            (format!("Customise a copy of “{}”", current.name), source)
        } else {
            (format!("Edit template “{}”", current.name), current.source.clone())
        };
        let editing = !fresh && !current.builtin;
        let taken: Vec<String> =
            saved(cx).into_iter().filter(|(name, _, _)| !editing || *name != current.name).map(|(name, _, _)| name.to_lowercase()).collect();
        let export = cx.entity().downgrade();
        let editor = cx.new(|cx| {
            let area = cx.new(|cx| TextareaState::new(window, cx).soft_wrap(false).default_value(source.clone()));
            let subscription = cx.subscribe(&area, |_, _, _: &InputEvent, cx| cx.notify());
            EditorView { area, original: source.clone(), export: export.clone(), scope, taken, _subscription: subscription }
        });
        let old_name = current.name.clone();
        let export_for_save = cx.entity().downgrade();
        window.open_dialog(cx, move |dialog, _, cx| {
            let ready = editor.read(cx).check(cx);
            let save_editor = editor.clone();
            let export = export_for_save.clone();
            let old_name = old_name.clone();
            let mut footer = modal::footer();
            if editing {
                let export = export.clone();
                let old_name = old_name.clone();
                footer = footer.child(Btn::new("tpl-delete", Look::Outline).label("Delete").on_click(move |_, window, cx| {
                    let name = old_name.clone();
                    app_state::update(cx, |settings| {
                        settings.export_templates.retain(|t| t.get("name").and_then(|n| n.as_str()) != Some(&name));
                    });
                    export.update(cx, |export, cx| export.select(None, cx)).ok();
                    window.close_dialog(cx);
                }));
            }
            let changed = editor.clone();
            let dialog = modal::guard(dialog, move |cx| {
                let editor = changed.read(cx);
                editor.area.read(cx).value() != editor.original
            });
            modal::frame(dialog, "pencil", title.clone(), true).w(px(1040.0)).child(editor.clone()).footer(
                footer.child(Btn::new("tpl-cancel", Look::Ghost).label("Cancel").on_click(|_, window, cx| window.close_dialog(cx))).child(
                    Btn::new("tpl-save", Look::Primary).label("Save").disabled(ready.is_err()).on_click(move |_, window, cx| {
                        let Ok((name, extension)) = save_editor.read(cx).check(cx) else { return };
                        let source = save_editor.read(cx).area.read(cx).value().to_string();
                        let old_name = old_name.clone();
                        let saved_name = name.clone();
                        app_state::update(cx, |settings| {
                            if editing {
                                settings.export_templates.retain(|t| t.get("name").and_then(|n| n.as_str()) != Some(&old_name));
                            }
                            settings.export_templates.push(json!({ "name": name, "extension": extension, "source": source }));
                        });
                        export.update(cx, |export, cx| export.select(Some(format!("custom:{}", saved_name.to_lowercase())), cx)).ok();
                        window.close_dialog(cx);
                        window.push_notification(Notification::success(format!("Saved template “{saved_name}”")), cx);
                    }),
                ),
            )
        });
    }

    /// Picks a template (None: the first one), remembered for next time.
    fn select(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        let list = templates_for(self.target.scope(), cx);
        self.current = id.filter(|id| list.iter().any(|t| t.id == *id)).unwrap_or_else(|| list[0].id.clone());
        let id = self.current.clone();
        app_state::update(cx, |settings| settings.export_last = id);
        cx.notify();
    }
}

impl Render for ExportView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let current = self.current(cx);
        let list = templates_for(self.target.scope(), cx);

        let mut seg = seg_track().flex_wrap();
        for template in &list {
            let id = template.id.clone();
            seg = seg.child(
                seg_button(SharedString::from(format!("tpl-{}", template.id)), template.name.clone(), template.id == current.id, SegSize::Normal)
                    .on_click(cx.listener(move |this, _, _, cx| this.select(Some(id.clone()), cx))),
            );
        }
        let picker = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(r(6.0))
            .mb(r(10.0))
            .child(seg)
            .child(
                Btn::new("tpl-new", Look::Ghost)
                    .small()
                    .icon("plus")
                    .tip("New template")
                    .on_click(cx.listener(|this, _, window, cx| this.edit(true, window, cx))),
            )
            .child(
                Btn::new("tpl-edit", Look::Ghost)
                    .small()
                    .icon("pencil")
                    .tip(if current.builtin { "Customise a copy of this template" } else { "Edit this template" })
                    .on_click(cx.listener(|this, _, window, cx| this.edit(false, window, cx))),
            );

        let option = |label: &'static str| div().flex().items_center().gap(r(8.0)).child(div().text_color(palette.muted).child(label));
        let mut options = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(r(14.0))
            .mb(r(12.0))
            .child(option("Name prefix").child(div().w(r(140.0)).child(field_box(&self.prefix, false, 28.0, true))));
        if uses_words(&current.source) {
            let mut widths = seg_track();
            for platform in [32, 64] {
                widths = widths.child(seg_button(("platform", platform), format!("{platform}-bit"), self.platform == platform, SegSize::Normal).on_click(
                    cx.listener(move |this, _, _, cx| {
                        this.platform = platform;
                        cx.notify();
                    }),
                ));
            }
            options = options.child(option("Register width").child(widths));
        }
        let me = cx.entity().downgrade();
        if has_word(&current.source, "include_value") {
            let me = me.clone();
            options = options.child(
                div()
                    .flex()
                    .items_center()
                    .gap(r(8.0))
                    .child(switch("include-value", self.include_value, move |on, _, cx| {
                        me.update(cx, |this, cx| {
                            this.include_value = on;
                            cx.notify();
                        })
                        .ok();
                    }))
                    .child(div().text_color(palette.muted).child("Current value")),
            );
        }
        if has_word(&current.source, "accessors") {
            options = options.child(
                div()
                    .flex()
                    .items_center()
                    .gap(r(8.0))
                    .child(switch("accessors", self.accessors, move |on, _, cx| {
                        me.update(cx, |this, cx| {
                            this.accessors = on;
                            cx.notify();
                        })
                        .ok();
                    }))
                    .child(div().text_color(palette.muted).child("Get / set helpers")),
            );
        }

        let no_fields = matches!(&self.target, Target::Register { value, .. } if value.fields.is_empty());
        let max_height = window.viewport_size().height * 0.48;
        let output = self.output(cx);
        div()
            .flex()
            .flex_col()
            .child(picker)
            .child(options)
            .child(div().mb(r(8.0)).text_size(r(12.0)).text_color(palette.muted).child(current.about.clone()))
            .when(no_fields, |body| {
                body.child(div().mb(r(8.0)).text_color(palette.select).child("This value has no fields yet, so only the value is exported."))
            })
            .child(match output {
                Ok(text) => code_preview("export-preview", text, max_height, false),
                Err(error) => div().id("export-error").mt(r(4.0)).mb(r(8.0)).text_color(palette.error).child(error),
            })
    }
}

/// A block of generated code (.code-preview).
fn code_preview(id: &'static str, text: String, max_height: Pixels, stale: bool) -> Stateful<Div> {
    let palette = theme::current();
    div()
        .id(id)
        .px(r(14.0))
        .py(r(12.0))
        .max_h(max_height)
        .overflow_scroll()
        .bg(palette.input)
        .border_1()
        .border_color(palette.border)
        .rounded(r(10.0))
        .font_family(theme::mono())
        .text_size(r(12.0))
        .line_height(r(12.0 * 1.55))
        .text_color(palette.text)
        .whitespace_nowrap()
        .when(stale, |preview| preview.opacity(0.45))
        .children(text.lines().map(|line| div().child(if line.is_empty() { " ".to_string() } else { line.to_string() })).collect::<Vec<_>>())
}

/// Opens "Export code…" for `target`.
/// Opens the dialog; the view, so a caller can open its template editor.
pub fn open(target: Target, window: &mut Window, cx: &mut App) -> Entity<ExportView> {
    let title = match &target {
        Target::Register { value, .. } => format!("Export code for “{}”", if value.name.is_empty() { "value" } else { &value.name }),
        Target::Peripheral { peripheral, .. } => format!("Export code for peripheral “{}”", peripheral.name),
    };
    let prefix = match &target {
        Target::Register { value, .. } => default_prefix(value),
        Target::Peripheral { peripheral, .. } => ident(&peripheral.name, "PERIPH"),
    };
    let last = app_state::settings(cx).export_last.clone();
    let view = cx.new(|cx| {
        let prefix = cx.new(|cx| InputState::new(window, cx).default_value(prefix));
        let subscription = cx.subscribe(&prefix, |_, _, _: &InputEvent, cx| cx.notify());
        let mut view = ExportView { target, current: String::new(), prefix, include_value: true, accessors: true, platform: 32, _subscription: subscription };
        let list = templates_for(view.target.scope(), cx);
        view.current = list.iter().find(|t| t.id == last).unwrap_or(&list[0]).id.clone();
        view
    });
    let shown = view.clone();
    window.open_dialog(cx, move |dialog, _, _| {
        let view = shown.clone();
        let (save, copy) = (view.clone(), view.clone());
        modal::frame(dialog, "file-code-corner", title.clone(), true).w(px(1040.0)).child(view.clone()).footer(
            modal::footer()
                .child(
                    Btn::new("export-save", Look::Outline)
                        .icon("download")
                        .label("Save as file…")
                        .on_click(move |_, window, cx| save.update(cx, |view, cx| view.save(window, cx))),
                )
                .child(
                    Btn::new("export-copy", Look::Primary)
                        .icon("copy")
                        .label("Copy")
                        .on_click(move |_, window, cx| copy.update(cx, |view, cx| view.copy(window, cx))),
                )
                .child(Btn::new("export-close", Look::Outline).label("Close").on_click(|_, window, cx| window.close_dialog(cx))),
        )
    });
    view
}

// ------------------------------------------------------------ the template editor
const CHEAT_COMMON: &str = "${expr}            print a value, e.g. ${field.id | upper}
@for field in fields     repeat up to @end   (@else = when empty)
@if field.signed         @elif / @else / @end
@set integer_suffix = \"ULL\"       remember a value
@name  @ext  @about  label, file extension, description
@scope peripheral    a template for a whole peripheral (default: register)
@# note              comment   (@@ prints a literal @)
";

const CHEAT_REGISTER: &str = "
top level: name prefix width value include_value accessors uint_bits
           platform fields words description
           has_address address has_offset offset block address_bits
a field:   id name lo hi width range value mask shifted_mask access
           write read signed formula unit description comment note named
a word:    name suffix title lo hi width storage value items";

const CHEAT_PERIPHERAL: &str = "
top level: name prefix description has_base base address_bits
           include_value registers layout unplaced size name_width
a register: id name description width bytes has_offset offset
           has_address address type array rust_type value fields
           (and everything a register template sees)
layout:    gap, member or overlap items in offset order; gaps have
           id bytes offset range, all have declaration";

const CHEAT_END: &str = "
numbers:   ${value} prints hex; ${value.hex} .bin .dec .oct
filters:   upper lower pad(n) padl(n) join(sep) reverse default(x)
           lead(text): text before the value, when there is one
           rust_ident (escapes Rust keywords: type → r#type)";

pub struct EditorView {
    area: Entity<TextareaState>,
    original: String,
    export: WeakEntity<ExportView>,
    scope: &'static str,
    /// Lower-case names of the user's other templates.
    taken: Vec<String>,
    _subscription: Subscription,
}

impl EditorView {
    /// The name and extension the template saves as, or why it can't be saved.
    fn check(&self, cx: &App) -> Result<(String, String), String> {
        let source = self.area.read(cx).value().to_string();
        let meta = compile_template(&source).map_err(|error| error.to_string())?.meta;
        let scope = meta.scope.clone().unwrap_or_else(|| "register".into());
        if scope != self.scope {
            return Err(if self.scope == "peripheral" {
                "This exports a peripheral: keep the line @scope peripheral".into()
            } else {
                "This exports one value: remove the @scope peripheral line, or edit it from a peripheral's Export code".into()
            });
        }
        self.preview(&source, cx)?;
        let name = meta.name.as_deref().unwrap_or("").trim().to_string();
        if name.is_empty() {
            return Err("Give it a name with a line such as: @name My template".into());
        }
        if builtin_exports().iter().any(|t| t.name.to_lowercase() == name.to_lowercase()) {
            return Err(format!("“{name}” is a built-in template; change its @name line to save your own"));
        }
        if self.taken.contains(&name.to_lowercase()) {
            return Err(format!("You already have a template called “{name}”; pick another @name"));
        }
        let extension = meta.extension.unwrap_or_else(|| "txt".into()).trim_start_matches('.').to_string();
        Ok((name, if extension.is_empty() { "txt".into() } else { extension }))
    }

    fn preview(&self, source: &str, cx: &App) -> Result<String, String> {
        let export = self.export.upgrade().ok_or("The export dialog is closed")?;
        export.read(cx).render_source(source, cx).map_err(|error| error.to_string())
    }
}

impl Render for EditorView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let source = self.area.read(cx).value().to_string();
        let checked = self.check(cx);
        let preview = self.preview(&source, cx);
        let cheat = format!("{CHEAT_COMMON}{}{CHEAT_END}", if self.scope == "peripheral" { CHEAT_PERIPHERAL } else { CHEAT_REGISTER });
        let height = window.viewport_size().height;
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .mb(r(8.0))
                    .px(r(12.0))
                    .py(r(10.0))
                    .bg(palette.input)
                    .border_1()
                    .border_color(palette.border)
                    .rounded(r(10.0))
                    .font_family(theme::mono())
                    .text_size(r(12.0))
                    .text_color(palette.muted)
                    .children(
                        cheat
                            .lines()
                            .map(|line| div().whitespace_nowrap().child(if line.is_empty() { " ".to_string() } else { line.to_string() }))
                            .collect::<Vec<_>>(),
                    ),
            )
            .child(
                div()
                    .h(r(240.0))
                    .px(r(12.0))
                    .py(r(10.0))
                    .bg(palette.input)
                    .border_1()
                    .border_color(palette.border_strong)
                    .rounded(r(8.0))
                    .font_family(theme::mono())
                    .text_size(r(12.5))
                    .child(Textarea::new(&self.area).appearance(false).h_full()),
            )
            .child(
                div()
                    .mt(r(6.0))
                    .text_size(r(12.0))
                    .text_color(palette.muted)
                    .children(checked.as_ref().ok().map(|(name, extension)| format!("Saves as “{name}”, files end in .{extension}"))),
            )
            .children(checked.as_ref().err().map(|error| div().mt(r(4.0)).mb(r(8.0)).text_color(palette.error).child(error.clone())))
            .child(div().mb(r(6.0)).text_size(r(12.0)).text_color(palette.muted).child(if self.scope == "peripheral" {
                "Preview for this peripheral:"
            } else {
                "Preview for this value:"
            }))
            .child(code_preview("editor-preview", preview.unwrap_or_default(), height * 0.3, checked.is_err()))
    }
}

use crate::kit::prelude::FluentBuilder as _;
