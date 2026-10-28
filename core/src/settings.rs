//! Persisted app settings, the same keys, defaults and rules as the web
//! app's settings.ts, so both read the same settings.json. Reading keeps
//! the valid entries and ignores unknown or mistyped ones.

use serde_json::{Map, Value as Json, json};

use crate::integers::Base;
use crate::rows::View;

pub const ZOOM_MIN: f64 = 0.5;
pub const ZOOM_MAX: f64 = 3.0;
pub const ZOOM_STEP: f64 = 0.1;
pub const MAX_RECENT: usize = 10;

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub zoom: f64,
    /// "dark", "light" or "contrast".
    pub theme: String,
    /// Bit order inside a row: MSB on the left.
    pub msb_left: bool,
    /// Per-row hex/dec/oct readout.
    pub show_readouts: bool,
    /// Signed / float interpretation chips.
    pub show_interp: bool,
    /// Base for rows of newly added values.
    pub default_base: Base,
    /// Row layout of newly added values.
    pub default_view: View,
    pub sounds: bool,
    /// 0 … 1.
    pub sound_volume: f64,
    /// Folder of the last opened / saved workspace.
    pub last_dir: String,
    /// Last custom width picked.
    pub last_width: usize,
    /// Most recent first.
    pub recent_files: Vec<String>,
    /// Which readout chips show under each value.
    pub readout_chips: Vec<String>,
    /// The user's field layout templates (as saved).
    pub templates: Vec<Json>,
    /// The user's code export templates (as saved).
    pub export_templates: Vec<Json>,
    /// Id of the export template used last.
    pub export_last: String,
    /// Tighter spacing everywhere.
    pub compact: bool,
    /// "#rrggbb", or "" for the colour scheme's own accent.
    pub accent: String,
    /// The colour scheme: one of SCHEMES ("lavender" by default).
    pub scheme: String,
    /// The font pairing: one of FONT_SETS.
    pub fonts: String,
    pub tour_done: bool,
    pub check_updates: bool,
    /// App version whose changes were last shown ("" = never).
    pub last_seen_version: String,
}

/// The colour schemes, by id: Lavender (the default), Signal red, Blueprint, Graphite & amber,
/// Phosphor, Plum and Lagoon.
pub const SCHEMES: [&str; 7] = ["lavender", "signal", "blueprint", "graphite", "phosphor", "plum", "lagoon"];

/// The font pairings, by id; the first is the default.
pub const FONT_SETS: [&str; 7] = ["outfit", "geist", "atkinson", "inter", "plex", "source", "redhat"];

impl Default for Settings {
    fn default() -> Self {
        Settings {
            zoom: 1.0,
            theme: "light".into(), // the datasheet look is light first
            msb_left: true,
            show_readouts: true,
            show_interp: true,
            default_base: Base::Hex,
            default_view: View::Line,
            sounds: false,
            sound_volume: 0.5,
            last_dir: String::new(),
            last_width: 16,
            recent_files: Vec::new(),
            readout_chips: ["u", "s", "pop", "float"].map(String::from).to_vec(),
            templates: Vec::new(),
            export_templates: Vec::new(),
            export_last: "c".into(),
            compact: false,
            accent: String::new(),
            scheme: SCHEMES[0].into(),
            fonts: FONT_SETS[0].into(),
            tour_done: false,
            check_updates: true,
            last_seen_version: String::new(),
        }
    }
}

pub fn clamp_zoom(zoom: f64) -> f64 {
    (zoom.clamp(ZOOM_MIN, ZOOM_MAX) * 100.0).round() / 100.0
}

fn string_list(value: &Json) -> Option<Vec<String>> {
    value.as_array()?.iter().map(|entry| entry.as_str().map(String::from)).collect()
}

/// A saved export template needs a name, an extension and a source.
fn is_saved_export(value: &Json) -> bool {
    value.get("name").and_then(Json::as_str).is_some_and(|name| !name.trim().is_empty())
        && value.get("extension").is_some_and(Json::is_string)
        && value.get("source").is_some_and(Json::is_string)
}

impl Settings {
    /// Reads settings.json text; anything missing or unusable keeps its default.
    pub fn from_json(text: &str) -> Settings {
        let mut settings = Settings::default();
        if let Ok(Json::Object(raw)) = serde_json::from_str::<Json>(text) {
            settings.merge(&raw);
        }
        settings.sanitize();
        settings
    }

