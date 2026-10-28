//! The workspace: values in order, and the peripherals they belong to.
//!
//! The state is built from persistent structures: cloning a WorkspaceState is
//! cheap and shares everything, and changing one value copies only that value
//! and a short path in the tree. Undo keeps whole states (see history.rs),
//! so a step costs about what it changed, at any workspace size.
//!
//! A value belongs to a peripheral through its `block` name and sits at its
//! `offset`; the peripheral (base address, description, collapsed or not) is
//! stored once. A peripheral's values are kept next to each other.

use std::collections::HashSet;
use std::sync::Arc;

use imbl::{HashMap, Vector};
use serde_json::value::RawValue;
use serde_json::{Map, Value as Json, json};

use crate::ModelError;
use crate::integers::Bits;
use crate::json::{TextPool, value_from_json, value_to_json};
use crate::value::Value;

/// The file format version this app writes. Newer files open after a warning.
pub const FILE_VERSION: u64 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Peripheral {
    pub name: Arc<str>,
    /// Base address, or None when unknown (offsets still work).
    pub base: Option<u64>,
    pub description: Arc<str>,
    pub collapsed: bool,
    /// Named copies of all its registers' values, oldest first.
    pub snapshots: Vec<PeripheralSnapshot>,
}

/// Every register of a peripheral at some moment, by register name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeripheralSnapshot {
    pub name: Arc<str>,
    /// Milliseconds since the Unix epoch.
    pub at: i64,
    pub values: Vec<(Arc<str>, Bits)>,
}

impl PeripheralSnapshot {
    /// The value the snapshot has for the register called `name`.
    pub fn value_of(&self, name: &str) -> Option<Bits> {
        self.values.iter().find(|(register, _)| &**register == name).map(|(_, bits)| *bits)
    }
}

impl Peripheral {
    /// A peripheral with just a name (no base address yet).
    pub fn named(name: Arc<str>) -> Peripheral {
        Peripheral { name, base: None, description: "".into(), collapsed: false, snapshots: Vec::new() }
    }
}

pub fn peripheral_to_json(peripheral: &Peripheral) -> Json {
    let mut out = Map::new();
    out.insert("name".into(), json!(&*peripheral.name));
    out.insert(
        "base".into(),
        match peripheral.base {
            Some(base) => json!(format!("0x{base:X}")),
            None => Json::Null,
        },
    );
    if !peripheral.description.is_empty() {
        out.insert("description".into(), json!(&*peripheral.description));
    }
    if peripheral.collapsed {
        out.insert("collapsed".into(), json!(true));
    }
    if !peripheral.snapshots.is_empty() {
        let list: Vec<Json> = peripheral
            .snapshots
            .iter()
            .map(|snapshot| {
                let values: Map<String, Json> = snapshot.values.iter().map(|(name, bits)| (name.to_string(), json!(format!("0x{bits:X}")))).collect();
                json!({ "name": &*snapshot.name, "at": snapshot.at, "values": values })
            })
            .collect();
        out.insert("snapshots".into(), Json::Array(list));
    }
    Json::Object(out)
}

/// Reads one peripheral from JSON.
pub fn peripheral_from_json(json: &Json, pool: &mut TextPool) -> Result<Peripheral, ModelError> {
    let name = json
        .get("name")
        .and_then(Json::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| ModelError::new("Invalid peripheral entry: it needs a name"))?;
    let invalid = || ModelError::new(format!("Invalid base address for {name}"));

    let base = match json.get("base") {
        None | Some(Json::Null) => None,
        Some(base) => {
            let text = match base {
                Json::String(text) => text.trim().to_string(),
                other => other.to_string(),
            };
            let big = crate::json::to_big(&Json::String(text)).map_err(|_| invalid())?;
            Some(u64::try_from(big).map_err(|_| invalid())?)
        }
    };

    // snapshots: anything malformed is skipped
    let snapshots = json
        .get("snapshots")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|snapshot| {
            let name = snapshot.get("name")?.as_str()?;
            let at = snapshot.get("at").and_then(Json::as_f64).unwrap_or(0.0) as i64;
            let values = snapshot
                .get("values")?
                .as_object()?
                .iter()
                .filter_map(|(register, bits)| {
                    let big = crate::json::to_big(bits).ok()?;
                    let bits = crate::field::big_to_bits(&big)?;
                    Some((pool.get(register), bits))
                })
                .collect();
            Some(PeripheralSnapshot { name: pool.get(name), at, values })
        })
        .collect();
    Ok(Peripheral {
        name: pool.get(name),
        base,
        description: pool.get(json.get("description").and_then(Json::as_str).unwrap_or("")),
        collapsed: json.get("collapsed") == Some(&Json::Bool(true)),
        snapshots,
    })
}

