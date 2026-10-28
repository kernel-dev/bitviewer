//! The bundled font pairings: an interface font and a number font each, at
//! the weights the app uses (400–700). All are under the SIL Open Font
//! License; the licences are next to the files in assets/fonts. Only the
//! pairing in use is loaded, plus all of them while Settings shows them.

use std::borrow::Cow;
use std::cell::RefCell;

use gpui_kit::App;

pub struct FontSet {
    /// The id kept in the settings (core's FONT_SETS).
    pub id: &'static str,
    pub name: &'static str,
    pub about: &'static str,
    /// The interface font's family name.
    pub ui: &'static str,
    /// The number font's family name.
    pub mono: &'static str,
    files: [&'static [u8]; 8],
}

macro_rules! weights {
    ($ui:literal, $mono:literal) => {
        [
            include_bytes!(concat!("../assets/fonts/", $ui, "-Regular.ttf")),
            include_bytes!(concat!("../assets/fonts/", $ui, "-Medium.ttf")),
            include_bytes!(concat!("../assets/fonts/", $ui, "-SemiBold.ttf")),
            include_bytes!(concat!("../assets/fonts/", $ui, "-Bold.ttf")),
            include_bytes!(concat!("../assets/fonts/", $mono, "-Regular.ttf")),
            include_bytes!(concat!("../assets/fonts/", $mono, "-Medium.ttf")),
            include_bytes!(concat!("../assets/fonts/", $mono, "-SemiBold.ttf")),
            include_bytes!(concat!("../assets/fonts/", $mono, "-Bold.ttf")),
        ]
    };
}

pub const SETS: [FontSet; 7] = [
    FontSet {
        id: "outfit",
        name: "Outfit",
        about: "Outfit and Geist Mono: round and friendly, with a crisp number font",
        ui: "Outfit",
        mono: "Geist Mono",
        files: weights!("Outfit", "GeistMono"),
    },
    FontSet {
        id: "geist",
        name: "Geist",
        about: "Geist and Geist Mono: crisp and modern, with a slashed zero",
        ui: "Geist",
        mono: "Geist Mono",
        files: weights!("Geist", "GeistMono"),
    },
    FontSet {
        id: "atkinson",
        name: "Hyperlegible",
        about: "Atkinson Hyperlegible Next and Mono: drawn so 0 and O, 1, l and I, 8 and B can never be mixed up",
        ui: "Atkinson Hyperlegible Next",
        mono: "Atkinson Hyperlegible Mono",
        files: weights!("AtkinsonHyperlegibleNext", "AtkinsonHyperlegibleMono"),
    },
    FontSet {
        id: "inter",
        name: "Inter",
        about: "Inter and JetBrains Mono: the developer classic, tall and very clear",
        ui: "Inter",
        mono: "JetBrains Mono",
        files: weights!("Inter", "JetBrainsMono"),
    },
    FontSet {
        id: "plex",
        name: "Plex",
        about: "IBM Plex Sans and Mono: engineered and a little technical",
        ui: "IBM Plex Sans",
        mono: "IBM Plex Mono",
        files: weights!("IBMPlexSans", "IBMPlexMono"),
    },
    FontSet {
        id: "source",
        name: "Source",
        about: "Source Sans 3 and Source Code Pro: narrow and quiet, fits the most on screen",
        ui: "Source Sans 3",
        mono: "Source Code Pro",
        files: weights!("SourceSans3", "SourceCodePro"),
    },
    FontSet {
        id: "redhat",
        name: "Red Hat",
        about: "Red Hat Text and Red Hat Mono: round and friendly",
        ui: "Red Hat Text",
        mono: "Red Hat Mono",
        files: weights!("RedHatText", "RedHatMono"),
    },
];

/// The pairing with this id (the first one if there is none).
pub fn set(id: &str) -> &'static FontSet {
    SETS.iter().find(|set| set.id == id).unwrap_or(&SETS[0])
}

thread_local! {
    /// The pairings already handed to the text system.
    static LOADED: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) };
}

/// Loads a pairing's fonts, once.
pub fn load(set: &'static FontSet, cx: &mut App) {
    if LOADED.with_borrow(|loaded| loaded.contains(&set.id)) {
        return;
    }
    LOADED.with_borrow_mut(|loaded| loaded.push(set.id));
    let fonts = set.files.iter().map(|bytes| Cow::Borrowed(*bytes)).collect();
    if let Err(error) = cx.text_system().add_fonts(fonts) {
        eprintln!("Could not load the {} fonts: {error}", set.name);
    }
}

/// Loads every pairing (Settings shows each in its own fonts).
pub fn load_all(cx: &mut App) {
    for set in &SETS {
        load(set, cx);
    }
}
