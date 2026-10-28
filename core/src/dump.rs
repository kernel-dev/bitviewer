//! Memory dumps: a block of memory read from a chip, as a binary file, an
//! Intel HEX or Motorola S-record file, or text a debugger printed (GDB's
//! `x/4xw`, OpenOCD's `mdw`, or plain `ADDR: WORD WORD …` lines). The bytes
//! are matched against the workspace's register addresses.

use std::sync::Arc;

use crate::ModelError;
use crate::integers::{Bits, mask};
use crate::workspace::WorkspaceState;

/// Bytes at addresses, kept as sorted runs that don't touch each other.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Memory {
    runs: Vec<(u64, Vec<u8>)>,
}

impl Memory {
    /// Adds `bytes` at `address` (later bytes win where they overlap).
    pub fn put(&mut self, address: u64, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.runs.push((address, bytes.to_vec()));
        self.runs.sort_by_key(|(start, _)| *start);
        // merge runs that overlap or touch
        let mut merged: Vec<(u64, Vec<u8>)> = Vec::with_capacity(self.runs.len());
        for (start, data) in std::mem::take(&mut self.runs) {
            if let Some((last_start, last)) = merged.last_mut() {
                let last_end = *last_start + last.len() as u64;
                if start <= last_end {
                    let at = (start - *last_start) as usize;
                    let end = at + data.len();
                    if last.len() < end {
                        last.resize(end, 0);
                    }
                    last[at..end].copy_from_slice(&data);
                    continue;
                }
            }
            merged.push((start, data));
        }
        self.runs = merged;
    }

    /// `len` bytes from `address`, if all of them are in the dump.
    pub fn read(&self, address: u64, len: usize) -> Option<&[u8]> {
        let index = self.runs.partition_point(|(start, _)| *start <= address).checked_sub(1)?;
        let (start, data) = &self.runs[index];
        let at = (address - start) as usize;
        data.get(at..at.checked_add(len)?)
    }

    /// Whether any byte of [address, address + len) is in the dump.
    pub fn touches(&self, address: u64, len: usize) -> bool {
        let end = address.saturating_add(len as u64);
        self.runs.iter().any(|(start, data)| *start < end && address < start + data.len() as u64)
    }

    pub fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }

    /// The number of bytes, and the lowest and highest address.
    pub fn span(&self) -> Option<(usize, u64, u64)> {
        let first = self.runs.first()?;
        let last = self.runs.last()?;
        let bytes = self.runs.iter().map(|(_, data)| data.len()).sum();
        Some((bytes, first.0, last.0 + last.1.len() as u64 - 1))
    }
}

/// What a dump was read as (shown to the user).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Binary,
    IntelHex,
    SRecord,
    /// Debugger output: address, then numbers.
    Text,
}

impl Format {
    pub fn describe(self) -> &'static str {
        match self {
            Format::Binary => "binary",
            Format::IntelHex => "Intel HEX",
            Format::SRecord => "Motorola S-record",
            Format::Text => "debugger output",
        }
    }
}

/// Reads a dump. Text formats are recognised from their content; anything
/// that isn't text is binary, placed at `start`. In debugger output each
/// number is a word as wide as its digits (2 = byte, 4, 8, 16), stored in
/// memory in `little_endian` order.
pub fn read_dump(data: &[u8], start: u64, little_endian: bool) -> Result<(Memory, Format), ModelError> {
    let text = std::str::from_utf8(data).ok().filter(|text| !text.contains('\0'));
    let Some(text) = text else {
        let mut memory = Memory::default();
        memory.put(start, data);
        return Ok((memory, Format::Binary));
    };
    let first = text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
    if first.starts_with(':') {
        return Ok((intel_hex(text)?, Format::IntelHex));
    }
    if first.len() > 1 && first.starts_with(['S', 's']) && first.as_bytes()[1].is_ascii_digit() {
        return Ok((s_record(text)?, Format::SRecord));
    }
    Ok((debugger_text(text, little_endian)?, Format::Text))
}

