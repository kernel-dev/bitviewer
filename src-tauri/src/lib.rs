use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// Largest file `read_text` will load. Workspaces are a few kilobytes; big
/// CMSIS-SVD files reach tens of megabytes.
const MAX_READ_BYTES: u64 = 512 * 1024 * 1024;

/// Extensions `read_text` opens: workspaces and SVD register descriptions.
const READABLE: &[&str] = &["bitview", "json", "svd", "xml"];

/// Extensions `write_text` refuses: files Windows runs or interprets when they
/// are opened. Code exports can use any other extension.
const UNWRITABLE: &[&str] = &[
    "exe", "dll", "sys", "com", "scr", "msi", "msp", "bat", "cmd", "ps1", "psm1", "vbs", "vbe",
    "jse", "wsf", "wsh", "lnk", "url", "reg", "cpl", "hta", "pif", "app", "command",
];

fn extension(path: &Path) -> String {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn require_absolute(path: &Path) -> Result<(), String> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err(format!("{} is not a full path", path.display()))
    }
}

/// Writes `contents` atomically: write a temp file next to the target, then rename.
fn write_atomic(target: &Path, contents: &[u8]) -> Result<(), String> {
    let mut temporary_path = target.as_os_str().to_owned();
    temporary_path.push(".tmp");
    let temporary_path = PathBuf::from(temporary_path);
    fs::write(&temporary_path, contents).map_err(|error| error.to_string())?;
    fs::rename(&temporary_path, target).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        error.to_string()
    })
}

/// Reads a workspace or SVD file as UTF-8 text.
#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    let path = Path::new(&path);
    require_absolute(path)?;
    if !READABLE.contains(&extension(path).as_str()) {
        return Err(format!(
            "Bit Viewer only opens .bitview, .json, .svd and .xml files, not {}",
            path.display()
        ));
    }
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if metadata.len() > MAX_READ_BYTES {
        return Err(format!(
            "{} is too large ({} MB; the limit is {} MB)",
            path.display(),
            metadata.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024)
        ));
    }
    fs::read_to_string(path).map_err(|error| error.to_string())
}

/// Writes a workspace or exported code file atomically.
#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> {
    let path = Path::new(&path);
    require_absolute(path)?;
    if UNWRITABLE.contains(&extension(path).as_str()) {
        return Err(format!(
            "Bit Viewer doesn't write .{} files",
            extension(path)
        ));
    }
    if path.is_dir() {
        return Err(format!("{} is a folder", path.display()));
    }
    write_atomic(path, contents.as_bytes())
}

/// First existing file among command-line arguments (skipping the program).
/// Relative paths are resolved against `cwd`, the folder the launch came from.
fn file_arg<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Option<String> {
    args.into_iter()
        .skip(1)
        .find(|argument| !argument.starts_with('-'))
        .map(|argument| cwd.join(argument)) // join keeps absolute paths as they are
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

/// A file to open that arrived before the window was ready for it.
#[derive(Default)]
struct PendingFile {
    /// True once the window has asked for its start-up file.
    ready: bool,
    path: Option<String>,
}

/// Hands a file to the window: as an event once it is running, or kept for
/// `initial_file` while it is still starting.
fn deliver_file(app: &AppHandle, path: String) {
    if let Some(state) = app.try_state::<Mutex<PendingFile>>() {
        if let Ok(mut pending) = state.lock() {
            if !pending.ready {
                pending.path = Some(path);
                return;
            }
        }
    }
    let _ = app.emit("open-file", path);
}

/// File to open at start-up: from the command line (`BitViewer.exe
/// workspace.bitview`) or, on macOS, from the system's "open with" event.
#[tauri::command]
fn initial_file(pending: State<Mutex<PendingFile>>) -> Option<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let from_args = file_arg(std::env::args(), &cwd);
    let mut pending = pending.lock().ok()?;
    pending.ready = true;
    from_args.or_else(|| pending.path.take())
}

