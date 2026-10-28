//! A small expression language, parsed by hand (no eval):
//!
//!   numbers   42  0x2A  0b101010  0o52  1_000  (and 1.5 / 2e-3 in real mode)
//!   names     CTRL  x  {Value 1}  `Value 1`   (braces/backticks allow spaces)
//!   operators ( )  unary - + ~ !  **  * / %  + -  << >>  &  ^  |
//!   calls     min(a, b)  max  abs  bit(n)  mask(n)  popcount(x)
//!             real mode also: round floor ceil sqrt pow log log2 log10 exp
//!
//! Integer mode works on BigInt (exact at any width); real mode on f64, used
//! for field unit formulas such as `x * 0.5 - 40`. Binary operators use
//! precedence climbing; ** binds tightest and groups to the right.

mod integer;
mod real;

use std::collections::BTreeSet;

use num_bigint::BigInt;
use num_traits::{Num, ToPrimitive};

pub use integer::eval_int;
pub use real::{eval_real, linearity};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExprError(pub String);

impl ExprError {
    pub fn new(message: impl Into<String>) -> Self {
        ExprError(message.into())
    }
}

impl std::fmt::Display for ExprError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ExprError {}

#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    /// A number; `integer` is None for ones like 1.5 that aren't whole.
    Num {
        integer: Option<BigInt>,
        real: f64,
        text: String,
    },
    Name(String),
    Unary(char, Box<Expr>),
    Binary(&'static str, Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
}

#[derive(Clone, Debug, PartialEq)]
enum TokenKind {
    Num,
    Name,
    Op,
    End,
}

#[derive(Clone, Debug)]
struct Token {
    kind: TokenKind,
    text: String,
    /// Character position, for messages.
    position: usize,
}

const BINARY: [(&str, u8); 10] = [("|", 1), ("^", 2), ("&", 3), ("<<", 4), (">>", 4), ("+", 5), ("-", 5), ("*", 6), ("/", 6), ("%", 6)];

fn precedence(op: &str) -> Option<(&'static str, u8)> {
    BINARY.iter().find(|(text, _)| *text == op).copied()
}

/// The longest number at the start of `chars`: 0x…, 0b…, 0o… or decimal
/// with an optional fraction and exponent (underscores allowed).
fn number_length(chars: &[char]) -> usize {
    let lower = |i: usize| chars.get(i).map(|c| c.to_ascii_lowercase());
    if chars.first() == Some(&'0') {
        let digits: Option<fn(char) -> bool> = match lower(1) {
            Some('x') => Some(|c| c.is_ascii_hexdigit() || c == '_'),
            Some('b') => Some(|c| c == '0' || c == '1' || c == '_'),
            Some('o') => Some(|c| ('0'..='7').contains(&c) || c == '_'),
            _ => None,
        };
        if let Some(digits) = digits {
            let run = chars[2..].iter().take_while(|c| digits(**c)).count();
            if run > 0 {
                return 2 + run;
            }
        }
    }
    let digit = |c: &char| c.is_ascii_digit() || *c == '_';
    let mut i;
    if chars.first().is_some_and(char::is_ascii_digit) {
        i = 1 + chars[1..].iter().take_while(|c| digit(c)).count();
        if chars.get(i) == Some(&'.') {
            i += 1;
            i += chars[i..].iter().take_while(|c| digit(c)).count();
        }
    } else if chars.first() == Some(&'.') && chars.get(1).is_some_and(char::is_ascii_digit) {
        i = 2 + chars[2..].iter().take_while(|c| digit(c)).count();
    } else {
        return 0;
    }
    // exponent: e, optional sign, digits
    if matches!(lower(i), Some('e')) {
        let mut j = i + 1;
        if matches!(chars.get(j), Some('+' | '-')) {
            j += 1;
        }
        let run = chars[j.min(chars.len())..].iter().take_while(|c| c.is_ascii_digit()).count();
        if run > 0 {
            i = j + run;
        }
    }
    i
}

