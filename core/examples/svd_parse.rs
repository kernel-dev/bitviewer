//! Times reading a CMSIS-SVD file: cargo run --release --example svd_parse -- FILE
fn main() {
    let path = std::env::args().nth(1).expect("an SVD file");
    let started = std::time::Instant::now();
    let text = std::fs::read_to_string(&path).unwrap();
    let read = started.elapsed();
    let root = bitviewer_core::svd::parse_xml(&text).unwrap();
    let xml = started.elapsed();
    drop(root);
    let device = bitviewer_core::svd::parse_svd(&text).unwrap();
    let parsed = started.elapsed();
    let registers: usize = device.peripherals.iter().flat_map(|p| p.registers.iter()).map(|a| a.count).sum();
    println!("read {read:?}, xml {:?}, device {:?}; {} peripherals, {registers} registers", xml - read, parsed - xml, device.peripherals.len());
}