/// Everything in a workspace, cheap to clone (see the module docs).
#[derive(Clone, Debug, Default)]
pub struct WorkspaceState {
    pub values: Vector<Arc<Value>>,
    pub peripherals: HashMap<Arc<str>, Arc<Peripheral>>,
}

impl WorkspaceState {
    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// Changes the value at `index` with `edit`, copying it only if an undo
    /// step still shares it. Returns what `edit` returns (usually "changed").
    pub fn edit<R>(&mut self, index: usize, edit: impl FnOnce(&mut Value) -> R) -> R {
        let slot = self.values.get_mut(index).expect("value index out of range");
        edit(Arc::make_mut(slot))
    }

    /// Peripherals that have values, in workspace order.
    pub fn used_peripherals(&self) -> Vec<Arc<Peripheral>> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for value in &self.values {
            if value.block.is_empty() || !seen.insert(value.block.clone()) {
                continue;
            }
            if let Some(peripheral) = self.peripherals.get(&value.block) {
                out.push(peripheral.clone());
            }
        }
        out
    }

    /// Keeps each peripheral's values next to each other (all where its first
    /// one is), gives every block a value names a peripheral (with no base
    /// address yet) and drops peripherals nothing uses, as the web app's
    /// tidyPeripherals. Returns true when the order changed.
    pub fn tidy(&mut self) -> bool {
        let mut used: HashSet<Arc<str>> = HashSet::new();
        let mut contiguous = true;
        let mut previous: Option<&Arc<str>> = None;
        for value in &self.values {
            if !value.block.is_empty() && previous != Some(&value.block) && !used.insert(value.block.clone()) {
                contiguous = false; // the block came back after something else
            }
            previous = Some(&value.block);
        }
        for block in &used {
            if !self.peripherals.contains_key(block) {
                let peripheral = Peripheral::named(block.clone());
                self.peripherals.insert(block.clone(), Arc::new(peripheral));
            }
        }
        let unused: Vec<Arc<str>> = self.peripherals.keys().filter(|name| !used.contains(*name)).cloned().collect();
        for name in unused {
            self.peripherals.remove(&name);
        }
        if contiguous {
            return false;
        }
        // one pass to collect each peripheral's values, one to place them
        let mut members: std::collections::HashMap<Arc<str>, Vec<Arc<Value>>> = std::collections::HashMap::new();
        for value in &self.values {
            if !value.block.is_empty() {
                members.entry(value.block.clone()).or_default().push(value.clone());
            }
        }
        let mut out = Vector::new();
        for value in &self.values {
            if value.block.is_empty() {
                out.push_back(value.clone());
            } else if let Some(list) = members.remove(&value.block) {
                out.extend(list);
            }
        }
        self.values = out;
        true
    }

    /// Where the next register of a block goes: after the end of the last
    /// one, aligned to 4 bytes (the web app's nextOffset).
    pub fn next_offset(&self, block: &str) -> u64 {
        let end = self
            .values
            .iter()
            .filter(|value| &*value.block == block)
            .filter_map(|value| value.offset.map(|offset| offset + value.width.div_ceil(8) as u64))
            .max()
            .unwrap_or(0);
        end.div_ceil(4) * 4
    }

    /// Moves a peripheral's block (all its values) up or down past the next
    /// loose value or block. False when it can't move further.
    pub fn move_block(&mut self, block: &str, direction: isize) -> bool {
        // the top-level units: a loose value, or a whole block
        let mut units: Vec<Vec<Arc<Value>>> = Vec::new();
        for value in &self.values {
            let joins = !value.block.is_empty() && units.last().is_some_and(|unit| unit[0].block == value.block);
            if joins {
                units.last_mut().unwrap().push(value.clone());
            } else {
                units.push(vec![value.clone()]);
            }
        }
        let Some(index) = units.iter().position(|unit| &*unit[0].block == block) else { return false };
        let Some(target) = index.checked_add_signed(direction).filter(|target| *target < units.len()) else { return false };
        units.swap(index, target);
        self.values = units.into_iter().flatten().collect();
        true
    }

    /// Moves the value at `from` to position `to` (counted without it), as a
    /// drag does: a register stays within its peripheral, and a loose value
    /// never lands between two registers of one (the web app's moveItem).
    /// False when nothing moved.
    pub fn move_value_to(&mut self, from: usize, to: usize) -> bool {
        if from >= self.values.len() {
            return false;
        }
        let mut rest: Vec<Arc<Value>> = self.values.iter().cloned().collect();
        let item = rest.remove(from);
        let mut destination = to.min(rest.len());
        let block = item.block.clone();
        let siblings: Vec<usize> =
            if block.is_empty() { Vec::new() } else { rest.iter().enumerate().filter(|(_, other)| other.block == block).map(|(index, _)| index).collect() };
        if let (Some(&first), Some(&last)) = (siblings.first(), siblings.last()) {
            destination = destination.clamp(first, last + 1);
        } else if destination > 0 && destination < rest.len() {
            // not between two registers of one peripheral: jump to the edge of
            // it that lies in the direction of the move
            let run = rest[destination - 1].block.clone();
            if !run.is_empty() && rest[destination].block == run {
                if to < from {
                    while destination > 0 && rest[destination - 1].block == run {
                        destination -= 1;
                    }
                } else {
                    while destination < rest.len() && rest[destination].block == run {
                        destination += 1;
                    }
                }
            }
        }
        rest.insert(destination, item);
        let moved = rest.iter().zip(self.values.iter()).any(|(a, b)| !Arc::ptr_eq(a, b));
        if moved {
            self.values = rest.into_iter().collect();
        }
        moved
    }

    /// A peripheral name that isn't taken yet: "UART0", then "UART0 (2)"…
    pub fn free_peripheral_name(&self, name: &str) -> String {
        let mut candidate = name.to_string();
        let mut suffix = 2;
        while self.peripherals.contains_key(candidate.as_str()) {
            candidate = format!("{name} ({suffix})");
            suffix += 1;
        }
        candidate
    }

    /// True when both hold the same workspace. Unchanged values are the same
    /// shared value, so this is fast for undo states.
    pub fn same_as(&self, other: &WorkspaceState) -> bool {
        self.values.len() == other.values.len()
            && self.values.iter().zip(other.values.iter()).all(|(first, second)| Arc::ptr_eq(first, second) || first == second)
            && self.used_peripherals() == other.used_peripherals()
    }
}

