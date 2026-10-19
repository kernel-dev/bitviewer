use std::fs;
use std::path::PathBuf;

/// Reads a workspace file as UTF-8 text.
#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Writes a workspace file atomically: write a temp file next to it, then rename.
#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let mut tmp = target.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// File passed on the command line, e.g. `BitViewer.exe workspace.bitview.json`.
#[tauri::command]
fn initial_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .filter(|a| std::path::Path::new(a).is_file())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![read_text, write_text, initial_file])
        .run(tauri::generate_context!())
        .expect("error while running Bit Viewer");
}
