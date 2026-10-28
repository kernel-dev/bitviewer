//! The export template language (the web app's core/export/language), parsed
//! by hand. A template is the code you want out, with two additions:
//!
//!   ${expr | filter}      is replaced by a value
//!   @for / @if / @set …   lines that start with "@" are instructions
//!
//!   @name, @ext, @about, @scope   metadata;  @# a comment;  @@text a literal "@" line
//!
//! Inside ${ }: numbers, "strings", true / false, names (field.width), + -,
//! == != < <= > >=, and / or / not, parentheses, and filters: upper lower
//! pad(n) padl(n) join(sep) reverse default(x) lead(text) rust_ident.

use std::rc::Rc;

use num_bigint::BigInt;
use num_traits::{ToPrimitive, Zero};

use crate::interpretations::js_number;

// ------------------------------------------------------------ errors and values
#[derive(Clone, Debug, PartialEq)]
pub struct TemplateError {
    pub reason: String,
    pub line: usize,
}

impl TemplateError {
    pub fn new(reason: impl Into<String>, line: usize) -> Self {
        TemplateError { reason: reason.into(), line }
    }
}

impl std::fmt::Display for TemplateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.line > 0 { write!(f, "Line {}: {}", self.line, self.reason) } else { f.write_str(&self.reason) }
    }
}

type Result<T> = std::result::Result<T, TemplateError>;

/// A number a template can print in several spellings: `${x}` prints hex;
/// `.bin`, `.dec` and `.oct` are there too.
#[derive(Clone, Debug, PartialEq)]
pub struct Num {
    pub big: BigInt,
    pub hex: String,
    pub bin: String,
    pub dec: String,
    pub oct: String,
}

impl Num {
    /// `bits` is how many binary digits to pad to.
    pub fn of(value: BigInt, bits: usize) -> Num {
        Num {
            hex: format!("0x{}", value.to_str_radix(16).to_uppercase()),
            bin: format!("0b{:0>bits$}", value.to_str_radix(2)),
            dec: value.to_string(),
            oct: format!("0o{}", value.to_str_radix(8)),
            big: value,
        }
    }
}

/// A value templates see: as JavaScript would treat the web app's data.
#[derive(Clone, Debug, PartialEq)]
pub enum TV {
    Null,
    Bool(bool),
    Number(f64),
    Num(Rc<Num>),
    Str(Rc<str>),
    List(Rc<Vec<TV>>),
    /// An object, its keys in order.
    Obj(Rc<Vec<(String, TV)>>),
}

impl From<&str> for TV {
    fn from(text: &str) -> TV {
        TV::Str(text.into())
    }
}
impl From<String> for TV {
    fn from(text: String) -> TV {
        TV::Str(text.into())
    }
}
impl From<bool> for TV {
    fn from(value: bool) -> TV {
        TV::Bool(value)
    }
}
impl From<usize> for TV {
    fn from(value: usize) -> TV {
        TV::Number(value as f64)
    }
}
impl From<Num> for TV {
    fn from(value: Num) -> TV {
        TV::Num(Rc::new(value))
    }
}
impl From<Vec<TV>> for TV {
    fn from(list: Vec<TV>) -> TV {
        TV::List(Rc::new(list))
    }
}

/// Builds an object: `obj(vec![("a", 1.into())])`.
pub fn obj(entries: Vec<(&str, TV)>) -> TV {
    TV::Obj(Rc::new(entries.into_iter().map(|(key, value)| (key.to_string(), value)).collect()))
}

impl TV {
    /// Sets `key` (in place when it exists, else at the end), as `{...a, key}` does.
    pub fn with(self, key: &str, value: TV) -> TV {
        let TV::Obj(entries) = self else { return self };
        let mut entries = Rc::unwrap_or_clone(entries);
        match entries.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = value,
            None => entries.push((key.to_string(), value)),
        }
        TV::Obj(Rc::new(entries))
    }

    /// Copies every entry of `other` over this object.
    pub fn merge(self, other: &TV) -> TV {
        let TV::Obj(entries) = other else { return self };
        entries.iter().fold(self, |out, (key, value)| out.with(key, value.clone()))
    }

    pub fn get(&self, key: &str) -> Option<&TV> {
        match self {
            TV::Obj(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, value)| value),
            _ => None,
        }
    }
}

fn text(value: &TV) -> Result<String> {
    Ok(match value {
        TV::Null => String::new(),
        TV::Bool(value) => value.to_string(),
        TV::Number(number) => js_number(*number),
        TV::Num(num) => num.hex.clone(),
        TV::Str(text) => text.to_string(),
        TV::List(_) | TV::Obj(_) => {
            return Err(TemplateError::new("Can't print a list or object; pick a property or use | join", 0));
        }
    })
}

