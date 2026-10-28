//! The card's ⋯ menu and what it does: snapshots, moving, width, operations
//! that take an operand, copying, pasting bytes and comparing.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::kit::component::Icon;
use crate::kit::component::WindowExt;
use crate::kit::component::menu::PopupMenuItem;
use crate::kit::component::notification::Notification;
use crate::kit::*;
use bitviewer_core::integers::{Base, Bits, format_int};
use bitviewer_core::interpretations::{ByteOrder, ByteStyle, format_bytes, value_to_bytes};

use super::CardView;
use super::render::entry;
use crate::prompt;
use crate::widgets::{Btn, Look};

/// When a snapshot was taken, as a short local date and time.
fn snapshot_time(at: f64) -> String {
    use chrono::TimeZone;
    if at <= 0.0 {
        return "Snapshot".into();
    }
    match chrono::Local.timestamp_millis_opt(at as i64).single() {
        Some(when) => when.format("%d/%m/%Y, %H:%M").to_string(),
        None => "Snapshot".into(),
    }
}

fn now_millis() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as f64).unwrap_or(0.0)
}

impl CardView {
    /// The card's ⋯ menu, in the web app's order.
    pub(super) fn menu_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let card = cx.entity().downgrade();
        let value = self.value.clone();
        let expr_open = self.expr_open;
        let workspace = self.workspace.clone();
        Btn::new(("card-menu", self.id.0 as usize), Look::Ghost).icon("ellipsis").tip("More").test_label(self.label("menu")()).menu(
            Anchor::TopRight,
            move |menu, window, cx| {
                let ico = |name: &str| Icon::empty().path(format!("icons/{name}.svg"));
                let collapsed = value.collapsed;
                let snapshot_card = card.clone();
                let snapshots: Vec<(usize, String, Bits, f64)> =
                    value.snapshots.iter().enumerate().rev().map(|(index, snapshot)| (index, snapshot.name.to_string(), snapshot.value, snapshot.at)).collect();
                let width = value.width;
                let bytes_card = card.clone();
                menu.item(entry(
                    &card,
                    if collapsed { "Expand" } else { "Collapse" },
                    Some(if collapsed { "chevron-right" } else { "chevron-down" }),
                    |c, w, cx| c.toggle_collapsed(w, cx),
                ))
                .submenu_with_icon(Some(ico("camera")), "Snapshots", window, cx, move |mut menu, window, cx| {
                    let card = &snapshot_card;
                    menu = menu.item(entry(card, "Take snapshot…", Some("camera"), |c, w, cx| c.take_snapshot_prompt(w, cx)));
                    if !snapshots.is_empty() {
                        menu = menu.separator();
                    }
                    for (index, name, bits, at) in snapshots.clone() {
                        let card = card.clone();
                        let label = format!("{name}  ·  {}", format_int(bits, Base::Hex, width, true, true));
                        menu = menu.submenu_with_icon(Some(ico("rotate-ccw-clock")), label, window, cx, move |menu, _, _| {
                            let restored = name.clone();
                            menu.item(PopupMenuItem::new(snapshot_time(at)).disabled(true))
                                .separator()
                                .item(entry(&card, "Restore this value", Some("undo-2"), move |c, w, cx| {
                                    c.set_value_guarded(bits, None, None, w, cx);
                                    w.push_notification(Notification::success(format!("Restored “{restored}”")), cx);
                                }))
                                .item(entry(&card, "Compare with current", Some("git-compare-arrows"), move |c, w, cx| {
                                    c.commit(None, w, cx, move |v| Ok(v.compare_with(bits)))
                                }))
                                .separator()
                                .item(entry(&card, "Delete snapshot", Some("trash"), move |c, w, cx| {
                                    c.commit(None, w, cx, move |v| Ok(v.remove_snapshot(index)))
                                }))
                        });
                    }
                    menu
                })
                .submenu_with_icon(Some(ico("cpu")), "Peripheral", window, cx, {
                    let card = card.clone();
                    let block = value.block.clone();
                    let workspace = workspace.clone();
                    move |mut menu, window, cx| {
                        // the other peripherals this value could join (looked up when the menu opens)
                        let others: Vec<(Arc<str>, Option<u64>)> = workspace
                            .upgrade()
                            .map(|workspace| {
                                workspace
                                    .read(cx)
                                    .state()
                                    .used_peripherals()
                                    .iter()
                                    .filter(|peripheral| peripheral.name != block)
                                    .map(|peripheral| (peripheral.name.clone(), peripheral.base))
                                    .collect()
                            })
                            .unwrap_or_default();
                        menu = menu.item(entry(&card, "New peripheral from this value…", None, |c, w, cx| {
                            c.workspace_do_in(w, cx, |ws, id, w, cx| ws.create_peripheral(id, w, cx))
                        }));
                        if !others.is_empty() {
                            let card = card.clone();
                            let others = others.clone();
                            let label = if block.is_empty() { "Add to peripheral" } else { "Move to another peripheral" };
                            menu = menu.submenu(label, window, cx, move |mut menu, _, _| {
                                for (name, base) in &others {
                                    let target = name.clone();
                                    let label = match base {
                                        Some(base) => format!("{name}   0x{base:X}"),
                                        None => name.to_string(),
                                    };
                                    menu = menu.item(entry(&card, label, None, move |c, w, cx| {
                                        let target = target.clone();
                                        c.workspace_do_in(w, cx, move |ws, id, w, cx| ws.move_to_peripheral(id, &target, w, cx))
                                    }));
                                }
                                menu
                            });
                        }
                        if !block.is_empty() {
                            menu = menu
                                .separator()
                                .item(entry(&card, "Change offset…", None, |c, w, cx| c.workspace_do_in(w, cx, |ws, id, w, cx| ws.edit_offset(id, w, cx))))
                                .item(entry(&card, format!("Take out of {block}"), None, |c, _, cx| {
                                    c.workspace_do(cx, |ws, id, cx| ws.take_out_of_peripheral(id, cx))
                                }));
                        }
                        menu
                    }
                })
                .item(entry(&card, if value.description.is_empty() { "Add description…" } else { "Edit description…" }, Some("pencil-line"), |c, w, cx| {
                    c.description_prompt(w, cx)
                }))
                .separator()
                .item(entry(&card, "Move up", Some("arrow-up"), |c, _, cx| c.workspace_do(cx, |ws, id, cx| ws.move_value(id, -1, cx))))
                .item(entry(&card, "Move down", Some("arrow-down"), |c, _, cx| c.workspace_do(cx, |ws, id, cx| ws.move_value(id, 1, cx))))
                .item(entry(&card, "Duplicate", Some("copy-plus"), |c, _, cx| c.workspace_do(cx, |ws, id, cx| ws.duplicate_value(id, cx))))
                .item(entry(&card, "Change width…", Some("ruler"), |c, w, cx| c.width_prompt(w, cx)))
                .item(entry(&card, "Preview a write…", Some("pencil-line"), |c, w, cx| c.write_prompt(w, cx)))
                .separator()
                .item(entry(&card, if value.show_bases { "Hide all bases" } else { "Show all bases" }, Some("binary"), |c, w, cx| c.toggle_bases(w, cx)))
                .item(entry(&card, if expr_open { "Hide expression bar" } else { "Expression bar" }, Some("square-function"), |c, w, cx| c.toggle_expr(w, cx)))
                .separator()
                .item(entry(&card, "Apply template…", Some("layout-template"), |c, w, cx| c.apply_template_prompt(w, cx)))
                .item(
                    entry(&card, "Save fields as template…", Some("bookmark-plus"), |c, w, cx| c.save_template_prompt(w, cx)).disabled(value.fields.is_empty()),
                )
                .item(entry(&card, "Export code…", Some("file-code-corner"), |c, w, cx| {
                    c.workspace_do_in(w, cx, |ws, id, w, cx| {
                        ws.export_value(id, w, cx);
                    })
                }))
                .separator()
                .item(entry(&card, "Paste bytes…", Some("clipboard-paste"), |c, w, cx| c.paste_bytes_prompt(w, cx)))
                .submenu_with_icon(Some(ico("copy")), "Copy as bytes", window, cx, move |mut menu, _, _| {
                    for (label, style, order) in [
                        ("Hex bytes, big-endian", ByteStyle::Hex, ByteOrder::Big),
                        ("Hex bytes, little-endian", ByteStyle::Hex, ByteOrder::Little),
                        ("C array, big-endian", ByteStyle::C, ByteOrder::Big),
                        ("C array, little-endian", ByteStyle::C, ByteOrder::Little),
                        ("Python bytes, big-endian", ByteStyle::Python, ByteOrder::Big),
                        ("Python bytes, little-endian", ByteStyle::Python, ByteOrder::Little),
                    ] {
                        if style != ByteStyle::Hex && order == ByteOrder::Big {
                            menu = menu.separator();
                        }
                        menu = menu.item(entry(&bytes_card, label, None, move |c, w, cx| c.copy_bytes(style, order, w, cx)));
                    }
                    menu
                })
                .item(entry(&card, "Compare with…", Some("git-compare-arrows"), |c, w, cx| c.compare_prompt(w, cx)))
                .separator()
                .item(entry(&card, "Remove value", Some("trash"), |c, _, cx| c.workspace_do(cx, |ws, id, cx| ws.remove_value(id, cx))))
            },
        )
    }

    /// Asks for the value's description (shown when pointing at its name).
    pub(crate) fn description_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let card = cx.entity().downgrade();
        let name = if self.value.name.is_empty() { "this value".to_string() } else { self.value.name.to_string() };
        prompt::ask(
            window,
            cx,
            "Description",
            format!("What “{name}” is for (shown when you point at its name)"),
            self.value.description.to_string(),
            move |text, window, cx| {
                let text = text.trim().to_string();
                card.update(cx, |card, cx| card.commit(None, window, cx, move |v| Ok(v.set_description(&text)))).ok();
                Ok(None)
            },
        );
    }

    pub(crate) fn take_snapshot_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let card = cx.entity().downgrade();
        let suggested = format!("Snapshot {}", self.value.snapshots.len() + 1);
        prompt::ask_with("camera", window, cx, "Take snapshot", "A name for the value as it is now", suggested, move |text, window, cx| {
            let name = text.to_string();
            card.update(cx, |card, cx| {
                card.commit(None, window, cx, move |value| {
                    value.take_snapshot(&name, now_millis());
                    Ok(true)
                })
            })
            .ok();
            Ok(None)
        });
    }

    /// Asks for a new width. Named fields that don't fit are never dropped:
    /// the user removes them first. Losing bits or compare rows asks first.
    pub(crate) fn width_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let card = cx.entity().downgrade();
        let title = format!("Change width of “{}”", self.value.name);
        crate::value_dialogs::pick_width(window, cx, title, self.value.width, "Change width", move |width, window, cx| {
            let Some(view) = card.upgrade() else { return };
            let value = view.read(cx).value.clone();
            if width == value.width {
                return;
            }
            let (fields, compares) = value.lost_on_resize(width);
            if !fields.is_empty() {
                let names: Vec<String> = fields.iter().map(|field| format!("“{}” {}", field.name, field.label())).collect();
                let several = fields.len() > 1;
                let message = format!(
                    "{} {} fit in {width} bits. Remove {} first, or use at least {} bits.",
                    names.join(", "),
                    if several { "don't" } else { "doesn't" },
                    if several { "those fields" } else { "that field" },
                    value.min_width_for_fields()
                );
                crate::value_dialogs::tell(window, cx, "Fields don't fit", message);
                return;
            }
            let card = card.clone();
            let apply = move |window: &mut Window, cx: &mut App| {
                card.update(cx, |card, cx| {
                    card.selection = None;
                    card.commit(None, window, cx, move |v| v.set_width(width));
                })
                .ok();
            };
            if compares > 0 || width < value.width {
                let mut parts = vec![format!("bits above {} are cleared", width - 1)];
                if compares > 0 {
                    parts.push(format!("{compares} compare row{} no longer fit and will be removed", if compares > 1 { "s" } else { "" }));
                }
                let message = format!("Shrinking to {width} bits: {}.", parts.join(", and "));
                crate::modal::confirm(window, cx, "Change width", message, "Change width".into(), true, apply);
            } else {
                apply(window, cx);
            }
        });
    }

    pub(crate) fn copy_as(&mut self, base: Base, window: &mut Window, cx: &mut Context<Self>) {
        let text = format_int(self.value.value, base, self.value.width, true, false);
        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
        crate::sound::play(crate::sound::Sound::Copy, cx);
        window.push_notification(Notification::success(format!("Copied {text}")), cx);
    }

    fn copy_bytes(&mut self, style: ByteStyle, order: ByteOrder, window: &mut Window, cx: &mut Context<Self>) {
        let bytes = value_to_bytes(self.value.value, self.value.width, order);
        let text = format_bytes(&bytes, style);
        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
        crate::sound::play(crate::sound::Sound::Copy, cx);
        window.push_notification(Notification::success(format!("Copied {text}")), cx);
    }
}