/// A workspace file, read and checked.
pub struct WorkspaceFile {
    pub version: u64,
    pub state: WorkspaceState,
}

/// Reads and checks a workspace file (`{ app: "bitviewer", version, values,
/// peripherals }`). Everything is checked first, so a broken file never
/// half-replaces the open workspace.
pub fn parse_workspace_file(text: &str) -> Result<WorkspaceFile, ModelError> {
    let invalid = |error: serde_json::Error| ModelError::new(format!("This file isn't valid JSON ({error})"));
    // The top level is read first with each value left as text, so the
    // values (nearly all of a big file) can be read on every core.
    let top: Map<String, Json> = match serde_json::from_str::<std::collections::HashMap<&str, &RawValue>>(text) {
        Ok(raw) => {
            let mut top = Map::new();
            for (key, raw) in &raw {
                if *key != "values" {
                    top.insert((*key).to_string(), serde_json::from_str(raw.get()).map_err(invalid)?);
                }
            }
            if let Some(values) = raw.get("values") {
                if let Ok(list) = serde_json::from_str::<Vec<&RawValue>>(values.get()) {
                    if top.get("app").and_then(Json::as_str) != Some("bitviewer") {
                        return Err(ModelError::new("This is not a Bit Viewer workspace file"));
                    }
                    let version = file_version(top.get("version"))?;
                    let values = read_values(&list)?;
                    let state = state_with(values, top.get("peripherals"), &mut TextPool::default())?;
                    return Ok(WorkspaceFile { version, state });
                }
                top.insert("values".into(), serde_json::from_str(values.get()).map_err(invalid)?);
            }
            top
        }
        // not an object: reading it whole gives the right message
        Err(_) => match serde_json::from_str::<Json>(text).map_err(invalid)? {
            Json::Object(top) => top,
            _ => return Err(ModelError::new("This is not a Bit Viewer workspace file")),
        },
    };
    let data = Json::Object(top);
    if data.get("app").and_then(Json::as_str) != Some("bitviewer") {
        return Err(ModelError::new("This is not a Bit Viewer workspace file"));
    }
    let version = file_version(data.get("version"))?;
    let empty = Vec::new();
    let values = match data.get("values") {
        None | Some(Json::Null) => &empty,
        Some(Json::Array(values)) => values,
        Some(_) => return Err(ModelError::new("The file's values aren't a list")),
    };

    let mut pool = TextPool::default();
    let state = read_state(values, data.get("peripherals"), &mut pool)?;
    Ok(WorkspaceFile { version, state })
}

