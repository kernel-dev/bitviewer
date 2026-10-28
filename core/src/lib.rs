//! Bit Viewer's data model, with no user interface: values and their fields,
//! workspace files (compatible with the TypeScript app's .bitview files),
//! undo history and the rest of the logic the app is built on.

pub mod changelog;
pub mod export;
pub mod expr;
pub mod field;
pub mod history;
pub mod integers;
pub mod interpretations;
pub mod json;
pub mod meaning;
pub mod ops;
pub mod rows;
pub mod session;
pub mod settings;
pub mod svd;
pub mod templates;
pub mod value;
pub mod workspace;

/// Something the user asked for can't be done; the message can be shown as is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelError(pub String);

impl ModelError {
    pub fn new(message: impl Into<String>) -> Self {
        ModelError(message.into())
    }
}

impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ModelError {}