fn tokenize(source: &str) -> Result<Vec<Token>, ExprError> {
    let chars: Vec<char> = source.chars().collect();
    let mut out = Vec::new();
    let mut cursor = 0;
    while cursor < chars.len() {
        let character = chars[cursor];
        if character.is_whitespace() {
            cursor += 1;
            continue;
        }
        let start = cursor;

        if character == '{' || character == '`' {
            let close = if character == '{' { '}' } else { '`' };
            let Some(end) = chars[cursor + 1..].iter().position(|c| *c == close) else {
                return Err(ExprError::new(format!("Missing {close} for the name at position {}", cursor + 1)));
            };
            let name: String = chars[cursor + 1..cursor + 1 + end].iter().collect();
            out.push(Token { kind: TokenKind::Name, text: name.trim().to_string(), position: start });
            cursor += end + 2;
            continue;
        }

        if character.is_ascii_digit() || character == '.' {
            let length = number_length(&chars[cursor..]);
            if length > 0 {
                out.push(Token { kind: TokenKind::Num, text: chars[cursor..cursor + length].iter().collect(), position: start });
                cursor += length;
                continue;
            }
        }

        if character.is_ascii_alphabetic() || character == '_' {
            let length = chars[cursor..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == '_' || **c == '.').count();
            out.push(Token { kind: TokenKind::Name, text: chars[cursor..cursor + length].iter().collect(), position: start });
            cursor += length;
            continue;
        }

        let two: String = chars[cursor..(cursor + 2).min(chars.len())].iter().collect();
        if matches!(two.as_str(), "**" | "<<" | ">>") {
            out.push(Token { kind: TokenKind::Op, text: two, position: start });
            cursor += 2;
            continue;
        }

        if "+-*/%&|^~!(),".contains(character) {
            out.push(Token { kind: TokenKind::Op, text: character.to_string(), position: start });
            cursor += 1;
            continue;
        }

        return Err(ExprError::new(format!("Unexpected \"{character}\" at position {}", cursor + 1)));
    }
    out.push(Token { kind: TokenKind::End, text: String::new(), position: chars.len() });
    Ok(out)
}

fn number_node(text: &str) -> Result<Expr, ExprError> {
    let cleaned = text.replace('_', "").to_lowercase();
    for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] {
        if let Some(digits) = cleaned.strip_prefix(prefix) {
            if digits.is_empty() {
                return Err(ExprError::new(format!("\"{text}\" needs digits after the prefix")));
            }
            let value = BigInt::from_str_radix(digits, radix).map_err(|_| ExprError::new(format!("\"{text}\" is not a number")))?;
            let real = value.to_f64().unwrap_or(f64::INFINITY);
            return Ok(Expr::Num { integer: Some(value), real, text: text.into() });
        }
    }
    if cleaned.contains(['.', 'e']) {
        let real: f64 = cleaned.parse().map_err(|_| ExprError::new(format!("\"{text}\" is not a number")))?;
        let integer = (real.fract() == 0.0 && real.abs() < 2f64.powi(53)).then(|| BigInt::from(real as i64));
        return Ok(Expr::Num { integer, real, text: text.into() });
    }
    let value = BigInt::from_str_radix(&cleaned, 10).map_err(|_| ExprError::new(format!("\"{text}\" is not a number")))?;
    let real = value.to_f64().unwrap_or(f64::INFINITY);
    Ok(Expr::Num { integer: Some(value), real, text: text.into() })
}

struct Parser {
    tokens: Vec<Token>,
    position: usize,
}

impl Parser {
    fn peek(&self) -> &Token {
        &self.tokens[self.position]
    }

    fn next(&mut self) -> Token {
        let token = self.tokens[self.position].clone();
        if self.position < self.tokens.len() - 1 {
            self.position += 1;
        }
        token
    }

    fn expect(&mut self, expected: &str) -> Result<(), ExprError> {
        let token = self.next();
        if token.text == expected {
            return Ok(());
        }
        Err(ExprError::new(if token.kind == TokenKind::End {
            format!("Missing \"{expected}\"")
        } else {
            format!("Expected \"{expected}\" at position {}", token.position + 1)
        }))
    }

