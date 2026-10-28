//! Evaluating an integer expression for a width, and its preview line, as
//! the web app's ui/expr-field.ts: "= 0x0000_001F · 31 · note".

use std::collections::{BTreeSet, HashMap};

use crate::kit::*;
use bitviewer_core::expr::{eval_int, names_in, parse_expr};
use bitviewer_core::field::wrap_big;
use bitviewer_core::integers::{Base, Bits, format_int};
use num_bigint::{BigInt, Sign};

use crate::theme;
use crate::widgets::r;

/// A result fitted into the width, with a note when it had to be.
#[derive(Clone, Debug, PartialEq)]
pub struct Fitted {
    pub value: Bits,
    pub note: String,
}

pub fn to_big(bits: Bits) -> BigInt {
    BigInt::from_bytes_le(Sign::Plus, &bits.to_le_bytes::<64>())
}

/// The names `text` uses (empty when it doesn't parse).
pub fn names(text: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    if let Ok(expression) = parse_expr(text) {
        names_in(&expression, &mut names);
    }
    names
}

/// Evaluates `text` with the `known` names and fits it into `width` bits.
pub fn evaluate_for(text: &str, width: usize, known: &HashMap<String, BigInt>) -> Result<Fitted, String> {
    let expression = parse_expr(text).map_err(|error| error.0)?;
    let raw = eval_int(&expression, &|name: &str| known.get(name).cloned()).map_err(|error| error.0)?;
    let value = wrap_big(&raw, width);
    let limit = BigInt::from(1u8) << width;
    let note = if raw.sign() == Sign::Minus {
        if raw >= -(BigInt::from(1u8) << (width - 1)) { "negative: stored as two's complement".to_string() } else { format!("wrapped to {width} bits") }
    } else if raw >= limit {
        format!("truncated to {width} bits")
    } else {
        String::new()
    };
    Ok(Fitted { value, note })
}

/// The preview under an expression field.
pub fn preview(result: Option<&Result<Fitted, String>>, width: usize) -> Div {
    let palette = theme::current();
    let line = div().flex().flex_wrap().min_h(r(18.0)).font_family(theme::mono()).text_size(r(12.5)).text_color(palette.text);
    match result {
        None => line.child(div().text_color(palette.muted).child("Result appears here")),
        Some(Err(error)) => line.child(div().font_family(theme::ui()).text_color(palette.error).child(error.clone())),
        Some(Ok(fitted)) => line
            .child(div().text_color(palette.accent).font_weight(FontWeight::BOLD).child("= "))
            .child(format_int(fitted.value, Base::Hex, width, true, true))
            .child(div().text_color(palette.muted).child(format!(" · {}", fitted.value)))
            .when(!fitted.note.is_empty(), |line| line.child(div().text_color(palette.select).child(format!(" · {}", fitted.note)))),
    }
}

use crate::kit::prelude::FluentBuilder as _;