    /// Copies the valid entries of `raw` over these settings.
    fn merge(&mut self, raw: &Map<String, Json>) {
        let get = |key: &str| raw.get(key);
        if let Some(v) = get("zoom").and_then(Json::as_f64) {
            self.zoom = v;
        }
        if let Some(v) = get("theme").and_then(Json::as_str) {
            self.theme = v.into();
        }
        for (key, target) in [
            ("msb_left", &mut self.msb_left),
            ("show_readouts", &mut self.show_readouts),
            ("show_interp", &mut self.show_interp),
            ("sounds", &mut self.sounds),
            ("compact", &mut self.compact),
            ("tour_done", &mut self.tour_done),
            ("check_updates", &mut self.check_updates),
        ] {
            if let Some(v) = get(key).and_then(Json::as_bool) {
                *target = v;
            }
        }
        // the web app keeps a number in `default_base` and checks it below
        if let Some(v) = get("default_base").and_then(Json::as_u64) {
            self.default_base = Base::from_radix(v).unwrap_or(Base::Hex);
        }
        if let Some(v) = get("default_view").and_then(Json::as_str) {
            self.default_view = View::parse(v).unwrap_or(View::Line);
        }
        if let Some(v) = get("sound_volume").and_then(Json::as_f64) {
            self.sound_volume = v;
        }
        for (key, target) in [
            ("last_dir", &mut self.last_dir),
            ("export_last", &mut self.export_last),
            ("accent", &mut self.accent),
            ("scheme", &mut self.scheme),
            ("fonts", &mut self.fonts),
            ("last_seen_version", &mut self.last_seen_version),
        ] {
            if let Some(v) = get(key).and_then(Json::as_str) {
                *target = v.into();
            }
        }
        if let Some(v) = get("last_width").and_then(Json::as_f64) {
            self.last_width = v as usize;
        }
        if let Some(v) = get("recent_files").and_then(string_list) {
            self.recent_files = v;
        }
        if let Some(v) = get("readout_chips").and_then(string_list) {
            self.readout_chips = v;
        }
        if let Some(Json::Array(list)) = get("templates") {
            // checked properly where templates are used (templates.rs)
            self.templates = list.iter().filter(|t| t.is_object()).cloned().collect();
        }
        if let Some(Json::Array(list)) = get("export_templates") {
            self.export_templates = list.iter().filter(|t| is_saved_export(t)).cloned().collect();
        }
    }

    fn sanitize(&mut self) {
        self.zoom = clamp_zoom(self.zoom);
        if !["dark", "light", "contrast"].contains(&self.theme.as_str()) {
            self.theme = "light".into();
        }
        self.sound_volume = self.sound_volume.clamp(0.0, 1.0);
        if !SCHEMES.contains(&self.scheme.as_str()) {
            self.scheme = SCHEMES[0].into();
        }
        if !FONT_SETS.contains(&self.fonts.as_str()) {
            self.fonts = FONT_SETS[0].into();
        }
        let valid_accent = self.accent.len() == 7 && self.accent.starts_with('#') && self.accent[1..].chars().all(|c| c.is_ascii_hexdigit());
        if !self.accent.is_empty() && !valid_accent {
            self.accent.clear();
        }
        self.recent_files.truncate(MAX_RECENT);
    }

    /// The accent as a colour number, if one is set.
    pub fn accent_color(&self) -> Option<u32> {
        u32::from_str_radix(self.accent.trim_start_matches('#'), 16).ok().filter(|_| !self.accent.is_empty())
    }

    /// Puts `path` first in the recent files.
    pub fn add_recent(&mut self, path: &str) {
        self.recent_files.retain(|recent| recent != path);
        self.recent_files.insert(0, path.into());
        self.recent_files.truncate(MAX_RECENT);
    }

    pub fn to_json(&self) -> String {
        let value = json!({
            "zoom": self.zoom,
            "theme": self.theme,
            "msb_left": self.msb_left,
            "show_readouts": self.show_readouts,
            "show_interp": self.show_interp,
            "default_base": self.default_base.radix(),
            "default_view": self.default_view.as_str(),
            "sounds": self.sounds,
            "sound_volume": self.sound_volume,
            "last_dir": self.last_dir,
            "last_width": self.last_width,
            "recent_files": self.recent_files,
            "readout_chips": self.readout_chips,
            "templates": self.templates,
            "export_templates": self.export_templates,
            "export_last": self.export_last,
            "compact": self.compact,
            "accent": self.accent,
            "scheme": self.scheme,
            "fonts": self.fonts,
            "tour_done": self.tour_done,
            "check_updates": self.check_updates,
            "last_seen_version": self.last_seen_version,
        });
        serde_json::to_string_pretty(&value).expect("settings serialize")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_valid_entries_and_ignores_the_rest() {
        let settings = Settings::from_json(
            r##"{ "zoom": 9, "theme": "neon", "sounds": true, "default_base": 2,
                 "default_view": "nibble", "accent": "#3b82f6", "recent_files": ["a", 3],
                 "export_templates": [{ "name": "x", "extension": "h", "source": "" }, { "name": "" }],
                 "unknown": 1, "msb_left": "yes" }"##,
        );
        assert_eq!(settings.zoom, ZOOM_MAX);
        assert_eq!(settings.theme, "light");
        assert!(settings.sounds);
        assert_eq!(settings.default_base, Base::Bin);
        assert_eq!(settings.default_view, View::Nibble);
        assert_eq!(settings.accent_color(), Some(0x3b82f6));
        assert_eq!(settings.scheme, "lavender");
        let plum = Settings::from_json(r#"{ "scheme": "plum" }"#);
        assert_eq!(plum.scheme, "plum");
        assert_eq!(Settings::from_json(r#"{ "scheme": "neon" }"#).scheme, "lavender");
        assert!(settings.recent_files.is_empty()); // not all strings
        assert_eq!(settings.export_templates.len(), 1);
        assert!(settings.msb_left); // mistyped: default kept
        assert_eq!(Settings::from_json("not json"), Settings::default());
    }

    #[test]
    fn round_trips_and_keeps_recent_files_short() {
        let mut settings = Settings::default();
        for index in 0..15 {
            settings.add_recent(&format!("file{index}"));
        }
        settings.add_recent("file3");
        assert_eq!(settings.recent_files.len(), MAX_RECENT);
        assert_eq!(settings.recent_files[0], "file3");
        assert_eq!(Settings::from_json(&settings.to_json()), settings);
    }
}