fn hex_bytes(text: &str, line: usize) -> Result<Vec<u8>, ModelError> {
    if !text.len().is_multiple_of(2) || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ModelError::new(format!("Line {line}: not hex digits")));
    }
    Ok((0..text.len()).step_by(2).map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap()).collect())
}

fn intel_hex(text: &str) -> Result<Memory, ModelError> {
    let mut memory = Memory::default();
    let mut upper: u64 = 0;
    for (index, line) in text.lines().enumerate().map(|(i, l)| (i + 1, l.trim())) {
        if line.is_empty() {
            continue;
        }
        let Some(record) = line.strip_prefix(':') else {
            return Err(ModelError::new(format!("Line {index}: an Intel HEX record starts with “:”")));
        };
        let bytes = hex_bytes(record, index)?;
        if bytes.len() < 5 || bytes.len() != bytes[0] as usize + 5 {
            return Err(ModelError::new(format!("Line {index}: the record's length is wrong")));
        }
        if bytes.iter().fold(0u8, |sum, byte| sum.wrapping_add(*byte)) != 0 {
            return Err(ModelError::new(format!("Line {index}: wrong checksum")));
        }
        let address = u64::from(u16::from_be_bytes([bytes[1], bytes[2]]));
        let data = &bytes[4..bytes.len() - 1];
        match bytes[3] {
            0x00 => memory.put(upper + address, data),
            0x01 => break,
            0x02 if data.len() == 2 => upper = u64::from(u16::from_be_bytes([data[0], data[1]])) << 4,
            0x04 if data.len() == 2 => upper = u64::from(u16::from_be_bytes([data[0], data[1]])) << 16,
            0x03 | 0x05 => {}
            kind => return Err(ModelError::new(format!("Line {index}: unknown record type {kind:02X}"))),
        }
    }
    Ok(memory)
}

fn s_record(text: &str) -> Result<Memory, ModelError> {
    let mut memory = Memory::default();
    for (index, line) in text.lines().enumerate().map(|(i, l)| (i + 1, l.trim())) {
        if line.is_empty() {
            continue;
        }
        let kind = line.as_bytes().get(1).copied().unwrap_or(b'?');
        if !line.starts_with(['S', 's']) {
            return Err(ModelError::new(format!("Line {index}: an S-record starts with “S”")));
        }
        let bytes = hex_bytes(&line[2..], index)?;
        if bytes.is_empty() || bytes.len() != bytes[0] as usize + 1 {
            return Err(ModelError::new(format!("Line {index}: the record's length is wrong")));
        }
        if bytes.iter().fold(0u8, |sum, byte| sum.wrapping_add(*byte)) != 0xFF {
            return Err(ModelError::new(format!("Line {index}: wrong checksum")));
        }
        let address_len = match kind {
            b'1' => 2,
            b'2' => 3,
            b'3' => 4,
            b'0' | b'5' | b'6' | b'7' | b'8' | b'9' => continue,
            _ => return Err(ModelError::new(format!("Line {index}: unknown record type S{}", kind as char))),
        };
        if bytes.len() < 1 + address_len + 1 {
            return Err(ModelError::new(format!("Line {index}: the record is too short")));
        }
        let address = bytes[1..=address_len].iter().fold(0u64, |acc, byte| (acc << 8) | u64::from(*byte));
        memory.put(address, &bytes[1 + address_len..bytes.len() - 1]);
    }
    Ok(memory)
}

/// A number written in hex, with or without 0x.
fn hex_number(token: &str) -> Option<(u64, usize)> {
    let digits = token.strip_prefix("0x").or_else(|| token.strip_prefix("0X")).unwrap_or(token).replace('_', "");
    if digits.is_empty() || digits.len() > 16 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some((u64::from_str_radix(&digits, 16).ok()?, digits.len()))
}

