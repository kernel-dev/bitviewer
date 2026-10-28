//! The auto-saved session (session.json), the web app's session.ts format:
//! what was open and, unless it is all in a saved file, the workspace
//! itself, so a crash or restart brings everything back, unsaved changes
//! included.

use serde_json::value::RawValue;
use serde_json::{Value as Json, json};

use crate::json::value_to_json;
#[cfg(test)]
use crate::value::Value;
use crate::workspace::{WorkspaceState, parse_workspace_file, peripheral_to_json};

/// A session as read back.
pub struct Session {
    /// The workspace file, if it was saved or opened.
    pub path: Option<String>,
    pub file_name: String,
    /// Unsaved changes at the time of writing.
    pub dirty: bool,
    /// The workspace; None: reopen `path` from disk.
    pub state: Option<WorkspaceState>,
}

/// Reads a session file's text; None when it is missing or damaged (which
/// just means starting fresh).
pub fn read_session(text: &str) -> Option<Session> {
    let top: std::collections::HashMap<&str, &RawValue> = serde_json::from_str(text).ok()?;
    let field = |key: &str| top.get(key).and_then(|raw| serde_json::from_str::<Json>(raw.get()).ok());
    if field("version")? != json!(1) {
        return None;
    }
    let path = field("path").and_then(|path| path.as_str().map(String::from));
    let file_name = field("fileName").and_then(|name| name.as_str().map(String::from)).unwrap_or_else(|| "Untitled".into());
    let dirty = field("dirty") == Some(json!(true));
    let values = top.get("values").map(|raw| raw.get()).filter(|raw| raw.trim_start().starts_with('['));
    let state = values.and_then(|values| {
        let peripherals = top.get("peripherals").map(|raw| raw.get()).filter(|raw| raw.trim_start().starts_with('['));
        // read as a workspace file, which reads big ones on every core
        let file = format!(r#"{{"app":"bitviewer","values":{values},"peripherals":{}}}"#, peripherals.unwrap_or("null"));
        parse_workspace_file(&file).ok().map(|file| file.state)
    });
    Some(Session { path, file_name, dirty, state })
}

/// The session file's text. `state` is None when the saved file holds
/// everything (then only its path is kept). Values are written on every core.
pub fn session_text(state: Option<&WorkspaceState>, path: Option<&str>, file_name: &str, dirty: bool, saved_at: f64) -> String {
    let head = json!({ "version": 1, "path": path, "fileName": file_name, "dirty": dirty, "savedAt": saved_at });
    let head = head.to_string();
    // Write directly into the final buffer. Building one String per value,
    // then joining those strings and formatting the whole session again,
    // multiplied peak memory for large workspaces.
    let mut out = Vec::new();
    out.extend_from_slice(&head.as_bytes()[..head.len() - 1]);
    out.extend_from_slice(b",\"values\":");
    if let Some(state) = state {
        out.push(b'[');
        for (index, value) in state.values.iter().enumerate() {
            if index > 0 {
                out.push(b',');
            }
            serde_json::to_writer(&mut out, &value_to_json(value)).expect("workspace values serialize");
        }
        out.extend_from_slice(b"],\"peripherals\":[");
        for (index, peripheral) in state.used_peripherals().iter().enumerate() {
            if index > 0 {
                out.push(b',');
            }
            serde_json::to_writer(&mut out, &peripheral_to_json(peripheral)).expect("workspace peripherals serialize");
        }
        out.push(b']');
    } else {
        out.extend_from_slice(b"null,\"peripherals\":null");
    }
    out.push(b'}');
    String::from_utf8(out).expect("serde_json writes UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integers::{Base, Bits};
    use crate::rows::View;
    use std::sync::Arc;

    #[test]
    fn round_trips_unsaved_work() {
        let mut state = WorkspaceState::default();
        let mut value = Value::new(16, Bits::from(0xBEEFu32), "CTRL", View::Byte, Base::Hex).unwrap();
        value.add_field(0, 3, Some("MODE"), None, None).unwrap();
        state.values.push_back(Arc::new(value));
        let text = session_text(Some(&state), None, "Untitled", true, 1.0);
        let session = read_session(&text).unwrap();
        assert!(session.dirty);
        assert_eq!(session.path, None);
        let restored = session.state.unwrap();
        assert_eq!(restored.values[0].value, Bits::from(0xBEEFu32));
        assert_eq!(&*restored.values[0].fields[0].name, "MODE");

        let saved = session_text(None, Some("C:/a.bitview"), "a.bitview", false, 2.0);
        let session = read_session(&saved).unwrap();
        assert!(session.state.is_none());
        assert_eq!(session.path.as_deref(), Some("C:/a.bitview"));
        assert!(read_session("{").is_none());
        assert!(read_session(r#"{"version":2}"#).is_none());
    }
}
