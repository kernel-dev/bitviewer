//! App-wide state: the settings (saved to settings.json a moment after each
//! change) and where the app keeps its files.
//!
//! It keeps them in its own folders (com.bitviewer.native). The first time
//! it starts, it copies the settings and auto-saved session of the Tauri
//! app it replaced (com.bitviewer.app; the file formats are the same), so
//! that app's users carry on where they were. The Tauri app's files are only
//! read, never changed.

use std::path::PathBuf;
use std::time::Duration;

use bitviewer_core::settings::{Settings, clamp_zoom};
use gpui_kit::*;

use crate::theme;

const APP_ID: &str = "com.bitviewer.native";
const SAVE_DELAY: Duration = Duration::from_millis(300);

pub struct AppState {
    pub settings: Settings,
    save: Option<Task<()>>,
    /// False when the settings were handed in (tests): nothing is written.
    persist: bool,
}

impl Global for AppState {}

/// The folder for settings (Windows: %APPDATA%\<app>).
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")).unwrap_or_default());
    base.join(APP_ID)
}

/// The folder for the auto-saved session (Windows: %LOCALAPPDATA%\<app>).
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")).unwrap_or_default());
    base.join(APP_ID)
}

/// Writes `text` safely: a temporary file next to `path`, then renamed over it.
pub fn write_atomic(path: &std::path::Path, text: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, path).inspect_err(|_| {
        std::fs::remove_file(&temporary).ok();
    })
}

/// The Tauri app's folders (settings, data): the app this one replaced.
fn tauri_dirs() -> (PathBuf, PathBuf) {
    const TAURI_ID: &str = "com.bitviewer.app";
    if cfg!(target_os = "macos") {
        let base = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join("Library/Application Support").join(TAURI_ID);
        return (base.clone(), base);
    }
    let parent = |dir: PathBuf| dir.parent().map(|parent| parent.join(TAURI_ID)).unwrap_or_default();
    (parent(config_dir()), parent(data_dir()))
}

/// Copies `from` to `to` when `to` doesn't exist yet (`from` is only read).
fn copy_if_missing(from: &std::path::Path, to: &std::path::Path) -> bool {
    if to.exists() || !from.is_file() {
        return false;
    }
    std::fs::read(from).and_then(|bytes| write_atomic(to, &bytes)).is_ok()
}

/// On the first start: the Tauri app's settings and session, if it left any.
fn import_from_tauri() {
    let (config, data) = tauri_dirs();
    copy_if_missing(&config.join("settings.json"), &config_dir().join("settings.json"));
    copy_if_missing(&data.join("session.json"), &data_dir().join("session.json"));
}

/// Reads the settings and applies them (theme, accent). Tests pass their own.
pub fn init(settings: Option<Settings>, cx: &mut App) {
    let persist = settings.is_none();
    if persist {
        import_from_tauri();
    }
    let settings =
        settings.unwrap_or_else(|| std::fs::read_to_string(config_dir().join("settings.json")).map(|text| Settings::from_json(&text)).unwrap_or_default());
    cx.set_global(AppState { settings, save: None, persist });
    apply(cx);
}

/// False in tests: nothing is written to disk.
pub fn persists(cx: &App) -> bool {
    cx.global::<AppState>().persist
}

pub fn settings(cx: &App) -> &Settings {
    &cx.global::<AppState>().settings
}

/// Changes the settings; they are saved a moment later and applied now.
pub fn update(cx: &mut App, change: impl FnOnce(&mut Settings)) {
    let state = cx.global_mut::<AppState>();
    let before = state.settings.clone();
    change(&mut state.settings);
    state.settings.zoom = clamp_zoom(state.settings.zoom);
    if state.settings == before {
        return;
    }
    let appearance_changed = before.theme != state.settings.theme
        || before.accent != state.settings.accent
        || before.scheme != state.settings.scheme
        || before.fonts != state.settings.fonts;
    let persist = state.persist;
    let text = state.settings.to_json();
    let path = config_dir().join("settings.json");
    // a new change replaces the pending save
    let save = persist.then(|| {
        cx.spawn(async move |cx| {
            cx.background_executor().timer(SAVE_DELAY).await;
            if let Err(error) = write_atomic(&path, text.as_bytes()) {
                eprintln!("Could not save the settings: {error}");
            }
        })
    });
    cx.global_mut::<AppState>().save = save;
    theme::set_compact(cx.global::<AppState>().settings.compact);
    if appearance_changed {
        apply(cx);
    } else {
        cx.refresh_windows();
    }
}

/// Applies the theme and accent from the settings.
fn apply(cx: &mut App) {
    let settings = settings(cx);
    theme::set_compact(settings.compact);
    let name = theme::ThemeName::parse(&settings.theme);
    let accent = settings.accent_color();
    let scheme = settings.scheme.clone();
    let fonts = crate::fonts::set(&settings.fonts);
    crate::fonts::load(fonts, cx);
    theme::set_fonts(fonts.ui, fonts.mono, cx);
    theme::apply(name, &scheme, accent, cx);
}

#[cfg(test)]
mod tests {
    use super::copy_if_missing;

    #[test]
    fn imports_only_what_is_missing() {
        let dir = std::env::temp_dir().join(format!("bitviewer-import-{}", std::process::id()));
        let (theirs, ours) = (dir.join("tauri/settings.json"), dir.join("native/settings.json"));
        std::fs::create_dir_all(theirs.parent().unwrap()).unwrap();
        std::fs::write(&theirs, "{\"theme\": \"dark\"}").unwrap();
        assert!(copy_if_missing(&theirs, &ours));
        assert_eq!(std::fs::read_to_string(&ours).unwrap(), "{\"theme\": \"dark\"}");
        // ours exists now: never overwritten; theirs is untouched
        std::fs::write(&ours, "{}").unwrap();
        assert!(!copy_if_missing(&theirs, &ours));
        assert_eq!(std::fs::read_to_string(&ours).unwrap(), "{}");
        assert_eq!(std::fs::read_to_string(&theirs).unwrap(), "{\"theme\": \"dark\"}");
        // nothing to import
        assert!(!copy_if_missing(&dir.join("tauri/none.json"), &dir.join("native/none.json")));
        std::fs::remove_dir_all(&dir).ok();
    }
}