/// As a plain number, for maths (strings parse as JavaScript would).
fn number(value: &TV) -> f64 {
    match value {
        TV::Number(number) => *number,
        TV::Num(num) => num.big.to_f64().unwrap_or(f64::NAN),
        TV::Bool(value) => f64::from(u8::from(*value)),
        TV::Null => 0.0,
        TV::Str(text) => {
            let text = text.trim();
            if text.is_empty() { 0.0 } else { text.parse().unwrap_or(f64::NAN) }
        }
        _ => f64::NAN,
    }
}

fn numeric(value: &TV) -> bool {
    matches!(value, TV::Number(_) | TV::Num(_))
}

fn truthy(value: &TV) -> bool {
    match value {
        TV::Null => false,
        TV::Bool(value) => *value,
        TV::Number(number) => *number != 0.0 && !number.is_nan(),
        TV::Num(num) => !num.big.is_zero(),
        TV::Str(text) => !text.is_empty(),
        TV::List(list) => !list.is_empty(),
        TV::Obj(_) => true,
    }
}

fn same(left: &TV, right: &TV) -> bool {
    match (left, right) {
        (TV::Num(a), TV::Num(b)) => a.big == b.big,
        _ if numeric(left) && numeric(right) => number(left) == number(right),
        _ => left == right,
    }
}

fn kind(value: &TV) -> &'static str {
    match value {
        TV::Number(_) | TV::Num(_) => "number",
        TV::Str(_) => "string",
        TV::Bool(_) => "boolean",
        TV::Null => "undefined",
        _ => "object",
    }
}

fn compare(left: &TV, right: &TV, operator: &str, line: usize) -> Result<bool> {
    let (a, b) = (kind(left), kind(right));
    if a != b {
        return Err(TemplateError::new(format!("Can't compare {a} with {b} using {operator}"), line));
    }
    let order = match (left, right) {
        (TV::Num(x), TV::Num(y)) => x.big.partial_cmp(&y.big),
        (TV::Str(x), TV::Str(y)) => {
            // JavaScript compares strings by UTF-16 code units
            let (x, y): (Vec<u16>, Vec<u16>) = (x.encode_utf16().collect(), y.encode_utf16().collect());
            x.partial_cmp(&y)
        }
        _ => number(left).partial_cmp(&number(right)),
    };
    let Some(order) = order else { return Ok(false) };
    Ok(match operator {
        "<" => order.is_lt(),
        "<=" => order.is_le(),
        ">" => order.is_gt(),
        _ => order.is_ge(),
    })
}

// ------------------------------------------------------------ expressions
#[derive(Clone, Debug)]
pub enum Ex {
    Lit(TV),
    Path(Vec<String>),
    Not(Box<Ex>),
    Neg(Box<Ex>),
    Bin(String, Box<Ex>, Box<Ex>),
    Filter(Box<Ex>, String, Vec<Ex>),
}

#[derive(Clone, Debug, PartialEq)]
enum TokKind {
    Num,
    Str,
    Name,
    Op,
    End,
}

#[derive(Clone, Debug)]
struct Tok {
    kind: TokKind,
    text: String,
}