/// Reads values given as JSON text, on every core. Each batch interns its
/// own repeated texts; the first problem in file order is reported.
fn read_values(list: &[&RawValue]) -> Result<Vec<Arc<Value>>, ModelError> {
    use rayon::prelude::*;
    let batches: Vec<Result<Vec<Arc<Value>>, ModelError>> = list
        .par_chunks(1024)
        .map(|chunk| {
            let mut pool = TextPool::default();
            chunk
                .iter()
                .map(|raw| {
                    let json: Json = serde_json::from_str(raw.get()).map_err(|error| ModelError::new(format!("This file isn't valid JSON ({error})")))?;
                    value_from_json(&json, &mut pool).map(Arc::new)
                })
                .collect()
        })
        .collect();
    let mut values = Vec::with_capacity(list.len());
    for batch in batches {
        values.extend(batch?);
    }
    Ok(values)
}

fn file_version(version: Option<&Json>) -> Result<u64, ModelError> {
    match version {
        None | Some(Json::Null) => Ok(1),
        Some(Json::Number(number)) if number.as_u64().is_some_and(|v| v >= 1) => Ok(number.as_u64().unwrap()),
        Some(other) => Err(ModelError::new(format!("Unknown file format version {other}"))),
    }
}

pub fn read_state(values: &[Json], peripherals: Option<&Json>, pool: &mut TextPool) -> Result<WorkspaceState, ModelError> {
    let values = values.iter().map(|json| value_from_json(json, pool).map(Arc::new)).collect::<Result<Vec<_>, _>>()?;
    state_with(values, peripherals, pool)
}

/// A state of `values` and the peripherals read from `peripherals`.
fn state_with(values: Vec<Arc<Value>>, peripherals: Option<&Json>, pool: &mut TextPool) -> Result<WorkspaceState, ModelError> {
    let mut state = WorkspaceState { values: values.into_iter().collect(), ..Default::default() };
    match peripherals {
        None | Some(Json::Null) => {}
        Some(Json::Array(list)) => {
            for json in list {
                let peripheral = peripheral_from_json(json, pool)?;
                state.peripherals.insert(peripheral.name.clone(), Arc::new(peripheral));
            }
        }
        Some(_) => return Err(ModelError::new("The file's peripherals aren't a list")),
    }
    Ok(state)
}

