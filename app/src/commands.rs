//! Every user-facing action in one place, as in the web app's command
//! registry: menus, keyboard shortcuts and the command palette are all built
//! from this table. Each command is a GPUI action, handled by the workspace
//! view (or the active value's card for the Value group).

use crate::kit::*;

actions!(
    bitviewer,
    [
        NewWorkspace,
        Open,
        Save,
        SaveAs,
        ImportSvd,
        ImportDump,
        Quit,
        Undo,
        Redo,
        Add32,
        Add64,
        AddCustom,
        AddFromExpr,
        AddFromTemplate,
        GroupSelection,
        ClearSelection,
        Find,
        Palette,
        ZoomIn,
        ZoomOut,
        ZoomReset,
        ToggleTheme,
        ToggleCompact,
        ToggleSounds,
        Settings,
        HelpControls,
        HelpGuide,
        HelpWhatsNew,
        HelpTour,
        HelpUpdates,
        HelpAbout,
        CardCollapse,
        CardSnapshot,
        CardExport,
        CardTemplate,
        CardSaveTemplate,
        CardExpr,
        CardBases,
        CardPaste,
        CardSwap,
        CardNot,
        CardClear,
        CardCompare,
        CardDuplicate,
        CardWidth,
        CardRemove,
    ]
);

/// Opens the recent file at this position (File › Open recent).
#[derive(Clone, PartialEq, Debug, Action)]
#[action(namespace = bitviewer, no_json)]
pub struct OpenRecent(pub usize);

actions!(bitviewer, [NoOp, ClearRecent]);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Group {
    File,
    Edit,
    Value,
    View,
    Help,
}

impl Group {
    pub fn name(self) -> &'static str {
        match self {
            Group::File => "File",
            Group::Edit => "Edit",
            Group::Value => "Value",
            Group::View => "View",
            Group::Help => "Help",
        }
    }
}

pub struct Command {
    pub id: &'static str,
    pub group: Group,
    pub label: &'static str,
    /// Shortcuts as the web app writes them ("Ctrl+Shift+S"); the first is shown.
    pub keys: &'static [&'static str],
    /// Extra words the command palette matches on.
    pub keywords: &'static str,
    pub action: fn() -> Box<dyn Action>,
}

macro_rules! command {
    ($id:literal, $group:ident, $label:literal, [$($key:literal),*], $keywords:literal, $action:ident) => {
        Command {
            id: $id,
            group: Group::$group,
            label: $label,
            keys: &[$($key),*],
            keywords: $keywords,
            action: || Box::new($action),
        }
    };
}

/// The commands, with the web app's ids, labels, shortcuts and keywords.
pub const COMMANDS: &[Command] = &[
    command!("file.new", File, "New workspace", ["Ctrl+N"], "", NewWorkspace),
    command!("file.open", File, "Open…", ["Ctrl+O"], "", Open),
    command!("file.save", File, "Save", ["Ctrl+S"], "", Save),
    command!("file.saveAs", File, "Save as…", ["Ctrl+Shift+S"], "", SaveAs),
    command!("file.importSvd", File, "Import CMSIS-SVD…", [], "svd cmsis register description peripheral arm stm32 nrf import", ImportSvd),
    command!("file.importDump", File, "Import memory dump…", [], "dump memory hex srec bin gdb openocd read registers import", ImportDump),
    command!("file.quit", File, "Quit", [], "exit close", Quit),
    command!("edit.undo", Edit, "Undo", ["Ctrl+Z"], "", Undo),
    command!("edit.redo", Edit, "Redo", ["Ctrl+Y", "Ctrl+Shift+Z"], "", Redo),
    command!("value.add32", Edit, "Add 32-bit value", ["Ctrl+1"], "new", Add32),
    command!("value.add64", Edit, "Add 64-bit value", ["Ctrl+2"], "new", Add64),
    command!("value.addCustom", Edit, "Add value with custom width…", ["Ctrl+3"], "new width bits", AddCustom),
    command!("value.fromExpr", Edit, "New value from expression…", [], "calculate combine and or xor add", AddFromExpr),
    command!("value.fromTemplate", Edit, "Add value from template…", [], "float ieee utf-8 layout", AddFromTemplate),
    command!("sel.group", Edit, "Group selection", ["Ctrl+G"], "field", GroupSelection),
    command!("sel.clear", Edit, "Clear selection", ["Esc"], "", ClearSelection),
    command!("edit.find", Edit, "Find…", ["Ctrl+F"], "search filter", Find),
    command!("app.palette", Help, "Command palette…", ["Ctrl+K", "Ctrl+Shift+P"], "commands actions", Palette),
    command!("view.zoomIn", View, "Zoom in", ["Ctrl+=", "Ctrl++"], "bigger", ZoomIn),
    command!("view.zoomOut", View, "Zoom out", ["Ctrl+-"], "smaller", ZoomOut),
    command!("view.zoomReset", View, "Reset zoom", ["Ctrl+0"], "", ZoomReset),
    command!("view.theme", View, "Light / dark theme", ["Ctrl+T"], "light dark", ToggleTheme),
    command!("view.compact", View, "Compact layout", [], "dense tight spacing", ToggleCompact),
    command!("view.sounds", View, "Sounds", [], "audio mute", ToggleSounds),
    command!("app.settings", View, "Settings…", ["Ctrl+,"], "preferences options", Settings),
    command!("help.controls", Help, "Controls & shortcuts", ["F1"], "keys keyboard", HelpControls),
    command!("help.guide", Help, "Guide", [], "docs documentation manual how to tutorial", HelpGuide),
    command!("help.whatsnew", Help, "What's new", [], "changelog changes release notes version", HelpWhatsNew),
    command!("help.tour", Help, "Take the tour", [], "introduction guide first", HelpTour),
    command!("help.updates", Help, "Check for updates…", [], "upgrade version new", HelpUpdates),
    command!("help.about", Help, "About Bit Viewer", [], "version", HelpAbout),
    command!("card.collapse", Value, "Collapse / expand", [], "", CardCollapse),
    command!("card.snapshot", Value, "Take snapshot…", [], "", CardSnapshot),
    command!("card.export", Value, "Export code…", [], "c rust python header", CardExport),
    command!("card.template", Value, "Apply template…", [], "", CardTemplate),
    command!("card.saveTemplate", Value, "Save fields as template…", [], "", CardSaveTemplate),
    command!("card.expr", Value, "Expression bar", [], "calculate formula", CardExpr),
    command!("card.bases", Value, "Show / hide all bases", [], "hex dec oct bin", CardBases),
    command!("card.paste", Value, "Paste bytes…", [], "endian", CardPaste),
    command!("card.swap", Value, "Swap bytes", [], "endian bswap", CardSwap),
    command!("card.not", Value, "Invert bits (NOT)", [], "", CardNot),
    command!("card.clear", Value, "Clear to 0", [], "zero reset", CardClear),
    command!("card.compare", Value, "Compare with…", [], "diff", CardCompare),
    command!("card.duplicate", Value, "Duplicate", [], "copy", CardDuplicate),
    command!("card.width", Value, "Change width…", [], "bits resize", CardWidth),
    command!("card.remove", Value, "Remove value", [], "delete", CardRemove),
];

