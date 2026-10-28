//! Bit Viewer: view and edit the bits of registers (a GPUI app).
//!
//! bitviewer [FILE.bitview] [--count N] [--bench] [--bench-json PATH]
//!   FILE      a workspace to open
//!   --count   repeat the file's values (or generated ones) up to N values,
//!             for trying large workspaces
//!   --bench   scroll, jump, click and undo by itself, print frame timings, quit
//!   --bench-json  also write the results as JSON (implies --bench)
//!   --shot SCENE  set up one of the guide's screenshots (workspace_view/shots.rs)

// no console window next to the app in release builds on Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// GPUI handlers and caches are spelled out where they are kept
#![allow(clippy::type_complexity)]

mod app_state;
mod assets;
mod card;
mod commands;
mod export_dialog;
mod expr_field;
mod field_editor;
mod fit;
mod fonts;
mod guide_dialog;
mod help_dialog;
mod kit;
mod modal;
mod palette;
mod prompt;
mod session;
mod settings_dialog;
mod sound;
mod svd_dialog;
mod templates_dialog;
mod theme;
mod tour;
mod updates;
mod value_dialogs;
mod widgets;
mod workspace_view;

// The interface tests drive windows on GPUI CE's test platform. On macOS its
// test windows panic when asked for a native window handle (they should
// return an error), and the component library asks for one there (text
// inputs, native menus, accessibility). Real windows have one, so the app
// is unaffected; these tests run on Windows and Linux.
#[cfg(all(test, not(target_os = "macos")))]
mod tests;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use crate::kit::*;
use bitviewer_core::integers::{Base, Bits};
use bitviewer_core::rows::View;
use bitviewer_core::value::{Value, ValueId};
use bitviewer_core::workspace::{Peripheral, WorkspaceState, parse_workspace_file};

use workspace_view::WorkspaceView;

struct Args {
    file: Option<PathBuf>,
    count: Option<usize>,
    bench: bool,
    bench_json: Option<PathBuf>,
    /// Imports every register of this SVD at start (for measuring).
    import_svd: Option<PathBuf>,
    /// Stages one of the guide's screenshots (workspace_view/shots.rs).
    shot: Option<String>,
}

fn parse_args() -> Args {
    let mut args = Args { file: None, count: None, bench: false, bench_json: None, import_svd: None, shot: None };
    let mut rest = std::env::args().skip(1);
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--count" => args.count = rest.next().and_then(|n| n.parse().ok()),
            "--bench" => args.bench = true,
            "--import-svd" => args.import_svd = rest.next().map(PathBuf::from),
            "--shot" => args.shot = rest.next(),
            "--bench-json" => {
                args.bench = true;
                args.bench_json = rest.next().map(PathBuf::from);
            }
            _ => args.file = Some(PathBuf::from(arg)),
        }
    }
    args
}

/// A plain 32-bit register with a few fields, for trying without a file.
fn sample_value(index: usize) -> Value {
    let mut value = Value::new(32, Bits::from(index as u64 * 2654435761 % (1 << 32)), &format!("REG{index}"), View::Byte, Base::Hex).unwrap();
    for (lo, hi, name) in [(0, 0, "EN"), (1, 3, "MODE"), (8, 15, "DIV"), (28, 31, "STATUS")] {
        value.add_field(lo, hi, Some(name), None, None).unwrap();
    }
    value
}

/// `count` values: the file's repeated with numbered names (and their own
/// peripheral copies), or generated ones.
fn repeated(base: WorkspaceState, count: usize) -> WorkspaceState {
    if base.is_empty() {
        let mut state = WorkspaceState::default();
        for index in 0..count {
            state.values.push_back(Arc::new(sample_value(index)));
        }
        return state;
    }
    let mut state = WorkspaceState::default();
    let mut copy = 0;
    while state.len() < count {
        for value in &base.values {
            if state.len() == count {
                break;
            }
            let mut value = Value::clone(value);
            value.id = ValueId::fresh(); // each copy is a value of its own
            value.name = format!("{}_{copy}", value.name).into();
            if !value.block.is_empty() {
                let block: Arc<str> = format!("{}_{copy}", value.block).into();
                if let Some(peripheral) = base.peripherals.get(&value.block) {
                    state.peripherals.insert(block.clone(), Arc::new(Peripheral { name: block.clone(), ..Peripheral::clone(peripheral) }));
                }
                value.block = block;
            }
            state.values.push_back(Arc::new(value));
        }
        copy += 1;
    }
    state
}