/// The text of a workspace file, laid out as the TypeScript app writes it.
pub fn workspace_file_text(state: &WorkspaceState) -> String {
    let mut out = Map::new();
    out.insert("app".into(), json!("bitviewer"));
    out.insert("version".into(), json!(FILE_VERSION));
    out.insert("values".into(), Json::Array(state.values.iter().map(|value| value_to_json(value)).collect()));
    out.insert("peripherals".into(), Json::Array(state.used_peripherals().iter().map(|p| peripheral_to_json(p)).collect()));
    serde_json::to_string_pretty(&Json::Object(out)).expect("JSON values always serialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peripheral_snapshots_round_trip() {
        let mut pool = TextPool::default();
        let source = json!({ "name": "UART0", "base": "0x40011000", "snapshots": [
            { "name": "working", "at": 1700000000000i64, "values": { "UART0.CTRL": "0x2303", "UART0.BAUD": "0x683" } },
            { "name": "broken", "values": "not a map" }
        ] });
        let peripheral = peripheral_from_json(&source, &mut pool).unwrap();
        assert_eq!(peripheral.snapshots.len(), 1);
        let snapshot = &peripheral.snapshots[0];
        assert_eq!(snapshot.value_of("UART0.BAUD"), Some(Bits::from(0x683u32)));
        assert_eq!(snapshot.value_of("UART0.DATA"), None);
        let again = peripheral_from_json(&peripheral_to_json(&peripheral), &mut pool).unwrap();
        assert_eq!(again, peripheral);
    }

    const SMALL: &str = r##"{
  "app": "bitviewer",
  "version": 1,
  "values": [
    {
      "name": "UART0.CTRL",
      "width": 32,
      "value": "0x301",
      "view": "byte",
      "msb_first": true,
      "full_base": 16,
      "default_row_base": 16,
      "show_bases": false,
      "collapsed": false,
      "snapshots": [],
      "row_bases": {},
      "compares": {},
      "hidden_compares": {},
      "groups": [
        {
          "lo": 0,
          "hi": 0,
          "name": "EN",
          "color": "#f59f00",
          "base": 2
        }
      ],
      "block": "UART0",
      "offset": "0x0"
    }
  ],
  "peripherals": [
    {
      "name": "UART0",
      "base": "0x40001000",
      "description": "Serial port"
    }
  ]
}"##;

    #[test]
    fn writes_files_exactly_as_the_typescript_app() {
        let file = parse_workspace_file(SMALL).unwrap();
        assert_eq!(file.version, 1);
        assert_eq!(file.state.values[0].value, Bits::from(0x301u32));
        assert_eq!(workspace_file_text(&file.state), SMALL);
    }

    /// The 1,540-register STM32F407 workspace written by the TypeScript app
    /// (kept outside git; skipped when it isn't there).
    #[test]
    fn reads_and_rewrites_a_real_workspace_unchanged() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/stm32f407-all.bitview");
        let Ok(text) = std::fs::read_to_string(path) else {
            eprintln!("skipped: {path} not found");
            return;
        };
        let file = parse_workspace_file(&text).unwrap();
        assert_eq!(file.state.len(), 1540);
        assert_eq!(workspace_file_text(&file.state), text);
    }

    #[test]
    fn refuses_files_that_are_not_workspaces() {
        assert!(parse_workspace_file("not json").is_err());
        assert_eq!(parse_workspace_file(r#"{"app":"other"}"#).err().unwrap().to_string(), "This is not a Bit Viewer workspace file");
        assert!(parse_workspace_file(r#"{"app":"bitviewer","version":0}"#).is_err());
        assert!(parse_workspace_file(r#"{"app":"bitviewer","values":{}}"#).is_err());
        assert_eq!(parse_workspace_file(r#"{"app":"bitviewer"}"#).unwrap().state.len(), 0);
        assert_eq!(parse_workspace_file(r#"{"app":"bitviewer","version":7,"values":[]}"#).unwrap().version, 7);
    }

    #[test]
    fn edits_copy_only_the_changed_value() {
        let before = parse_workspace_file(SMALL).unwrap().state;
        let mut after = before.clone();
        assert!(after.edit(0, |value| value.set_value(Bits::from(1u8))));
        assert!(!Arc::ptr_eq(&before.values[0], &after.values[0]));
        assert_eq!(before.values[0].value, Bits::from(0x301u32));
        assert!(!before.same_as(&after));
        assert!(before.same_as(&before.clone()));
    }

    #[test]
    fn tidy_keeps_peripherals_together() {
        let value = |name: &str, block: &str| {
            let mut value = Value::new(8, Bits::ZERO, name, crate::rows::View::Byte, crate::integers::Base::Hex).unwrap();
            value.set_peripheral(block, None);
            Arc::new(value)
        };
        let mut state = WorkspaceState::default();
        for (name, block) in [("a", "P"), ("b", ""), ("c", "Q"), ("d", "P"), ("e", "")] {
            state.values.push_back(value(name, block));
        }
        assert!(state.tidy());
        let names: Vec<&str> = state.values.iter().map(|v| &*v.name).collect();
        assert_eq!(names, ["a", "d", "b", "c", "e"]);
        assert_eq!(state.peripherals.len(), 2);
        assert!(!state.tidy());
        state.values.retain(|v| &*v.block != "Q");
        state.tidy();
        assert_eq!(state.peripherals.len(), 1);
    }

    #[test]
    fn moving_keeps_peripherals_whole() {
        let value = |name: &str, block: &str| {
            let mut value = Value::new(8, Bits::ZERO, name, crate::rows::View::Byte, crate::integers::Base::Hex).unwrap();
            value.set_peripheral(block, None);
            Arc::new(value)
        };
        let names = |state: &WorkspaceState| state.values.iter().map(|v| v.name.to_string()).collect::<Vec<_>>().join(" ");
        let mut state = WorkspaceState::default();
        for (name, block) in [("a", ""), ("p1", "P"), ("p2", "P"), ("b", "")] {
            state.values.push_back(value(name, block));
        }
        // a loose value dropped inside P lands after it (moving down)
        assert!(state.move_value_to(0, 1));
        assert_eq!(names(&state), "p1 p2 a b");
        // a register stays in its peripheral
        assert!(state.move_value_to(0, 3));
        assert_eq!(names(&state), "p2 p1 a b");
        assert!(!state.move_value_to(3, 3));
        // whole blocks move past neighbours
        assert!(state.move_block("P", 1));
        assert_eq!(names(&state), "a p2 p1 b");
        assert_eq!(state.next_offset("P"), 0);
    }
}