fn tokenize(source: &str, line: usize) -> Result<Vec<Tok>> {
    let chars: Vec<char> = source.chars().collect();
    let mut out = Vec::new();
    let mut cursor = 0;
    let tok = |kind, text: String| Tok { kind, text };
    while cursor < chars.len() {
        let c = chars[cursor];
        if c.is_whitespace() {
            cursor += 1;
            continue;
        }
        if c == '"' {
            let mut text = String::new();
            let mut scan = cursor + 1;
            loop {
                let Some(&scanned) = chars.get(scan) else {
                    return Err(TemplateError::new("Missing closing \" in a string", line));
                };
                if scanned == '\\' {
                    match chars.get(scan + 1) {
                        Some('n') => text.push('\n'),
                        Some(other) => text.push(*other),
                        None => {}
                    }
                    scan += 2;
                } else if scanned == '"' {
                    break;
                } else {
                    text.push(scanned);
                    scan += 1;
                }
            }
            out.push(tok(TokKind::Str, text));
            cursor = scan + 1;
            continue;
        }
        // numbers: 0x1F, 12, 1.5
        if c.is_ascii_digit() {
            let start = cursor;
            if c == '0' && matches!(chars.get(cursor + 1), Some('x' | 'X')) && chars.get(cursor + 2).is_some_and(char::is_ascii_hexdigit) {
                cursor += 2;
                while chars.get(cursor).is_some_and(char::is_ascii_hexdigit) {
                    cursor += 1;
                }
            } else {
                while chars.get(cursor).is_some_and(char::is_ascii_digit) {
                    cursor += 1;
                }
                if chars.get(cursor) == Some(&'.') && chars.get(cursor + 1).is_some_and(char::is_ascii_digit) {
                    cursor += 1;
                    while chars.get(cursor).is_some_and(char::is_ascii_digit) {
                        cursor += 1;
                    }
                }
            }
            out.push(tok(TokKind::Num, chars[start..cursor].iter().collect()));
            continue;
        }
        let word_start = |c: char| c.is_ascii_alphabetic() || c == '_';
        let word_char = |c: char| c.is_ascii_alphanumeric() || c == '_';
        if word_start(c) {
            let start = cursor;
            loop {
                while chars.get(cursor).is_some_and(|c| word_char(*c)) {
                    cursor += 1;
                }
                if chars.get(cursor) == Some(&'.') && chars.get(cursor + 1).is_some_and(|c| word_start(*c)) {
                    cursor += 1;
                } else {
                    break;
                }
            }
            out.push(tok(TokKind::Name, chars[start..cursor].iter().collect()));
            continue;
        }
        let two: String = chars[cursor..(cursor + 2).min(chars.len())].iter().collect();
        if ["==", "!=", "<=", ">="].contains(&two.as_str()) {
            out.push(tok(TokKind::Op, two));
            cursor += 2;
            continue;
        }
        if "<>+-()|,".contains(c) {
            out.push(tok(TokKind::Op, c.to_string()));
            cursor += 1;
            continue;
        }
        return Err(TemplateError::new(format!("Unexpected \"{c}\""), line));
    }
    out.push(tok(TokKind::End, String::new()));
    Ok(out)
}

struct Parser {
    tokens: Vec<Tok>,
    position: usize,
    line: usize,
}

impl Parser {
    fn peek(&self) -> &Tok {
        &self.tokens[self.position]
    }

    fn next(&mut self) -> Tok {
        let token = self.tokens[self.position].clone();
        if self.position + 1 < self.tokens.len() {
            self.position += 1;
        }
        token
    }

    fn is_word(&self, word: &str) -> bool {
        self.peek().kind == TokKind::Name && self.peek().text == word
    }

    fn is_op(&self, operator: &str) -> bool {
        self.peek().kind == TokKind::Op && self.peek().text == operator
    }

    fn fail<T>(&self, token: &Tok) -> Result<T> {
        Err(TemplateError::new(
            if token.kind == TokKind::End { "The expression ends too early".to_string() } else { format!("Unexpected \"{}\"", token.text) },
            self.line,
        ))
    }

    fn primary(&mut self) -> Result<Ex> {
        let token = self.next();
        match token.kind {
            TokKind::Num => {
                let value = match token.text.strip_prefix("0x").or_else(|| token.text.strip_prefix("0X")) {
                    Some(hex) => BigInt::parse_bytes(hex.as_bytes(), 16).and_then(|big| big.to_f64()).unwrap_or(f64::NAN),
                    None => token.text.parse().unwrap_or(f64::NAN),
                };
                Ok(Ex::Lit(TV::Number(value)))
            }
            TokKind::Str => Ok(Ex::Lit(TV::Str(token.text.as_str().into()))),
            TokKind::Name if !["and", "or", "not"].contains(&token.text.as_str()) => {
                if token.text == "true" || token.text == "false" {
                    return Ok(Ex::Lit(TV::Bool(token.text == "true")));
                }
                Ok(Ex::Path(token.text.split('.').map(String::from).collect()))
            }
            TokKind::Op if token.text == "(" => {
                let expression = self.pipe()?;
                let close = self.next();
                if close.text != ")" {
                    return self.fail(&close);
                }
                Ok(expression)
            }
            _ => self.fail(&token),
        }
    }

    fn unary(&mut self) -> Result<Ex> {
        if self.is_op("-") {
            self.next();
            return Ok(Ex::Neg(Box::new(self.unary()?)));
        }
        self.primary()
    }

    fn sum(&mut self) -> Result<Ex> {
        let mut left = self.unary()?;
        while self.is_op("+") || self.is_op("-") {
            let operator = self.next().text;
            left = Ex::Bin(operator, Box::new(left), Box::new(self.unary()?));
        }
        Ok(left)
    }

    fn comparison(&mut self) -> Result<Ex> {
        let left = self.sum()?;
        if self.peek().kind == TokKind::Op && ["==", "!=", "<", "<=", ">", ">="].contains(&self.peek().text.as_str()) {
            let operator = self.next().text;
            return Ok(Ex::Bin(operator, Box::new(left), Box::new(self.sum()?)));
        }
        Ok(left)
    }