impl CardView {
    /// Applies a template the user picks (asking before widening the value
    /// or replacing its fields); one undo step.
    pub(crate) fn apply_template_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let card = cx.entity().downgrade();
        let title = format!("Apply a template to “{}”", if self.value.name.is_empty() { "value" } else { &self.value.name });
        crate::templates_dialog::pick(window, cx, title, "Apply", move |template, window, cx| {
            let Some(view) = card.upgrade() else { return };
            let value = view.read(cx).value.clone();
            let template = std::rc::Rc::new(template);
            let apply = {
                let card = card.clone();
                let template = template.clone();
                move |window: &mut Window, cx: &mut App| {
                    let template = template.clone();
                    card.update(cx, |card, cx| {
                        card.commit(None, window, cx, move |v| {
                            if template.width > v.width {
                                v.set_width(template.width)?;
                            }
                            v.apply_template(&template)?;
                            Ok(true)
                        })
                    })
                    .ok();
                }
            };
            let apply = std::rc::Rc::new(apply);
            let replace = {
                let apply = apply.clone();
                let template = template.clone();
                let value = value.clone();
                move |window: &mut Window, cx: &mut App| {
                    if value.fields.is_empty() {
                        apply(window, cx);
                        return;
                    }
                    // replacing named fields is only ever done with the user's go-ahead
                    let names: Vec<&str> = value.fields.iter().map(|field| &*field.name).collect();
                    let message = format!(
                        "This removes the current field{} ({}) and applies “{}”. You can undo this with Ctrl+Z.",
                        if names.len() > 1 { "s" } else { "" },
                        names.join(", "),
                        template.name
                    );
                    let apply = apply.clone();
                    crate::modal::confirm(window, cx, "Replace fields?", message, "Replace fields".into(), true, move |w, cx| apply(w, cx));
                }
            };
            if template.width > value.width {
                let message =
                    format!("“{}” is {} bits wide; this value has {}. Widen the value to {} bits?", template.name, template.width, value.width, template.width);
                let label = format!("Widen to {} bits", template.width);
                crate::modal::confirm(window, cx, "Template is wider", message, label, false, move |w, cx| replace(w, cx));
            } else {
                replace(window, cx);
            }
        });
    }

    /// Saves the fields as one of the user's templates, asking before replacing one.
    pub(crate) fn save_template_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.value.fields.is_empty() {
            window.push_notification(Notification::error("Create some fields first"), cx);
            return;
        }
        let value = self.value.clone();
        let suggested = if value.name.is_empty() { "My register".to_string() } else { value.name.to_string() };
        prompt::ask_with("bookmark-plus", window, cx, "Save fields as template", "Template name", suggested, move |text, window, cx| {
            let name = text.trim().to_string();
            if name.is_empty() {
                return Err("Enter a name".into());
            }
            let template = bitviewer_core::templates::template_from_value(&value, &name);
            let existing = crate::templates_dialog::user_templates(cx).into_iter().find(|saved| saved.name.to_lowercase() == name.to_lowercase());
            match existing {
                Some(existing) => Ok(Some(Box::new(move |window: &mut Window, cx: &mut App| {
                    let message = format!("You already have a template called “{}”. Replace it with these fields?", existing.name);
                    let template = template.clone();
                    crate::modal::confirm(window, cx, "Replace template?", message, "Replace".into(), true, move |w, cx| {
                        crate::templates_dialog::save(&template, w, cx)
                    });
                }))),
                None => {
                    crate::templates_dialog::save(&template, window, cx);
                    Ok(None)
                }
            }
        });
    }
}

