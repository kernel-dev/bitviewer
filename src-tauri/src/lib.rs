use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Writes `contents` atomically: write a temp file next to the target, then rename.
fn write_atomic(target: &Path, contents: &str) -> Result<(), String> {
    let mut tmp = target.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Reads a workspace file as UTF-8 text.
#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Writes a workspace file atomically.
#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> {
    write_atomic(Path::new(&path), &contents)
}

/// File passed on the command line, e.g. `BitViewer.exe workspace.bitview.json`.
#[tauri::command]
fn initial_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .filter(|a| Path::new(a).is_file())
}

/// Resolves a file in the app's own folders. `dir` is "config" (settings) or
/// "data" (session, autosave). Only plain file names are accepted, so these
/// commands can never reach outside those folders.
fn app_file(app: &AppHandle, dir: &str, name: &str) -> Result<PathBuf, String> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        && !name.starts_with('.');
    if !valid {
        return Err(format!("invalid app file name {name:?}"));
    }
    let base = match dir {
        "config" => app.path().app_config_dir(),
        "data" => app.path().app_local_data_dir(),
        _ => return Err(format!("unknown app folder {dir:?}")),
    }
    .map_err(|e| e.to_string())?;
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base.join(name))
}

/// Contents of an app file, or None if it doesn't exist yet.
#[tauri::command]
fn read_app_file(app: AppHandle, dir: String, name: String) -> Result<Option<String>, String> {
    let path = app_file(&app, &dir, &name)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn write_app_file(
    app: AppHandle,
    dir: String,
    name: String,
    contents: String,
) -> Result<(), String> {
    write_atomic(&app_file(&app, &dir, &name)?, &contents)
}

#[tauri::command]
fn delete_app_file(app: AppHandle, dir: String, name: String) -> Result<(), String> {
    match fs::remove_file(app_file(&app, &dir, &name)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            read_text,
            write_text,
            initial_file,
            read_app_file,
            write_app_file,
            delete_app_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Bit Viewer");
}
