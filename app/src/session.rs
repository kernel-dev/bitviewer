//! The auto-saved session on disk (data folder, session.json): read at
//! start, written a moment after each change and on save, open and quit.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use bitviewer_core::session::{read_session, session_text};
use bitviewer_core::workspace::{WorkspaceState, parse_workspace_file};

use crate::app_state::{data_dir, write_atomic};

fn file() -> PathBuf {
    data_dir().join("session.json")
}

/// What the last session left open.
pub struct Restored {
    pub state: WorkspaceState,
    pub path: Option<PathBuf>,
    pub file_name: String,
    /// It had unsaved changes.
    pub dirty: bool,
}

/// Reads a workspace file, or None.
pub fn open_file(path: &Path) -> Option<WorkspaceState> {
    let text = std::fs::read_to_string(path).ok()?;
    parse_workspace_file(&text).ok().map(|file| file.state)
}

/// What to show at start, as the web app: the saved file reopened from disk
/// when there were no unsaved changes, else the kept workspace.
pub fn restore() -> Option<Restored> {
    let text = std::fs::read_to_string(file()).ok()?;
    let session = read_session(&text)?;
    if !session.dirty
        && let Some(path) = &session.path
        && let Some(state) = open_file(Path::new(path))
    {
        return Some(Restored { state, path: Some(PathBuf::from(path)), file_name: session.file_name, dirty: false });
    }
    let state = session.state?;
    Some(Restored { state, path: session.path.map(PathBuf::from), file_name: session.file_name, dirty: session.dirty })
}

/// Writes the session (best effort: auto-save must never interrupt work).
pub fn write(state: Option<&WorkspaceState>, path: Option<&Path>, file_name: &str, dirty: bool) {
    let saved_at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |time| time.as_millis() as f64);
    let path = path.map(|path| path.to_string_lossy().into_owned());
    let text = session_text(state, path.as_deref(), file_name, dirty, saved_at);
    if let Err(error) = write_atomic(&file(), text.as_bytes()) {
        eprintln!("Could not save the session: {error}");
    }
}