    fn primary(&mut self) -> Result<Expr, ExprError> {
        let token = self.next();
        match token.kind {
            TokenKind::Num => number_node(&token.text),
            TokenKind::Name => {
                if self.peek().text == "(" && self.peek().kind == TokenKind::Op {
                    self.next();
                    let mut arguments = Vec::new();
                    if self.peek().text != ")" {
                        arguments.push(self.binary(1)?);
                        while self.peek().text == "," {
                            self.next();
                            arguments.push(self.binary(1)?);
                        }
                    }
                    self.expect(")")?;
                    return Ok(Expr::Call(token.text.to_lowercase(), arguments));
                }
                Ok(Expr::Name(token.text))
            }
            TokenKind::Op if token.text == "(" => {
                let expression = self.binary(1)?;
                self.expect(")")?;
                Ok(expression)
            }
            TokenKind::End => Err(ExprError::new("The expression ends too early")),
            TokenKind::Op => Err(ExprError::new(format!("Unexpected \"{}\" at position {}", token.text, token.position + 1))),
        }
    }

    fn power(&mut self) -> Result<Expr, ExprError> {
        let base = self.primary()?;
        if self.peek().text == "**" {
            self.next();
            // right-associative, binds tighter than unary minus on the left
            return Ok(Expr::Binary("**", Box::new(base), Box::new(self.unary()?)));
        }
        Ok(base)
    }

    fn unary(&mut self) -> Result<Expr, ExprError> {
        let token = self.peek();
        if token.kind == TokenKind::Op && matches!(token.text.as_str(), "-" | "+" | "~" | "!") {
            let operator = token.text.chars().next().unwrap();
            self.next();
            return Ok(Expr::Unary(operator, Box::new(self.unary()?)));
        }
        self.power()
    }

    fn binary(&mut self, min_precedence: u8) -> Result<Expr, ExprError> {
        let mut left = self.unary()?;
        loop {
            let token = self.peek();
            let Some((operator, precedence)) = (token.kind == TokenKind::Op).then(|| precedence(&token.text)).flatten() else {
                return Ok(left);
            };
            if precedence < min_precedence {
                return Ok(left);
            }
            self.next();
            let right = self.binary(precedence + 1)?;
            left = Expr::Binary(operator, Box::new(left), Box::new(right));
        }
    }
}

pub fn parse_expr(source: &str) -> Result<Expr, ExprError> {
    let mut parser = Parser { tokens: tokenize(source)?, position: 0 };
    if parser.peek().kind == TokenKind::End {
        return Err(ExprError::new("Enter an expression"));
    }
    let parsed = parser.binary(1)?;
    if parser.peek().kind != TokenKind::End {
        let token = parser.peek();
        return Err(ExprError::new(format!("Unexpected \"{}\" at position {}", token.text, token.position + 1)));
    }
    Ok(parsed)
}

