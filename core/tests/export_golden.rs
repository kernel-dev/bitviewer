//! The native exporter against the web app's, byte for byte: the golden file
//! holds the web app's output for a sample workspace with every built-in
//! template (written by tests/unit/export-golden.test.ts with WRITE_GOLDEN=1).

use std::collections::BTreeMap;

use bitviewer_core::export::{ExportOptions, builtin_exports, default_prefix, render_export, render_peripheral_export};
use bitviewer_core::workspace::parse_workspace_file;

#[test]
fn matches_the_web_app() {
    let sample = parse_workspace_file(include_str!("fixtures/export-sample.bitview")).unwrap().state;
    let golden: BTreeMap<String, String> = serde_json::from_str(include_str!("fixtures/export-golden.json")).unwrap();
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    let shown = |result: Result<String, bitviewer_core::export::language::TemplateError>| match result {
        Ok(text) => text,
        Err(error) => format!("ERROR {error}"),
    };
    let templates = builtin_exports();
    for (index, value) in sample.values.iter().enumerate() {
        let peripheral = sample.peripherals.get(&value.block).map(|p| (**p).clone());
        for template in templates.iter().filter(|t| t.scope == "register") {
            for platform in [32, 64] {
                for include_value in [true, false] {
                    let options = ExportOptions { prefix: default_prefix(value), include_value, accessors: true, platform };
                    let key = format!("{index}/{}/{platform}/{include_value}", template.id);
                    out.insert(key, shown(render_export(&template.source, value, &options, peripheral.as_ref())));
                }
            }
        }
    }
    for peripheral in sample.peripherals.values() {
        let members: Vec<_> = sample.values.iter().filter(|v| v.block == peripheral.name).map(|v| &**v).collect();
        for template in templates.iter().filter(|t| t.scope == "peripheral") {
            for include_value in [true, false] {
                let key = format!("{}/{}/{include_value}", peripheral.name, template.id);
                out.insert(key, shown(render_peripheral_export(&template.source, peripheral, &members, &peripheral.name, include_value)));
            }
        }
    }
    assert_eq!(out.len(), golden.len(), "same number of outputs");
    let mut differences = 0;
    for (key, expected) in &golden {
        let actual = &out[key];
        if actual != expected {
            differences += 1;
            if differences <= 3 {
                let line = expected.lines().zip(actual.lines()).position(|(a, b)| a != b).unwrap_or(0);
                eprintln!("{key} differs at line {}:\n  web:    {:?}\n  native: {:?}", line + 1, expected.lines().nth(line), actual.lines().nth(line));
            }
        }
    }
    assert_eq!(differences, 0, "{differences} of {} outputs differ", golden.len());
}