fn debugger_text(text: &str, little_endian: bool) -> Result<Memory, ModelError> {
    let mut memory = Memory::default();
    let mut lines_read = 0;
    for (index, line) in text.lines().enumerate().map(|(i, l)| (i + 1, l.trim())) {
        // "(gdb) x/4xw 0x…" and other prompts carry no data
        if line.is_empty() || line.starts_with('(') || line.starts_with('>') || line.starts_with('#') {
            continue;
        }
        // the address ends at the first ":" ("0x40004400 <USART2>:" too)
        let Some((head, rest)) = line.split_once(':') else { continue };
        let Some(address_token) = head.split_whitespace().next() else { continue };
        let Some((address, _)) = hex_number(address_token) else { continue };
        let mut at = address;
        for token in rest.split_whitespace() {
            let Some((number, digits)) = hex_number(token) else {
                // text after the numbers (an ASCII column) ends the line
                break;
            };
            let size = match digits {
                1 | 2 => 1,
                3 | 4 => 2,
                5..=8 => 4,
                _ => 8,
            };
            let bytes = number.to_le_bytes();
            let mut word = bytes[..size].to_vec();
            if !little_endian {
                word.reverse();
            }
            memory.put(at, &word);
            at += size as u64;
        }
        if at == address {
            return Err(ModelError::new(format!("Line {index}: no numbers after the address")));
        }
        lines_read += 1;
    }
    if lines_read == 0 {
        return Err(ModelError::new("No memory found: expected lines such as “0x40004400: 0x000000C0 0x00000041”"));
    }
    Ok(memory)
}

/// A register found in a dump.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub value_index: usize,
    pub name: Arc<str>,
    pub address: u64,
    pub now: Bits,
    pub dumped: Bits,
}

/// What a dump means for a workspace.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Matches {
    pub found: Vec<Found>,
    /// Registers only partly in the dump (left as they are).
    pub partial: Vec<Arc<str>>,
    /// Values with no address (no peripheral base address or no offset).
    pub without_address: usize,
}