/// Resolves a file in the app's own folders. `directory` is "config" (settings) or
/// "data" (session, autosave). Only plain file names are accepted, so these
/// commands can never reach outside those folders.
fn app_file(app: &AppHandle, directory: &str, name: &str) -> Result<PathBuf, String> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
        && !name.starts_with('.');
    if !valid {
        return Err(format!("invalid app file name {name:?}"));
    }
    let base = match directory {
        "config" => app.path().app_config_dir(),
        "data" => app.path().app_local_data_dir(),
        _ => return Err(format!("unknown app folder {directory:?}")),
    }
    .map_err(|error| error.to_string())?;
    fs::create_dir_all(&base).map_err(|error| error.to_string())?;
    Ok(base.join(name))
}

/// Contents of an app file, or None if it doesn't exist yet.
#[tauri::command]
fn read_app_file(
    app: AppHandle,
    directory: String,
    name: String,
) -> Result<Option<String>, String> {
    let path = app_file(&app, &directory, &name)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Writes an app file. The contents come as the raw request body (UTF-8
/// bytes) and the folder and name as headers, so a large session isn't
/// escaped into JSON and copied again on the way.
#[tauri::command]
fn write_app_file(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let header = |key: &str| {
        request
            .headers()
            .get(key)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| format!("missing {key}"))
    };
    let tauri::ipc::InvokeBody::Raw(contents) = request.body() else {
        return Err("expected the file contents as bytes".into());
    };
    std::str::from_utf8(contents).map_err(|error| error.to_string())?;
    write_atomic(
        &app_file(&app, header("directory")?, header("name")?)?,
        contents,
    )
}

#[tauri::command]
fn delete_app_file(app: AppHandle, directory: String, name: String) -> Result<(), String> {
    match fs::remove_file(app_file(&app, &directory, &name)?) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // must come first: a second launch (e.g. double-clicking another
        // workspace) hands its file to this window instead of opening a new one
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if let Some(path) = file_arg(argv, Path::new(&cwd)) {
                deliver_file(app, path);
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Mutex::new(PendingFile::default()))
        .invoke_handler(tauri::generate_handler![
            read_text,
            write_text,
            initial_file,
            read_app_file,
            write_app_file,
            delete_app_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building Bit Viewer")
        .run(|_app, _event| {
            // macOS doesn't pass "open with" files on the command line; they
            // arrive as this event, at start-up and while the app runs.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &_event {
                if let Some(path) = urls.iter().find_map(|url| url.to_file_path().ok()) {
                    deliver_file(_app, path.to_string_lossy().into_owned());
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_arg_resolves_relative_paths_against_the_launch_folder() {
        let folder = std::env::temp_dir().join("bitviewer-file-arg-test");
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join("a.bitview");
        fs::write(&file, "{}").unwrap();
        let args = |rest: &[&str]| -> Vec<String> {
            std::iter::once("BitViewer")
                .chain(rest.iter().copied())
                .map(String::from)
                .collect()
        };
        assert_eq!(
            file_arg(args(&["a.bitview"]), &folder),
            Some(file.to_string_lossy().into_owned())
        );
        assert_eq!(
            file_arg(
                args(&["--flag", file.to_str().unwrap()]),
                Path::new("/elsewhere")
            ),
            Some(file.to_string_lossy().into_owned())
        );
        assert_eq!(file_arg(args(&["missing.bitview"]), &folder), None);
        fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn read_and_write_refuse_unexpected_files() {
        assert!(read_text("relative.bitview".into()).is_err());
        let exe = std::env::temp_dir().join("bitviewer-test.exe");
        assert!(read_text(exe.to_string_lossy().into_owned()).is_err());
        assert!(write_text(exe.to_string_lossy().into_owned(), String::new()).is_err());
        let folder = std::env::temp_dir().join("bitviewer-write-test.json");
        fs::create_dir_all(&folder).unwrap();
        assert!(read_text(folder.to_string_lossy().into_owned()).is_err());
        assert!(write_text(folder.to_string_lossy().into_owned(), String::new()).is_err());
        fs::remove_dir_all(&folder).unwrap();
        let ok = std::env::temp_dir().join("bitviewer-write-test.h");
        write_text(ok.to_string_lossy().into_owned(), "x".into()).unwrap();
        assert_eq!(fs::read_to_string(&ok).unwrap(), "x");
        fs::remove_file(&ok).unwrap();
    }
}
