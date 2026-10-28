//! The open file: new workspace, open (also recent files), save, save as,
//! quit, and the "unsaved changes" question before throwing work away, as
//! in the web app's document.ts. Files are the same .bitview format.

use std::path::{Path, PathBuf};

use crate::kit::component::WindowExt;
use crate::kit::component::menu::{PopupMenu, PopupMenuItem};
use crate::kit::component::notification::Notification;
use crate::kit::*;
use bitviewer_core::integers::Bits;
use bitviewer_core::value::Value;
use bitviewer_core::workspace::{FILE_VERSION, WorkspaceState, parse_workspace_file, workspace_file_text};
use futures::channel::oneshot;

use super::WorkspaceView;
use crate::commands::{COMMANDS, MENUS, OpenRecent};
use crate::widgets::{Btn, Look};
use crate::{app_state, session};

/// The menu bar's menus, built from the command table (recent files current).
pub fn menus(cx: &App) -> Vec<Menu> {
    let recent = &app_state::settings(cx).recent_files;
    MENUS
        .iter()
        .map(|(name, entries)| Menu {
            name: (*name).into(),
            items: entries
                .iter()
                .map(|entry| match *entry {
                    "sep" => MenuItem::separator(),
                    "recent" => MenuItem::submenu(Menu {
                        name: "Open recent".into(),
                        items: recent
                            .iter()
                            .enumerate()
                            .map(|(index, path)| {
                                // the file's name, and its folder (shortened)
                                let path = std::path::Path::new(path);
                                let name = path.file_name().map_or(String::new(), |name| name.to_string_lossy().into_owned());
                                let folder = path.parent().map_or(String::new(), |dir| dir.to_string_lossy().into_owned());
                                let folder = if folder.chars().count() > 38 {
                                    format!("…{}", folder.chars().skip(folder.chars().count() - 37).collect::<String>())
                                } else {
                                    folder
                                };
                                MenuItem::action(format!("{name}    {folder}"), OpenRecent(index))
                            })
                            .chain([MenuItem::separator(), MenuItem::action("Clear list", crate::commands::ClearRecent)])
                            .collect(),
                        disabled: recent.is_empty(),
                    }),
                    id => {
                        let command = COMMANDS.iter().find(|command| command.id == id).expect("menus list commands");
                        MenuItem::Action { name: command.label.into(), action: (command.action)(), os_action: None, checked: false, disabled: false }
                    }
                })
                .collect(),
            disabled: false,
        })
        .collect()
}

/// Installs the menus: for the in-window menu bar (the component library's
/// state) and for the platform.
pub fn install_menus(cx: &mut App) {
    // (menus can't be cloned: build them once for each)
    let owned = menus(cx).into_iter().map(Menu::owned).collect();
    crate::kit::component::GlobalState::global_mut(cx).set_app_menus(owned);
    cx.set_menus(menus(cx));
}