/// Names the expression refers to (not counting function names).
pub fn names_in(expression: &Expr, out: &mut BTreeSet<String>) {
    match expression {
        Expr::Name(name) => {
            out.insert(name.clone());
        }
        Expr::Unary(_, operand) => names_in(operand, out),
        Expr::Binary(_, left, right) => {
            names_in(left, out);
            names_in(right, out);
        }
        Expr::Call(_, arguments) => arguments.iter().for_each(|argument| names_in(argument, out)),
        Expr::Num { .. } => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn int(text: &str) -> Result<BigInt, ExprError> {
        let lookup = |name: &str| match name {
            "x" => Some(BigInt::from(10)),
            "CTRL" => Some(BigInt::from(0xf0)),
            "Value 1" => Some(BigInt::from(3)),
            _ => None,
        };
        eval_int(&parse_expr(text)?, &lookup)
    }

    fn big(value: i64) -> BigInt {
        BigInt::from(value)
    }

    #[test]
    fn follows_c_like_precedence() {
        assert_eq!(int("1 + 2 * 3"), Ok(big(7)));
        assert_eq!(int("(1 + 2) * 3"), Ok(big(9)));
        assert_eq!(int("1 << 4 | 1"), Ok(big(17)));
        assert_eq!(int("0x1F << 3 | (1 << 31)"), Ok(big(0x800000f8)));
        assert_eq!(int("2 ** 3 ** 2"), Ok(big(512)));
        assert_eq!(int("-2 ** 2"), Ok(big(-4)));
        assert_eq!(int("~0 & 0xff"), Ok(big(0xff)));
        assert_eq!(int("7 / 2"), Ok(big(3)));
        assert_eq!(int("-7 / 2"), Ok(big(-3)));
        assert_eq!(int("-7 % 2"), Ok(big(-1)));
        assert_eq!(int("-8 >> 1"), Ok(big(-4)));
        assert_eq!(int("-7 >> 1"), Ok(big(-4)));
        assert_eq!(int("!0 + !5"), Ok(big(1)));
        assert_eq!(int("1_000 + 0b1010 + 0o17"), Ok(big(1025)));
    }

    #[test]
    fn resolves_names_and_functions() {
        assert_eq!(int("x + 1"), Ok(big(11)));
        assert_eq!(int("CTRL >> 4"), Ok(big(0xf)));
        assert_eq!(int("{Value 1} * 2"), Ok(big(6)));
        assert_eq!(int("`Value 1` + bit(4)"), Ok(big(19)));
        assert_eq!(int("mask(8) ^ CTRL"), Ok(big(0x0f)));
        assert_eq!(int("min(5, x, 7) + max(1, 2)"), Ok(big(7)));
        assert_eq!(int("popcount(0xff)"), Ok(big(8)));
        assert_eq!(int("2 ** 511"), Ok(big(1) << 511));
    }

    #[test]
    fn reports_errors_clearly() {
        let message = |text: &str| int(text).unwrap_err().0;
        assert!(message("1 +").contains("ends too early"));
        assert!(message("(1 + 2").contains("Missing \")\""));
        assert!(message("y + 1").contains("Unknown name \"y\""));
        assert!(message("1 / 0").contains("Division by zero"));
        assert!(message("1.5 + 1").contains("not a whole number"));
        assert!(message("2 ** 100000").contains("too large"));
        assert!(message("1 $ 2").contains("Unexpected \"$\""));
        assert!(message("foo(1)").contains("Unknown function"));
        assert_eq!(message(""), "Enter an expression");
        assert_eq!(message("{abc"), "Missing } for the name at position 1");
    }

    #[test]
    fn evaluates_real_formulas_and_detects_linear_ones() {
        let compile = |source: &str| {
            let expression = parse_expr(source).unwrap();
            move |x: f64| eval_real(&expression, &|name: &str| (name == "x").then_some(x)).unwrap()
        };
        assert_eq!(compile("x * 0.5 - 40")(100.0), 10.0);
        assert_eq!(compile("sqrt(x)")(16.0), 4.0);
        assert!((compile("pi * 2")(0.0) - std::f64::consts::TAU).abs() < 1e-12);
        assert_eq!(compile("round(x)")(-2.5), -2.0); // JavaScript's Math.round
        let samples = [2.0, 7.0, 1000.0];
        assert_eq!(linearity(&compile("x * 0.5 - 40"), &samples), Some((0.5, -40.0)));
        assert_eq!(linearity(&compile("x / 4 + 1.25"), &samples), Some((0.25, 1.25)));
        assert_eq!(linearity(&compile("x * x"), &samples), None);
        assert_eq!(linearity(&compile("sqrt(x)"), &samples), None);
    }

    #[test]
    fn lists_names() {
        let mut names = BTreeSet::new();
        names_in(&parse_expr("a + max(b, {c d}) * a").unwrap(), &mut names);
        assert_eq!(names.into_iter().collect::<Vec<_>>(), ["a", "b", "c d"]);
    }
}