fn main() {
    let args = parse_args();
    let started = Instant::now();

    // the benchmark opens the file itself, in the running app (as the web
    // app's benchmark does), so window start-up isn't counted as opening
    if args.bench {
        let Some(path) = &args.file else {
            eprintln!("--bench needs a workspace file");
            std::process::exit(1);
        };
        let text = std::fs::read_to_string(path).unwrap_or_else(|error| {
            eprintln!("Could not open {}: {error}", path.display());
            std::process::exit(1);
        });
        let bench = workspace_view::BenchOptions { text, json: args.bench_json.clone() };
        let state = repeated(WorkspaceState::default(), 1);
        let opened = session::Restored { state, path: None, file_name: "bench.bitview".into(), dirty: false };
        return run(Start::Opened(opened), Some(bench), None, None);
    }

    // a file given at start, else what the last session left open, else a
    // fresh workspace (as the web app)
    // an SVD given at start opens the import picker over the last session
    let svd = args.file.as_ref().filter(|path| svd_dialog::is_svd(path)).cloned();
    let svd_start = match (args.import_svd.clone(), svd) {
        (Some(path), _) => Some(SvdStart::All(path)),
        (None, Some(path)) => Some(SvdStart::Picker(path)),
        (None, None) => None,
    };
    let file = args.file.clone().filter(|path| !svd_dialog::is_svd(path));
    let start = match &file {
        Some(path) => {
            let text = std::fs::read_to_string(path).unwrap_or_else(|error| {
                eprintln!("Could not open {}: {error}", path.display());
                std::process::exit(1);
            });
            let file = parse_workspace_file(&text).unwrap_or_else(|error| {
                eprintln!("Could not read {}: {error}", path.display());
                std::process::exit(1);
            });
            let name = path.file_name().map_or("Untitled".into(), |n| n.to_string_lossy().into_owned());
            let state = match args.count {
                Some(count) => repeated(file.state, count),
                None => file.state,
            };
            // a generated workspace isn't the file any more
            let path = args.count.is_none().then(|| path.clone());
            Start::Opened(session::Restored { state, path, file_name: name, dirty: false })
        }
        None if args.count.is_some() => Start::Opened(session::Restored {
            state: repeated(WorkspaceState::default(), args.count.unwrap()),
            path: None,
            file_name: "Untitled".into(),
            dirty: false,
        }),
        // a guide screenshot never shows the last session (it may be private)
        None if args.shot.is_some() => Start::Fresh,
        None => session::restore().map_or(Start::Fresh, Start::Opened),
    };
    if let Start::Opened(opened) = &start {
        println!("opened {} values in {} ms", opened.state.len(), started.elapsed().as_millis());
    }
    if let Some(scene) = &args.shot
        && !workspace_view::shots::SCENES.contains(&scene.as_str())
    {
        eprintln!("--shot: no scene {scene:?}; the scenes are {}", workspace_view::shots::SCENES.join(", "));
        std::process::exit(1);
    }
    run(start, None, svd_start, args.shot);
}

/// An SVD to import once the window is up.
enum SvdStart {
    /// Every register, no picker (--import-svd, for measuring).
    All(PathBuf),
    /// Through the picker (an .svd passed as the file).
    Picker(PathBuf),
}

enum Start {
    Opened(session::Restored),
    /// One new 32-bit value.
    Fresh,
}

fn run(start: Start, bench: Option<workspace_view::BenchOptions>, import_svd: Option<SvdStart>, shot: Option<String>) {
    crate::kit::application().with_assets(assets::Assets).run(move |cx| {
        // a guide screenshot uses fixed settings, and saves nothing
        workspace_view::init(shot.as_deref().map(workspace_view::shots::settings), cx);
        let opened = match start {
            Start::Opened(opened) => opened,
            Start::Fresh => {
                let settings = app_state::settings(cx);
                let value = Value::new(32, Bits::ZERO, "Value 1", settings.default_view, settings.default_base).expect("32 bits is a valid width");
                let mut state = WorkspaceState::default();
                state.values.push_back(Arc::new(value));
                session::Restored { state, path: None, file_name: "Untitled".into(), dirty: false }
            }
        };
        let session::Restored { state, path, file_name: name, dirty } = opened;
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1280.0), px(900.0)), cx))),
            // the title bar is drawn by the app (chrome.rs); the title still names the window
            titlebar: Some(TitlebarOptions { title: Some(format!("{name} — Bit Viewer").into()), ..crate::kit::component::TitleBar::title_bar_options() }),
            window_min_size: Some(size(px(640.0), px(420.0))),
            ..crate::kit::component::TitleBar::window_options()
        };
        crate::kit::open_window(options, cx, |window, cx| {
            let view = cx.new(|cx| WorkspaceView::new(state, name.clone(), bench, window, cx));
            view.update(cx, |view, cx| {
                view.set_origin(path, name, dirty, window, cx);
                match shot {
                    Some(scene) => view.stage_shot(scene, window, cx),
                    None => view.startup_checks(window, cx),
                }
                if let Some(svd) = import_svd {
                    // once the window is up (dialogs and messages need it)
                    cx.spawn_in(window, async move |view, cx| {
                        view.update_in(cx, |view, window, cx| match svd {
                            SvdStart::All(path) => view.import_svd_all(&path, window, cx),
                            SvdStart::Picker(path) => view.import_svd(Some(path), window, cx),
                        })
                        .ok();
                    })
                    .detach();
                }
            });
            view
        })
        .expect("could not open the window");
    });
}