/// The items of menu `index` of the menu bar, as a dropdown (built when it
/// opens, so recent files and labels are current).
pub fn menu_items(index: usize, mut menu: PopupMenu, window: &mut Window, cx: &mut Context<PopupMenu>) -> PopupMenu {
    let (_, entries) = MENUS[index];
    for entry in entries {
        menu = match *entry {
            "sep" => menu.separator(),
            "recent" => {
                let recent = app_state::settings(cx).recent_files.clone();
                if recent.is_empty() {
                    menu.item(PopupMenuItem::new("Open recent").disabled(true))
                } else {
                    menu.submenu("Open recent", window, cx, move |mut menu, _, _| {
                        for (position, path) in recent.iter().enumerate() {
                            let file = std::path::Path::new(path);
                            let name = file.file_name().map_or(String::new(), |name| name.to_string_lossy().into_owned());
                            menu = menu.menu(name, Box::new(OpenRecent(position)));
                        }
                        menu.separator().menu("Clear list", Box::new(crate::commands::ClearRecent))
                    })
                }
            }
            id => {
                let command = COMMANDS.iter().find(|command| command.id == id).expect("menus list commands");
                menu.menu(command.label, (command.action)())
            }
        };
    }
    menu
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Answer {
    Save,
    Discard,
    Cancel,
}

fn file_name(path: &Path) -> String {
    path.file_name().map_or("Untitled".into(), |name| name.to_string_lossy().into_owned())
}

impl WorkspaceView {
    fn remember(&mut self, path: &Path, cx: &mut Context<Self>) {
        let text = path.to_string_lossy().into_owned();
        let dir = path.parent().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default();
        app_state::update(cx, |settings| {
            settings.add_recent(&text);
            settings.last_dir = dir;
        });
        install_menus(cx);
        self.menu_bar.update(cx, |bar, cx| bar.reload(cx));
    }

    /// Asks "Save changes?" when there are unsaved changes. Resolves true when
    /// it is fine to go on (saved, or the user chose not to save).
    fn confirm_discard(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Task<bool> {
        if !self.is_dirty() || self.state.is_empty() {
            return Task::ready(true);
        }
        let (send, receive) = oneshot::channel::<Answer>();
        let send = std::rc::Rc::new(std::cell::RefCell::new(Some(send)));
        let message = format!("Save changes to “{}”?", self.file_name);
        let answer = move |answer: Answer| {
            let send = send.clone();
            move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                if let Some(send) = send.borrow_mut().take() {
                    send.send(answer).ok();
                }
                window.close_dialog(cx);
            }
        };
        window.open_dialog(cx, move |dialog, _, _| {
            crate::modal::frame(dialog, "info", "Unsaved changes", false).child(div().text_color(crate::theme::current().muted).child(message.clone())).footer(
                crate::modal::footer()
                    .child(Btn::new("unsaved-cancel", Look::Ghost).label("Cancel").on_click(answer(Answer::Cancel)))
                    .child(Btn::new("unsaved-discard", Look::Outline).label("Don't save").on_click(answer(Answer::Discard)))
                    .child(Btn::new("unsaved-save", Look::Primary).label("Save").on_click(answer(Answer::Save))),
            )
        });
        cx.spawn_in(window, async move |this, cx| match receive.await.unwrap_or(Answer::Cancel) {
            Answer::Cancel => false,
            Answer::Discard => true,
            Answer::Save => match this.update_in(cx, |this, window, cx| this.save_task(window, cx)) {
                Ok(task) => task.await,
                Err(_) => false,
            },
        })
    }

    /// A new untitled workspace with one 32-bit value.
    pub fn new_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let go = self.confirm_discard(window, cx);
        cx.spawn_in(window, async move |this, cx| {
            if go.await {
                this.update(cx, |this, cx| {
                    let settings = app_state::settings(cx);
                    let value = Value::new(32, Bits::ZERO, "Value 1", settings.default_view, settings.default_base).unwrap();
                    let mut state = WorkspaceState::default();
                    state.values.push_back(std::sync::Arc::new(value));
                    this.replace_state(state);
                    this.path = None;
                    this.file_name = "Untitled".into();
                    this.save_session_now(cx);
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    pub fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let go = self.confirm_discard(window, cx);
        let paths = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: Some("Open workspace".into()) });
        cx.spawn_in(window, async move |this, cx| {
            if !go.await {
                return;
            }
            let Ok(Ok(Some(paths))) = paths.await else { return };
            let Some(path) = paths.into_iter().next() else { return };
            this.update_in(cx, |this, window, cx| this.open_path(&path, window, cx)).ok();
        })
        .detach();
    }

    pub fn clear_recent(&mut self, cx: &mut Context<Self>) {
        app_state::update(cx, |settings| settings.recent_files.clear());
        install_menus(cx);
        self.menu_bar.update(cx, |bar, cx| bar.reload(cx));
    }

    pub fn open_recent(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = app_state::settings(cx).recent_files.get(index).cloned() else { return };
        let go = self.confirm_discard(window, cx);
        cx.spawn_in(window, async move |this, cx| {
            if go.await {
                this.update_in(cx, |this, window, cx| this.open_path(Path::new(&path), window, cx)).ok();
            }
        })
        .detach();
    }

    /// A file dropped on the window: asks about unsaved changes, then opens it.
    pub(super) fn open_dropped(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let go = self.confirm_discard(window, cx);
        cx.spawn_in(window, async move |this, cx| {
            if go.await {
                this.update_in(cx, |this, window, cx| this.open_path(&path, window, cx)).ok();
            }
        })
        .detach();
    }

    /// Opens a workspace file, or explains why it can't. A file saved by a
    /// newer version asks first: what this version doesn't understand is lost.
    pub fn open_path(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) {
        let parsed =
            std::fs::read_to_string(path).map_err(|error| error.to_string()).and_then(|text| parse_workspace_file(&text).map_err(|error| error.to_string()));
        let file = match parsed {
            Ok(file) => file,
            Err(error) => {
                window.push_notification(Notification::error(format!("Could not open {}: {error}", path.display())), cx);
                return;
            }
        };
        if file.version > FILE_VERSION {
            let message = format!(
                "“{}” was saved by a newer version of Bit Viewer (file format {}; this version reads format {FILE_VERSION}). Anything this version doesn't understand is left out, and is lost if you save over the file. Update Bit Viewer to keep it.",
                file_name(path),
                file.version
            );
            let workspace = cx.entity().downgrade();
            let path = path.to_path_buf();
            let state = std::cell::RefCell::new(Some(file.state));
            crate::modal::confirm(window, cx, "Saved by a newer version", message, "Open anyway".into(), false, move |window, cx| {
                if let Some(state) = state.borrow_mut().take() {
                    workspace.update(cx, |this, cx| this.show_opened(state, &path, window, cx)).ok();
                }
            });
            return;
        }
        self.show_opened(file.state, path, window, cx);
    }

    fn show_opened(&mut self, state: WorkspaceState, path: &Path, window: &mut Window, cx: &mut Context<Self>) {
        self.replace_state(state);
        self.scroll_to_value(0);
        self.path = Some(path.to_path_buf());
        self.file_name = file_name(path);
        self.remember(path, cx);
        self.save_session_now(cx);
        window.push_notification(Notification::success(format!("Opened {}", self.file_name)), cx);
        cx.notify();
    }

    pub fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.save_task(window, cx).detach();
    }

    pub fn save_as(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.save_as_task(window, cx).detach();
    }

    /// Saves to the open file, or asks where; resolves true when saved.
    fn save_task(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Task<bool> {
        match self.path.clone() {
            Some(path) => Task::ready(self.write(&path, window, cx)),
            None => self.save_as_task(window, cx),
        }
    }

    fn save_as_task(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Task<bool> {
        let dir = self
            .path
            .as_ref()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .or_else(|| Some(PathBuf::from(&app_state::settings(cx).last_dir)).filter(|dir| dir.is_dir()))
            .or_else(|| std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("Documents")))
            .unwrap_or_default();
        let suggested = self.path.as_deref().map(file_name).unwrap_or_else(|| "workspace.bitview".into());
        let chosen = cx.prompt_for_new_path(&dir, Some(&suggested));
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(mut path))) = chosen.await else { return false };
            let has_extension = path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("bitview") || extension.eq_ignore_ascii_case("json"));
            if !has_extension {
                path.set_extension("bitview");
            }
            this.update_in(cx, |this, window, cx| this.write(&path, window, cx)).unwrap_or(false)
        })
    }

    /// Writes the workspace to `path` (safely: a temporary file, then renamed).
    fn write(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let text = workspace_file_text(&self.state);
        match app_state::write_atomic(path, text.as_bytes()) {
            Ok(()) => {
                self.saved = Some(self.state.clone());
                self.version += 1;
                self.path = Some(path.to_path_buf());
                self.file_name = file_name(path);
                self.remember(path, cx);
                self.save_session_now(cx);
                window.push_notification(Notification::success(format!("Saved {}", self.file_name)), cx);
                cx.notify();
                true
            }
            Err(error) => {
                window.push_notification(Notification::error(format!("Could not save {}: {error}", path.display())), cx);
                false
            }
        }
    }

    /// Asks about unsaved changes, leaves the session on disk, and quits.
    pub fn quit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let was_dirty = self.is_dirty();
        let go = self.confirm_discard(window, cx);
        cx.spawn_in(window, async move |this, cx| {
            if !go.await {
                return;
            }
            this.update(cx, |this, cx| {
                if this.keeps_session(cx) {
                    // "Don't save" discards the changes: don't bring them back next time
                    let discarded = was_dirty && this.is_dirty();
                    let (state, path, name, _) = this.session_snapshot();
                    let state = if discarded { None } else { state };
                    session::write(state.as_ref(), path.as_deref(), &name, false);
                }
            })
            .ok();
            cx.update(|_, cx| cx.quit()).ok();
        })
        .detach();
    }

    // ------------------------------------------------------------ session
    pub(super) fn keeps_session(&self, cx: &App) -> bool {
        self.bench.is_none() && app_state::persists(cx)
    }

    /// What the session keeps: the workspace too, unless a saved file holds it all.
    fn session_snapshot(&self) -> (Option<WorkspaceState>, Option<PathBuf>, String, bool) {
        let dirty = self.is_dirty();
        let keep = dirty || self.path.is_none();
        (keep.then(|| self.state.clone()), self.path.clone(), self.file_name.clone(), dirty)
    }

    /// Writes the session a second after the last change (on another thread:
    /// a big workspace takes a moment to write).
    pub(super) fn save_session_soon(&mut self, cx: &mut Context<Self>) {
        if !self.keeps_session(cx) {
            return;
        }
        self.session_save = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(std::time::Duration::from_secs(1)).await;
            let Ok((state, path, name, dirty)) = this.update(cx, |this, _| this.session_snapshot()) else { return };
            cx.background_spawn(async move { session::write(state.as_ref(), path.as_deref(), &name, dirty) }).await;
        }));
    }

    /// Writes the session now (after open, save, new workspace).
    pub(super) fn save_session_now(&mut self, cx: &mut Context<Self>) {
        if !self.keeps_session(cx) {
            return;
        }
        self.session_save = None;
        let (state, path, name, dirty) = self.session_snapshot();
        cx.background_spawn(async move { session::write(state.as_ref(), path.as_deref(), &name, dirty) }).detach();
    }

    /// Where the shown workspace came from (a file given at start, or the
    /// last session), and whether it has unsaved changes.
    pub fn set_origin(&mut self, path: Option<PathBuf>, file_name: String, dirty: bool, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(path) = &path {
            self.remember(path, cx);
        }
        self.path = path;
        self.file_name = file_name;
        if dirty {
            self.saved = None; // differs from any file on disk
            self.version += 1;
            // once the window is up: this runs while it is being built, before
            // its message layer exists
            cx.spawn_in(window, async move |this, cx| {
                this.update_in(cx, |_, window, cx| {
                    window.push_notification(Notification::success("Restored unsaved changes from your last session"), cx);
                })
                .ok();
            })
            .detach();
        }
        cx.notify();
    }
}