    fn not(&mut self) -> Result<Ex> {
        if self.is_word("not") {
            self.next();
            return Ok(Ex::Not(Box::new(self.not()?)));
        }
        self.comparison()
    }

    fn and(&mut self) -> Result<Ex> {
        let mut left = self.not()?;
        while self.is_word("and") {
            self.next();
            left = Ex::Bin("and".into(), Box::new(left), Box::new(self.not()?));
        }
        Ok(left)
    }

    fn or(&mut self) -> Result<Ex> {
        let mut left = self.and()?;
        while self.is_word("or") {
            self.next();
            left = Ex::Bin("or".into(), Box::new(left), Box::new(self.and()?));
        }
        Ok(left)
    }

    fn pipe(&mut self) -> Result<Ex> {
        let mut left = self.or()?;
        while self.is_op("|") {
            self.next();
            let token = self.next();
            if token.kind != TokKind::Name || token.text.contains('.') {
                return self.fail(&token);
            }
            let mut arguments = Vec::new();
            if self.is_op("(") {
                self.next();
                if !self.is_op(")") {
                    arguments.push(self.or()?);
                    while self.is_op(",") {
                        self.next();
                        arguments.push(self.or()?);
                    }
                }
                let close = self.next();
                if close.text != ")" {
                    return self.fail(&close);
                }
            }
            left = Ex::Filter(Box::new(left), token.text, arguments);
        }
        Ok(left)
    }
}

pub fn parse_expression(source: &str, line: usize) -> Result<Ex> {
    let mut parser = Parser { tokens: tokenize(source, line)?, position: 0, line };
    if parser.peek().kind == TokKind::End {
        return Err(TemplateError::new("Missing expression", line));
    }
    let parsed = parser.pipe()?;
    if parser.peek().kind != TokKind::End {
        let token = parser.peek().clone();
        return parser.fail(&token);
    }
    Ok(parsed)
}

// ------------------------------------------------------------ templates
#[derive(Clone, Debug)]
pub enum Part {
    Text(String),
    Expr(Ex),
}

#[derive(Clone, Debug)]
pub enum Node {
    Text { line: usize, parts: Vec<Part> },
    For { line: usize, variable: String, list: Ex, body: Vec<Node>, orelse: Vec<Node> },
    If { line: usize, branches: Vec<(Option<Ex>, Vec<Node>)> },
    Set { line: usize, name: String, expression: Ex },
}