impl CardView {
    /// Asks for a field's new name.
    pub(crate) fn rename_field_prompt(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(field) = self.value.fields.get(index) else { return };
        let card = cx.entity().downgrade();
        prompt::ask(window, cx, "Rename field", "Field name", field.name.to_string(), move |text, window, cx| {
            let name = text.trim().to_string();
            if !name.is_empty() {
                card.update(cx, |card, cx| card.commit(None, window, cx, move |v| v.update_field(index, Some(&name), None, None))).ok();
            }
            Ok(None)
        });
    }
}

impl CardView {
    /// Group selection (Ctrl+G): names the selected bits as a new field,
    /// as the web app does: overlaps are explained, the name is asked for.
    pub(crate) fn open_group_dialog(&mut self, lo: usize, hi: usize, window: &mut Window, cx: &mut Context<Self>) {
        let clash: Vec<String> =
            bitviewer_core::field::overlapping(&self.value.fields, lo, hi).map(|(_, field)| format!("“{}” {}", field.name, field.label())).collect();
        if !clash.is_empty() {
            crate::sound::play(crate::sound::Sound::Error, cx);
            let message = format!("The selection [{hi}:{lo}] overlaps {}. Remove that field first or select a different range.", clash.join(", "));
            crate::value_dialogs::tell(window, cx, "Fields cannot overlap", message);
            return;
        }
        let suggestion = bitviewer_core::field::suggest_field_name(&self.value.fields);
        let card = cx.entity().downgrade();
        let hint = format!("Name for bits [{hi}:{lo}] ({} bits)", hi - lo + 1);
        let fallback = suggestion.clone();
        prompt::ask_with("tag", window, cx, "New register field", hint, suggestion, move |text, window, cx| {
            let name = if text.trim().is_empty() { fallback.clone() } else { text.trim().to_string() };
            card.update(cx, |card, cx| {
                card.commit(None, window, cx, move |v| v.add_field(lo, hi, Some(&name), None, None).map(|_| true));
                card.clear_selection(cx);
                crate::sound::play(crate::sound::Sound::Group, cx);
            })
            .ok();
            Ok(None)
        });
    }
}