/// The registers whose bytes are in `memory`.
pub fn match_registers(state: &WorkspaceState, memory: &Memory, little_endian: bool) -> Matches {
    let mut out = Matches::default();
    for (index, value) in state.values.iter().enumerate() {
        let base = state.peripherals.get(&value.block).and_then(|peripheral| peripheral.base);
        let Some(address) = base.zip(value.offset).and_then(|(base, offset)| base.checked_add(offset)) else {
            out.without_address += 1;
            continue;
        };
        let len = value.width.div_ceil(8);
        match memory.read(address, len) {
            Some(bytes) => {
                let mut bytes = bytes.to_vec();
                if !little_endian {
                    bytes.reverse();
                }
                bytes.resize(64, 0);
                let dumped = Bits::from_le_slice(&bytes) & mask(value.width);
                out.found.push(Found { value_index: index, name: value.name.clone(), address, now: value.value, dumped });
            }
            None if memory.touches(address, len) => out.partial.push(value.name.clone()),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integers::Base;
    use crate::rows::View;
    use crate::value::Value;
    use crate::workspace::Peripheral;

    fn workspace() -> WorkspaceState {
        let mut state = WorkspaceState::default();
        for (name, offset, width) in [("USART2.SR", 0, 32), ("USART2.DR", 4, 32), ("USART2.BRR", 8, 16), ("USART2.CR1", 0xC, 32), ("LOOSE", 0, 8)] {
            let mut value = Value::new(width, Bits::ZERO, name, View::Line, Base::Hex).unwrap();
            if name != "LOOSE" {
                value.set_peripheral("USART2", Some(offset));
            }
            state.values.push_back(Arc::new(value));
        }
        let peripheral = Peripheral { base: Some(0x4000_4400), ..Peripheral::named("USART2".into()) };
        state.peripherals.insert("USART2".into(), Arc::new(peripheral));
        state
    }

    fn found(matches: &Matches) -> Vec<(&str, u64)> {
        matches.found.iter().map(|found| (&*found.name, found.dumped.to::<u64>())).collect()
    }

    #[test]
    fn reads_gdb_and_openocd_output() {
        let gdb = "(gdb) x/4xw 0x40004400\n0x40004400 <USART2>:\t0x000000c0\t0x00000041\t0x00000683\t0x0000200c\n";
        let (memory, format) = read_dump(gdb.as_bytes(), 0, true).unwrap();
        assert_eq!(format, Format::Text);
        let matches = match_registers(&workspace(), &memory, true);
        assert_eq!(found(&matches), [("USART2.SR", 0xC0), ("USART2.DR", 0x41), ("USART2.BRR", 0x683), ("USART2.CR1", 0x200C)]);
        assert_eq!(matches.without_address, 1);

        // OpenOCD: no 0x; bytes (2 digits) build the words in memory order
        let openocd = "0x40004408: 83 06 00 00\n";
        let (memory, _) = read_dump(openocd.as_bytes(), 0, true).unwrap();
        let matches = match_registers(&workspace(), &memory, true);
        assert_eq!(found(&matches), [("USART2.BRR", 0x683)]);
        assert!(matches.partial.is_empty());

        // half of CR1 only
        let (memory, _) = read_dump(b"0x4000440C: 0x200C\n", 0, true).unwrap();
        let matches = match_registers(&workspace(), &memory, true);
        assert!(matches.found.is_empty());
        assert_eq!(matches.partial, [Arc::<str>::from("USART2.CR1")]);

        assert!(read_dump(b"hello\n", 0, true).is_err());
    }

    #[test]
    fn reads_binary_at_an_address_in_either_byte_order() {
        let bytes = [0xC0, 0, 0, 0, 0x41, 0, 0, 0, 0x83, 0x06, 0xFF, 0xFF, 0xAA];
        let (memory, format) = read_dump(&bytes, 0x4000_4400, true).unwrap();
        assert_eq!(format, Format::Binary);
        assert_eq!(memory.span(), Some((13, 0x4000_4400, 0x4000_440C)));
        let matches = match_registers(&workspace(), &memory, true);
        assert_eq!(found(&matches), [("USART2.SR", 0xC0), ("USART2.DR", 0x41), ("USART2.BRR", 0x683)]);
        assert_eq!(matches.partial, [Arc::<str>::from("USART2.CR1")]);
        let big = match_registers(&workspace(), &memory, false);
        assert_eq!(found(&big)[0], ("USART2.SR", 0xC000_0000));
    }

    #[test]
    fn reads_intel_hex_and_s_records() {
        // 4 bytes at 0x4000_4408 via an extended linear address record
        let ihex = ":020000044000BA\n:044408008306000027\n:00000001FF\n";
        let (memory, format) = read_dump(ihex.as_bytes(), 0, true).unwrap();
        assert_eq!(format, Format::IntelHex);
        assert_eq!(found(&match_registers(&workspace(), &memory, true)), [("USART2.BRR", 0x683)]);
        assert!(read_dump(b":044408008306000028\n", 0, true).unwrap_err().0.contains("checksum"));

        let srec = "S0030000FC\nS3094000440883060000E1\nS70500000000FA\n";
        let (memory, format) = read_dump(srec.as_bytes(), 0, true).unwrap();
        assert_eq!(format, Format::SRecord);
        assert_eq!(found(&match_registers(&workspace(), &memory, true)), [("USART2.BRR", 0x683)]);
    }

    #[test]
    fn memory_merges_runs() {
        let mut memory = Memory::default();
        memory.put(10, &[1, 2]);
        memory.put(12, &[3]);
        memory.put(11, &[9]);
        assert_eq!(memory.read(10, 3), Some(&[1, 9, 3][..]));
        assert_eq!(memory.read(9, 2), None);
        assert!(memory.touches(9, 2));
        assert!(!memory.touches(13, 4));
    }
}