impl Node {
    fn line(&self) -> usize {
        match self {
            Node::Text { line, .. } | Node::For { line, .. } | Node::If { line, .. } | Node::Set { line, .. } => *line,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TemplateMeta {
    pub name: Option<String>,
    pub extension: Option<String>,
    pub about: Option<String>,
    /// "register" or "peripheral".
    pub scope: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Compiled {
    pub meta: TemplateMeta,
    pub body: Vec<Node>,
}

fn parse_text(line_text: &str, line: usize) -> Result<Node> {
    let mut parts = Vec::new();
    let mut pending = String::new();
    let bytes = line_text.as_bytes();
    let mut cursor = 0;
    while cursor < line_text.len() {
        let rest = &line_text[cursor..];
        if rest.starts_with("$${") {
            pending.push_str("${");
            cursor += 3;
        } else if rest.starts_with("${") {
            let mut scan = cursor + 2;
            let mut in_string = false;
            while scan < bytes.len() {
                let c = bytes[scan];
                if in_string {
                    if c == b'\\' {
                        scan += 1;
                    } else if c == b'"' {
                        in_string = false;
                    }
                } else if c == b'"' {
                    in_string = true;
                } else if c == b'}' {
                    break;
                }
                scan += 1;
            }
            if scan >= bytes.len() {
                return Err(TemplateError::new("Missing } to close ${", line));
            }
            if !pending.is_empty() {
                parts.push(Part::Text(std::mem::take(&mut pending)));
            }
            parts.push(Part::Expr(parse_expression(&line_text[cursor + 2..scan], line)?));
            cursor = scan + 1;
        } else {
            let c = rest.chars().next().unwrap();
            pending.push(c);
            cursor += c.len_utf8();
        }
    }
    if !pending.is_empty() || parts.is_empty() {
        parts.push(Part::Text(pending));
    }
    Ok(Node::Text { line, parts })
}

/// "@word rest": a directive word must be followed by a space or the end of
/// the line, so "@name-of-thing" stays output.
fn directive(after_at: &str) -> Option<(&str, &str)> {
    if let Some(rest) = after_at.strip_prefix('#') {
        return Some(("#", rest));
    }
    for word in ["name", "ext", "about", "scope", "for", "if", "elif", "else", "end", "set"] {
        if let Some(rest) = after_at.strip_prefix(word)
            && (rest.is_empty() || rest.starts_with(char::is_whitespace))
        {
            return Some((word, rest));
        }
    }
    None
}

fn identifier(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

enum Frame {
    Root(Vec<Node>),
    For { line: usize, variable: String, list: Ex, body: Vec<Node>, orelse: Vec<Node>, in_else: bool },
    If { line: usize, branches: Vec<(Option<Ex>, Vec<Node>)>, saw_else: bool },
}

impl Frame {
    fn nodes(&mut self) -> &mut Vec<Node> {
        match self {
            Frame::Root(nodes) => nodes,
            Frame::For { body, orelse, in_else, .. } => {
                if *in_else {
                    orelse
                } else {
                    body
                }
            }
            Frame::If { branches, .. } => &mut branches.last_mut().unwrap().1,
        }
    }
}

pub fn compile_template(source: &str) -> Result<Compiled> {
    let mut meta = TemplateMeta::default();
    let mut stack = vec![Frame::Root(Vec::new())];
    let source = source.replace('\r', "");
    for (index, raw) in source.split('\n').enumerate() {
        let line = index + 1;
        let trimmed = raw.trim_start();
        if trimmed.starts_with("@@") {
            let node = parse_text(&raw.replacen("@@", "@", 1), line)?;
            stack.last_mut().unwrap().nodes().push(node);
            continue;
        }
        let Some((word, argument)) = trimmed.strip_prefix('@').and_then(directive) else {
            let node = parse_text(raw, line)?;
            stack.last_mut().unwrap().nodes().push(node);
            continue;
        };
        let argument = argument.trim();
        match word {
            "#" => {}
            "scope" => {
                if argument != "register" && argument != "peripheral" {
                    return Err(TemplateError::new("Write it as: @scope register, or @scope peripheral", line));
                }
                meta.scope = Some(argument.into());
            }
            "name" => meta.name = Some(argument.into()),
            "ext" => meta.extension = Some(argument.into()),
            "about" => meta.about = Some(argument.into()),
            "for" => {
                let parsed = argument.split_once(char::is_whitespace).and_then(|(variable, rest)| {
                    let rest = rest.trim_start().strip_prefix("in")?;
                    (identifier(variable) && rest.starts_with(char::is_whitespace) && !rest.trim().is_empty())
                        .then(|| (variable.to_string(), rest.trim().to_string()))
                });
                let Some((variable, list)) = parsed else {
                    return Err(TemplateError::new("Write it as: @for item in list", line));
                };
                let list = parse_expression(&list, line)?;
                stack.push(Frame::For { line, variable, list, body: Vec::new(), orelse: Vec::new(), in_else: false });
            }
            "if" => {
                let condition = parse_expression(argument, line)?;
                stack.push(Frame::If { line, branches: vec![(Some(condition), Vec::new())], saw_else: false });
            }
            "set" => {
                let parsed = argument
                    .split_once('=')
                    .map(|(name, value)| (name.trim(), value.trim()))
                    .filter(|(name, value)| identifier(name) && !value.is_empty() && !value.starts_with('='));
                let Some((name, value)) = parsed else {
                    return Err(TemplateError::new("Write it as: @set name = value", line));
                };
                let node = Node::Set { line, name: name.into(), expression: parse_expression(value, line)? };
                stack.last_mut().unwrap().nodes().push(node);
            }
            "end" => {
                if !argument.is_empty() {
                    return Err(TemplateError::new("@end takes nothing after it", line));
                }
                let node = match stack.pop().unwrap() {
                    Frame::Root(nodes) => {
                        stack.push(Frame::Root(nodes));
                        return Err(TemplateError::new("@end without a matching @for or @if", line));
                    }
                    Frame::For { line, variable, list, body, orelse, .. } => Node::For { line, variable, list, body, orelse },
                    Frame::If { line, branches, .. } => Node::If { line, branches },
                };
                stack.last_mut().unwrap().nodes().push(node);
            }
            "else" => {
                if !argument.is_empty() {
                    return Err(TemplateError::new("@else takes nothing after it", line));
                }
                match stack.last_mut().unwrap() {
                    Frame::For { in_else, .. } => {
                        if *in_else {
                            return Err(TemplateError::new("@for already has an @else", line));
                        }
                        *in_else = true;
                    }
                    Frame::If { branches, saw_else, .. } => {
                        if *saw_else {
                            return Err(TemplateError::new("@if already has an @else", line));
                        }
                        *saw_else = true;
                        branches.push((None, Vec::new()));
                    }
                    Frame::Root(_) => return Err(TemplateError::new("@else without a matching @if or @for", line)),
                }
            }
            _ => {
                // elif
                let Some(Frame::If { branches, saw_else, .. }) = stack.last_mut() else {
                    return Err(TemplateError::new("@elif without a matching @if", line));
                };
                if *saw_else {
                    return Err(TemplateError::new("@elif can't come after @else", line));
                }
                branches.push((Some(parse_expression(argument, line)?), Vec::new()));
            }
        }
    }
    if stack.len() > 1 {
        let (kind, line) = match stack.last().unwrap() {
            Frame::For { line, .. } => ("for", *line),
            Frame::If { line, .. } => ("if", *line),
            Frame::Root(_) => unreachable!(),
        };
        return Err(TemplateError::new(format!("@{kind} is never closed with @end"), line));
    }
    let Some(Frame::Root(body)) = stack.pop() else { unreachable!() };
    Ok(Compiled { meta, body })
}

// ------------------------------------------------------------ filters
pub const FILTER_NAMES: [&str; 10] = ["upper", "lower", "pad", "padl", "join", "reverse", "lead", "rust_ident", "default", ""];

const MAX_PAD: f64 = 1000.0;
const RUST_KEYWORDS: &str = "as async await break const continue crate dyn else enum extern false fn for \
     if impl in let loop match mod move mut pub ref return self Self static struct \
     super trait true type unsafe use where while abstract become box do final gen \
     macro override priv try typeof unsized virtual yield";

/// JavaScript's padEnd / padStart (UTF-16 lengths, the filler repeated and cut).
fn pad(text: &str, width: usize, filler: &str, start: bool) -> String {
    let length = text.encode_utf16().count();
    if width <= length || filler.is_empty() {
        return text.to_string();
    }
    let need = width - length;
    let filler: Vec<u16> = filler.encode_utf16().collect();
    let fill: Vec<u16> = filler.iter().copied().cycle().take(need).collect();
    let fill = String::from_utf16_lossy(&fill);
    if start { format!("{fill}{text}") } else { format!("{text}{fill}") }
}

fn filter(name: &str, value: TV, arguments: Vec<TV>, line: usize) -> Result<TV> {
    let pad_width = |arguments: &[TV]| -> Result<usize> {
        let width = number(arguments.first().unwrap_or(&TV::Number(0.0)));
        if !(0.0..=MAX_PAD).contains(&width) {
            return Err(TemplateError::new(format!("pad needs a width from 0 to {MAX_PAD}"), line));
        }
        Ok(width as usize)
    };
    let filler = |arguments: &[TV]| -> Result<String> {
        match arguments.get(1) {
            None => Ok(" ".into()),
            Some(filler) => text(filler),
        }
    };
    Ok(match name {
        "upper" => text(&value)?.to_uppercase().into(),
        "lower" => text(&value)?.to_lowercase().into(),
        "pad" => pad(&text(&value)?, pad_width(&arguments)?, &filler(&arguments)?, false).into(),
        "padl" => pad(&text(&value)?, pad_width(&arguments)?, &filler(&arguments)?, true).into(),
        "join" => {
            let TV::List(list) = &value else { return Err(TemplateError::new("join needs a list", line)) };
            let separator = match arguments.first() {
                None => ", ".to_string(),
                Some(separator) => text(separator)?,
            };
            list.iter().map(text).collect::<Result<Vec<_>>>()?.join(&separator).into()
        }
        "reverse" => {
            let TV::List(list) = &value else { return Err(TemplateError::new("reverse needs a list", line)) };
            list.iter().rev().cloned().collect::<Vec<_>>().into()
        }
        "lead" => {
            let shown = text(&value)?;
            if shown.is_empty() {
                "".into()
            } else {
                let lead = match arguments.first() {
                    None => " ".to_string(),
                    Some(lead) => text(lead)?,
                };
                format!("{lead}{shown}").into()
            }
        }
        "rust_ident" => {
            let shown = text(&value)?;
            if !RUST_KEYWORDS.split(' ').any(|keyword| keyword == shown) {
                shown.into()
            } else if ["crate", "self", "super", "Self"].contains(&shown.as_str()) {
                format!("{shown}_").into()
            } else {
                format!("r#{shown}").into()
            }
        }
        "default" => {
            let empty = match &value {
                TV::Null => true,
                TV::Str(text) => text.is_empty(),
                TV::List(list) => list.is_empty(),
                _ => false,
            };
            if empty { arguments.into_iter().next().unwrap_or(TV::Null) } else { value }
        }
        _ => {
            let names = FILTER_NAMES[..9].join(", ");
            return Err(TemplateError::new(format!("Unknown filter \"{name}\" (try {names})"), line));
        }
    })
}

// ------------------------------------------------------------ rendering
const MAX_OUTPUT: usize = 1_000_000;
const MAX_LOOP: usize = 100_000;

struct Renderer<'a> {
    context: &'a TV,
    scopes: Vec<Vec<(String, TV)>>,
    out: Vec<String>,
    size: usize,
    loops: usize,
}

impl Renderer<'_> {
    fn lookup(&self, name: &str, line: usize) -> Result<TV> {
        for scope in self.scopes.iter().rev() {
            if let Some((_, value)) = scope.iter().find(|(key, _)| key == name) {
                return Ok(value.clone());
            }
        }
        self.context.get(name).cloned().ok_or_else(|| TemplateError::new(format!("Unknown name \"{name}\""), line))
    }

    fn property(record: &TV, key: &str, line: usize, path: &str) -> Result<TV> {
        if key == "length" {
            match record {
                TV::List(list) => return Ok(TV::Number(list.len() as f64)),
                TV::Str(text) => return Ok(TV::Number(text.encode_utf16().count() as f64)),
                _ => {}
            }
        }
        if let TV::Obj(entries) = record {
            if let Some((_, value)) = entries.iter().find(|(k, _)| k == key) {
                return Ok(value.clone());
            }
            let keys = entries.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(", ");
            return Err(TemplateError::new(format!("\"{path}\" has no \"{key}\" (it has: {keys})"), line));
        }
        // a Num has hex, bin, dec and oct
        if let TV::Num(num) = record {
            match key {
                "hex" => return Ok(num.hex.as_str().into()),
                "bin" => return Ok(num.bin.as_str().into()),
                "dec" => return Ok(num.dec.as_str().into()),
                "oct" => return Ok(num.oct.as_str().into()),
                _ => {
                    return Err(TemplateError::new(format!("\"{path}\" has no \"{key}\" (it has: hex, bin, dec, oct)"), line));
                }
            }
        }
        Err(TemplateError::new(format!("\"{path}\" has no \"{key}\""), line))
    }

    fn evaluate(&self, expression: &Ex, line: usize) -> Result<TV> {
        Ok(match expression {
            Ex::Lit(value) => value.clone(),
            Ex::Path(path) => {
                let mut value = self.lookup(&path[0], line)?;
                for index in 1..path.len() {
                    value = Self::property(&value, &path[index], line, &path[..index].join("."))?;
                }
                value
            }
            Ex::Not(operand) => TV::Bool(!truthy(&self.evaluate(operand, line)?)),
            Ex::Neg(operand) => TV::Number(-number(&self.evaluate(operand, line)?)),
            Ex::Filter(input, name, arguments) => {
                let value = self.evaluate(input, line)?;
                let arguments = arguments.iter().map(|argument| self.evaluate(argument, line)).collect::<Result<Vec<_>>>()?;
                filter(name, value, arguments, line)?
            }
            Ex::Bin(operator, left, right) => {
                if operator == "and" {
                    let left = self.evaluate(left, line)?;
                    return if truthy(&left) { self.evaluate(right, line) } else { Ok(left) };
                }
                if operator == "or" {
                    let left = self.evaluate(left, line)?;
                    return if truthy(&left) { Ok(left) } else { self.evaluate(right, line) };
                }
                let (left, right) = (self.evaluate(left, line)?, self.evaluate(right, line)?);
                match operator.as_str() {
                    "==" => TV::Bool(same(&left, &right)),
                    "!=" => TV::Bool(!same(&left, &right)),
                    "+" => {
                        if numeric(&left) && numeric(&right) {
                            TV::Number(number(&left) + number(&right))
                        } else {
                            let joined = text(&left)? + &text(&right)?;
                            if joined.len() > MAX_OUTPUT {
                                return Err(TemplateError::new("The text is too long", line));
                            }
                            joined.into()
                        }
                    }
                    "-" => TV::Number(number(&left) - number(&right)),
                    other => TV::Bool(compare(&left, &right, other, line)?),
                }
            }
        })
    }

    /// Errors without a line number (e.g. printing a list) get the node's line.
    fn run(&mut self, nodes: &[Node]) -> Result<()> {
        for node in nodes {
            self.run_node(node).map_err(|error| if error.line == 0 { TemplateError::new(error.reason, node.line()) } else { error })?;
        }
        Ok(())
    }

    fn run_node(&mut self, node: &Node) -> Result<()> {
        match node {
            Node::Text { line, parts } => {
                let mut rendered = String::new();
                for part in parts {
                    match part {
                        Part::Text(text) => rendered.push_str(text),
                        Part::Expr(expression) => rendered.push_str(&text(&self.evaluate(expression, *line)?)?),
                    }
                }
                self.size += rendered.len() + 1;
                if self.size > MAX_OUTPUT {
                    return Err(TemplateError::new("The output is too large", *line));
                }
                self.out.push(rendered.trim_end().to_string());
            }
            Node::Set { line, name, expression } => {
                let value = self.evaluate(expression, *line)?;
                // a new name goes to the outermost scope, so it outlives the loop it was set in
                let home = self.scopes.iter().rposition(|scope| scope.iter().any(|(key, _)| key == name)).unwrap_or(0);
                let scope = &mut self.scopes[home];
                match scope.iter_mut().find(|(key, _)| key == name) {
                    Some(entry) => entry.1 = value,
                    None => scope.push((name.clone(), value)),
                }
            }
            Node::If { line, branches } => {
                for (condition, body) in branches {
                    let taken = match condition {
                        None => true,
                        Some(condition) => truthy(&self.evaluate(condition, *line)?),
                    };
                    if taken {
                        self.run(body)?;
                        break;
                    }
                }
            }
            Node::For { line, variable, list, body, orelse } => {
                let TV::List(items) = self.evaluate(list, *line)? else {
                    return Err(TemplateError::new("@for needs a list to loop over", *line));
                };
                if items.is_empty() {
                    self.run(orelse)?;
                }
                let count = items.len();
                for (index, item) in items.iter().enumerate() {
                    self.loops += 1;
                    if self.loops > MAX_LOOP {
                        return Err(TemplateError::new("Too many loop iterations", *line));
                    }
                    let state = obj(vec![
                        ("index", (index + 1).into()),
                        ("first", (index == 0).into()),
                        ("last", (index + 1 == count).into()),
                        ("count", count.into()),
                    ]);
                    self.scopes.push(vec![(variable.clone(), item.clone()), ("loop".into(), state)]);
                    let result = self.run(body);
                    self.scopes.pop();
                    result?;
                }
            }
        }
        Ok(())
    }
}

/// Runs a compiled template against `context` (an object).
pub fn render_template(compiled: &Compiled, context: &TV) -> Result<String> {
    let mut renderer = Renderer { context, scopes: vec![Vec::new()], out: Vec::new(), size: 0, loops: 0 };
    renderer.run(&compiled.body)?;
    Ok(format!("{}\n", renderer.out.join("\n").trim_end()))
}

/// Compiles and renders in one go.
pub fn render_source(source: &str, context: &TV) -> Result<String> {
    render_template(&compile_template(source)?, context)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_loops_conditions_and_filters() {
        let context = obj(vec![
            ("name", "Ctrl".into()),
            ("value", Num::of(BigInt::from(26), 8).into()),
            ("items", vec![obj(vec![("id", "A".into())]), obj(vec![("id", "B".into())])].into()),
        ]);
        let source = "@name Test\n@ext h\n${name | upper | pad(6, \".\")}|${value}|${value.bin}\n@for item in items\n${loop.index}:${item.id}@if loop.last\n@if loop.last\nlast ${item.id | lower}\n@end\n@end\n${items | reverse | join(\"-\")}";
        let compiled = compile_template(source).unwrap();
        assert_eq!(compiled.meta.extension.as_deref(), Some("h"));
        let error = render_template(&compiled, &context).unwrap_err();
        assert_eq!(error.line, 10, "{error}");
        let ok = "${name | upper | pad(6, \".\")}|${value}|${value.bin}\n@for item in items\n${loop.index}:${item.id}\n@if loop.last\nlast ${item.id | lower}\n@end\n@end\n${\"x\" + 1 + 2}|${1 + 2}|${\"z\" | rust_ident}|${\"self\" | rust_ident}|${\"fn\" | rust_ident}";
        assert_eq!(render_source(ok, &context).unwrap(), "CTRL..|0x1A|0b00011010\n1:A\n2:B\nlast b\nx12|3|z|self_|r#fn\n");
        assert_eq!(render_source("${nope}", &context).unwrap_err().to_string(), "Line 1: Unknown name \"nope\"");
        assert_eq!(compile_template("@for x\n").unwrap_err().reason, "Write it as: @for item in list");
        assert_eq!(compile_template("@if 1\n").unwrap_err().to_string(), "Line 1: @if is never closed with @end");
        assert!(render_source("${value.big}", &context).unwrap_err().reason.contains("(it has: hex, bin, dec, oct)"));
        assert_eq!(render_source("${items.zzz}", &context).unwrap_err().reason, "\"items\" has no \"zzz\"");
        assert_eq!(render_source("@@x $${y}", &context).unwrap(), "@x ${y}\n");
    }
}
