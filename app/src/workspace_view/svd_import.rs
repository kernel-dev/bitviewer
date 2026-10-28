//! Adding the registers picked in the SVD importer (svd_dialog.rs) to the
//! workspace, and starting an import.

use std::collections::HashMap;
use std::path::PathBuf;

use bitviewer_core::field::wrap_big;
use bitviewer_core::svd::{SvdDevice, SvdRegister, parse_svd, register_template};
use bitviewer_core::value::Value;
use bitviewer_core::workspace::Peripheral;
use gpui_kit::component::WindowExt;
use gpui_kit::component::notification::Notification;
use gpui_kit::*;
use num_traits::ToPrimitive;

use super::WorkspaceView;
use crate::app_state;
use crate::svd_dialog::open_picker;

impl WorkspaceView {
    /// Adds SVD registers as values, each in a peripheral block of its own
    /// peripheral (an existing one with the same name and base is reused);
    /// one undo step.
    pub fn add_svd_values(&mut self, registers: &[SvdRegister], device: &SvdDevice, window: &mut Window, cx: &mut Context<Self>) {
        let before = self.state.clone();
        let settings = app_state::settings(cx).clone();
        let mut blocks: HashMap<String, std::sync::Arc<str>> = HashMap::new();
        let mut first = None;
        let mut pool = bitviewer_core::json::TextPool::default();
        for register in registers {
            let base = register.peripheral_base.to_u64();
            let block = blocks.entry(register.peripheral.clone()).or_insert_with(|| {
                let existing = self.state.peripherals.get(register.peripheral.as_str()).cloned();
                let name: std::sync::Arc<str> = match &existing {
                    Some(peripheral) if peripheral.base == base => register.peripheral.as_str().into(),
                    _ => self.state.free_peripheral_name(&register.peripheral).into(),
                };
                if existing.is_none() || *name != *register.peripheral {
                    self.state.peripherals.insert(
                        name.clone(),
                        std::sync::Arc::new(Peripheral {
                            name: name.clone(),
                            base,
                            description: register.peripheral_description.as_str().into(),
                            collapsed: false,
                        }),
                    );
                }
                name
            });
            let Ok(mut value) =
                Value::new(register.size, wrap_big(&register.reset_value, register.size), &register.path, settings.default_view, settings.default_base)
            else {
                continue;
            };
            if value.apply_template(&register_template(register, &device.name)).is_err() {
                continue;
            }
            let offset = (&register.address - &register.peripheral_base).to_u64();
            value.set_peripheral(block, offset);
            value.set_description(&register.description);
            pool.share_value(&mut value);
            first.get_or_insert(value.id);
            // after the block's last register (tidy keeps blocks together)
            let at = self.state.values.iter().rposition(|v| v.block == *block).map_or(self.state.len(), |last| last + 1);
            self.state.values.insert(at, std::sync::Arc::new(value));
        }
        self.state.tidy();
        self.history.record(&before, None);
        self.reset_rows();
        if let Some(index) = first.and_then(|id| self.state.values.iter().position(|v| v.id == id)) {
            self.scroll_to_value(index);
        }
        self.changed(cx);
        let count = registers.len();
        window.push_notification(Notification::success(format!("Added {count} value{} from {}", if count == 1 { "" } else { "s" }, device.name)), cx);
    }

    /// File › Import CMSIS-SVD…: asks for a file (unless one was dropped),
    /// reads it, and opens the picker.
    pub fn import_svd(&mut self, path: Option<PathBuf>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = path else {
            let paths = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: Some("Import CMSIS-SVD".into()) });
            cx.spawn_in(window, async move |this, cx| {
                let Ok(Ok(Some(paths))) = paths.await else { return };
                let Some(path) = paths.into_iter().next() else { return };
                this.update_in(cx, |this, window, cx| this.import_svd(Some(path), window, cx)).ok();
            })
            .detach();
            return;
        };
        let name = path.file_name().map_or(String::new(), |name| name.to_string_lossy().into_owned());
        let device = std::fs::read_to_string(&path).map_err(|error| error.to_string()).and_then(|text| parse_svd(&text).map_err(|error| error.to_string()));
        match device {
            Ok(device) => {
                if let Some(dir) = path.parent() {
                    let dir = dir.to_string_lossy().into_owned();
                    app_state::update(cx, |settings| settings.last_dir = dir);
                }
                open_picker(device, name, cx.entity().downgrade(), window, cx);
            }
            Err(error) => window.push_notification(Notification::error(format!("Could not read the SVD file {name}: {error}")), cx),
        }
    }

    /// Imports every register of an SVD without the picker (--import-svd).
    pub fn import_svd_all(&mut self, path: &std::path::Path, window: &mut Window, cx: &mut Context<Self>) {
        let started = std::time::Instant::now();
        let device = match std::fs::read_to_string(path).map_err(|e| e.to_string()).and_then(|text| parse_svd(&text).map_err(|e| e.to_string())) {
            Ok(device) => device,
            Err(error) => {
                eprintln!("Could not import {}: {error}", path.display());
                return;
            }
        };
        let parsed = started.elapsed();
        let sets: Vec<(&bitviewer_core::svd::SvdRegisterArray, bitviewer_core::svd::IndexSet)> = device
            .peripherals
            .iter()
            .flat_map(|peripheral| peripheral.registers.iter())
            .map(|array| (array, bitviewer_core::svd::IndexSet::all(array.count)))
            .collect();
        let picks: Vec<_> = sets.iter().map(|(array, set)| (*array, set)).collect();
        let registers = bitviewer_core::svd::picked_registers(&picks);
        self.add_svd_values(&registers, &device, window, cx);
        println!(
            "SVD-IMPORTED {} registers: parsed in {} ms, added in {} ms; pid={}",
            registers.len(),
            parsed.as_millis(),
            (started.elapsed() - parsed).as_millis(),
            std::process::id()
        );
        // BV_SCROLL=1: then walks the whole list, a screen per frame, to see
        // whether memory grows with what has been shown
        if std::env::var_os("BV_SCROLL").is_some() {
            let count = self.state.len();
            cx.spawn_in(window, async move |view, cx| {
                for step in 0..count / 20 {
                    cx.background_executor().timer(std::time::Duration::from_millis(8)).await;
                    let ok = view.update(cx, |view, cx| {
                        view.scroll_to_value(step * 20);
                        cx.notify();
                    });
                    if ok.is_err() {
                        return;
                    }
                }
                println!("SCROLLED through {count} values");
            })
            .detach();
        }
    }
}
