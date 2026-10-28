//! The native SVD reader against the web app's: the golden file holds what
//! the web app reads from the same sample (tests/unit/export-golden.test.ts).
#![recursion_limit = "512"]

use bitviewer_core::field::Access;
use bitviewer_core::svd::{parse_svd, register_template};
use num_bigint::BigInt;
use serde_json::{Value as Json, json};

fn hex(value: &BigInt) -> String {
    format!("0x{}", value.to_str_radix(16))
}

#[test]
fn matches_the_web_app() {
    let device = parse_svd(include_str!("fixtures/sample.svd")).unwrap();
    let golden: Json = serde_json::from_str(include_str!("fixtures/svd-golden.json")).unwrap();
    let out = json!({
        "name": device.name,
        "description": device.description,
        "warnings": device.warnings,
        "peripherals": device.peripherals.iter().map(|peripheral| json!({
            "name": peripheral.name,
            "description": peripheral.description,
            "groupName": peripheral.group_name,
            "baseAddress": hex(&peripheral.base_address),
            "count": peripheral.count,
            "registers": peripheral.registers.iter().map(|array| json!({
                "label": array.label,
                "description": array.description,
                "size": array.size,
                "count": array.count,
                "copies": (0..array.count).map(|position| {
                    let register = array.at(position);
                    let template = register_template(&register, &device.name);
                    json!({
                        "path": register.path,
                        "name": register.name,
                        "peripheral": register.peripheral,
                        "peripheralBase": hex(&register.peripheral_base),
                        "address": hex(&register.address),
                        "access": register.access,
                        "resetValue": hex(&register.reset_value),
                        "warnings": *register.warnings,
                        "order": register.order,
                        "fields": register.fields.iter().map(|field| json!({
                            "name": field.name,
                            "description": field.description,
                            "lsb": field.lsb,
                            "msb": field.msb,
                            "access": field.access,
                            "enums": field.enums.iter().map(|item| json!([hex(&item.value), item.name, item.description])).collect::<Vec<_>>(),
                        })).collect::<Vec<_>>(),
                        "template": {
                            "name": template.name,
                            "width": template.width,
                            "description": template.description.unwrap_or_default(),
                            "fields": template.fields.iter().map(|field| json!({
                                "lo": field.lo,
                                "hi": field.hi,
                                "name": field.name,
                                "color": field.color.clone().unwrap_or_default(),
                                "description": field.details.description.as_deref().unwrap_or(""),
                                "access": match field.details.access { Some(Access::ReadOnly) => "ro", Some(Access::Reserved) => "reserved", _ => "rw" },
                                "named": field.details.named.clone().unwrap_or_default().iter().map(|(value, label)| json!([value.to_string(), &**label])).collect::<Vec<_>>(),
                            })).collect::<Vec<_>>(),
                        },
                    })
                }).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    });
    if out != golden {
        let pretty = |value: &Json| serde_json::to_string_pretty(value).unwrap();
        let (a, b) = (pretty(&golden), pretty(&out));
        let line = a.lines().zip(b.lines()).position(|(x, y)| x != y).unwrap_or(0);
        panic!("differs at line {}:\n  web:    {:?}\n  native: {:?}", line + 1, a.lines().nth(line), b.lines().nth(line));
    }
}