/// "Ctrl+Shift+S" → "ctrl-shift-s" (GPUI's keystroke syntax).
pub fn keystroke(spec: &str) -> String {
    let (modifiers, key) = match spec.strip_suffix("++") {
        Some(rest) => (rest, "+"),
        None => match spec.rsplit_once('+') {
            Some((modifiers, key)) => (modifiers, key),
            None => ("", spec),
        },
    };
    let key = match key.to_lowercase().as_str() {
        "esc" => "escape".to_string(),
        "del" => "delete".to_string(),
        other => other.to_string(),
    };
    let mut parts: Vec<String> = modifiers.split('+').filter(|part| !part.is_empty()).map(|part| part.to_lowercase()).collect();
    parts.push(key);
    parts.join("-")
}

/// Binds every command's shortcuts in the workspace.
pub fn bind_keys(cx: &mut App) {
    let mut bindings = Vec::new();
    let context = std::rc::Rc::new(KeyBindingContextPredicate::parse("Workspace").expect("a valid context"));
    let mapper = cx.keyboard_mapper().clone();
    for command in COMMANDS {
        for key in command.keys {
            // Esc stays with text fields and dialogs; the workspace handles it itself
            if *key == "Esc" {
                continue;
            }
            bindings.push(
                KeyBinding::load(&keystroke(key), (command.action)(), Some(context.clone()), false, None, mapper.as_ref()).expect("command shortcuts parse"),
            );
        }
    }
    cx.bind_keys(bindings);
}

/// The menu bar: which commands each menu shows, in order ("sep" = separator,
/// "recent" = the recent files submenu).
pub const MENUS: &[(&str, &[&str])] = &[
    ("File", &["file.new", "file.open", "recent", "file.importSvd", "file.importDump", "sep", "file.save", "file.saveAs", "sep", "file.quit"]),
    (
        "Edit",
        &[
            "edit.undo",
            "edit.redo",
            "sep",
            "value.add32",
            "value.add64",
            "value.addCustom",
            "value.fromExpr",
            "value.fromTemplate",
            "sep",
            "sel.group",
            "sel.clear",
            "sep",
            "edit.find",
        ],
    ),
    ("View", &["view.zoomIn", "view.zoomOut", "view.zoomReset", "sep", "view.theme", "view.compact", "view.sounds", "sep", "app.settings"]),
    ("Help", &["app.palette", "help.controls", "help.guide", "help.whatsnew", "help.tour", "sep", "help.updates", "help.about"]),
];

#[cfg(test)]
mod tests {
    // not `use super::*`: that brings in GPUI's `test` macro, which shadows #[test]
    use super::{COMMANDS, MENUS, keystroke};

    #[test]
    fn writes_shortcuts_in_gpui_syntax() {
        assert_eq!(keystroke("Ctrl+Shift+S"), "ctrl-shift-s");
        assert_eq!(keystroke("Ctrl++"), "ctrl-+");
        assert_eq!(keystroke("Ctrl+-"), "ctrl--");
        assert_eq!(keystroke("Ctrl+,"), "ctrl-,");
        assert_eq!(keystroke("F1"), "f1");
        assert_eq!(keystroke("Esc"), "escape");
    }

    #[test]
    fn every_menu_entry_is_a_command() {
        for (_, entries) in MENUS {
            for entry in *entries {
                if *entry != "sep" && *entry != "recent" {
                    assert!(COMMANDS.iter().any(|command| command.id == *entry), "{entry}");
                }
            }
        }
    }
}
