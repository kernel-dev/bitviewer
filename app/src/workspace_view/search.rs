//! The Ctrl+F search bar (the web app's search.ts): filters the values by
//! name, peripheral, description, fields, named values, snapshots or hex
//! digits. It searches as you type (a moment after the last key, on every
//! core) and always over the whole workspace, unless "Only in" limits it to
//! the open peripheral. Hiding the bar (Esc) keeps the results; "Clear"
//! discards them. With ".*" on (Alt+R) the text is a regular expression.

use std::collections::HashSet;
use std::sync::Arc;

use crate::kit::component::input::{Input, InputEvent, InputState};
use crate::kit::*;
use bitviewer_core::integers::{Base, format_int};
use bitviewer_core::value::Value;

use super::WorkspaceView;
use crate::widgets::{Btn, Look, icon, r};
use crate::{app_state, theme};

/// Whether `text` contains `needle` (already lower case), ignoring case,
/// without copying `text` (ASCII, the usual case for register names).
fn contains(text: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    if text.is_ascii() && needle.is_ascii() {
        let (text, needle) = (text.as_bytes(), needle.as_bytes());
        if needle.len() > text.len() {
            return false;
        }
        let first = needle[0];
        return (0..=text.len() - needle.len()).any(|at| text[at].to_ascii_lowercase() == first && text[at..at + needle.len()].eq_ignore_ascii_case(needle));
    }
    text.to_lowercase().contains(needle)
}

/// What a search looks for: text in any case, or a regular expression
/// (also case-insensitive unless it starts with `(?-i)`).
pub enum Matcher {
    /// Lower case; "" matches everything.
    Text(String),
    Regex(regex::Regex),
}

impl Matcher {
    /// The matcher for `query`, or why the pattern isn't valid.
    pub fn new(query: &str, regex: bool) -> Result<Matcher, String> {
        if !regex {
            return Ok(Matcher::Text(query.to_lowercase()));
        }
        regex::RegexBuilder::new(query).case_insensitive(true).size_limit(1 << 20).build().map(Matcher::Regex).map_err(|error| {
            // the last line says what is wrong ("unclosed character class")
            let text = error.to_string();
            let last = text.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or(&text);
            last.trim().trim_start_matches("error: ").to_string()
        })
    }

    fn finds(&self, text: &str) -> bool {
        match self {
            Matcher::Text(needle) => contains(text, needle),
            Matcher::Regex(regex) => regex.is_match(text),
        }
    }
}

/// Does a value match? Matching field names too.
pub fn match_value(value: &Value, matcher: &Matcher) -> (bool, HashSet<String>) {
    let mut fields = HashSet::new();
    if matches!(matcher, Matcher::Text(needle) if needle.is_empty()) {
        return (true, fields);
    }
    for field in &value.fields {
        if matcher.finds(&field.name) || matcher.finds(&field.details.description) || field.details.named.iter().any(|named| matcher.finds(&named.label)) {
            fields.insert(field.name.to_string());
        }
    }
    let hit = matcher.finds(&value.name)
        || matcher.finds(&value.block)
        || matcher.finds(&value.description)
        || !fields.is_empty()
        || value.snapshots.iter().any(|snapshot| matcher.finds(&snapshot.name))
        || hex_match(value, matcher);
    (hit, fields)
}

/// Whether the value's hex digits match: text that is a hex number found
/// in them, or a pattern (`^DEAD`, `00$`) that matches them.
fn hex_match(value: &Value, matcher: &Matcher) -> bool {
    match matcher {
        Matcher::Text(query) => {
            let digits: String = query.strip_prefix("0x").unwrap_or(query).replace('_', "");
            if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return false; // only a hex number can be in the value's hex digits
            }
            format_int(value.value, Base::Hex, value.width, false, false).to_lowercase().contains(&digits)
        }
        Matcher::Regex(regex) => regex.is_match(&format_int(value.value, Base::Hex, value.width, false, false)),
    }
}

/// Which values match, on every core (one flag per value, in order).
fn matches<'a>(values: impl Iterator<Item = &'a Arc<Value>>, matcher: &Matcher) -> Vec<bool> {
    use rayon::prelude::*;
    let all: Vec<&Arc<Value>> = values.collect();
    all.par_iter().map(|value| match_value(value, matcher).0).collect()
}

/// How long typing must pause before the search runs.
const SEARCH_PAUSE_MS: u64 = 120;

pub(super) struct Search {
    input: Entity<InputState>,
    /// The query the workspace is filtered by ("" shows everything), and
    /// what it matches with.
    query: String,
    matcher: Option<Arc<Matcher>>,
    /// The text and mode last searched for (it may not have been valid).
    ran: (String, bool),
    /// Why the text last searched for isn't a valid pattern (the results
    /// of the last valid one stay).
    error: Option<String>,
    /// Which values match the query (by position), when there is one.
    pub hits: Option<Arc<Vec<bool>>>,
    count: usize,
    /// The match last stepped to, and when (its card flashes).
    current: Option<usize>,
    pub stepped: Option<(usize, std::time::Instant)>,
    /// Search only the open peripheral's page.
    pub only_page: bool,
    /// The search waiting for typing to pause.
    pending: Option<Task<()>>,
    /// The bar is open. Closed, the results stay (a slim bar says so)
    /// until they are cleared.
    open: bool,
    _subscription: Subscription,
}

impl WorkspaceView {
    pub(super) fn open_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(search) = &mut self.search {
            search.open = true;
            let input = search.input.clone();
            input.update(cx, |input, cx| {
                input.focus(window, cx);
                input.select_all(window, cx);
            });
            cx.notify();
            return;
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Search every register: names, fields, descriptions, hex…"));
        input.update(cx, |input, cx| input.focus(window, cx));
        let subscription = cx.subscribe_in(&input, window, |this, input, event: &InputEvent, _, cx| {
            if let InputEvent::Change = event {
                // an emptied box shows everything again at once; otherwise
                // search once typing pauses
                if input.read(cx).value().trim().is_empty() {
                    this.run_search(cx);
                } else {
                    let task = cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(std::time::Duration::from_millis(SEARCH_PAUSE_MS)).await;
                        this.update(cx, |this, cx| this.run_search(cx)).ok();
                    });
                    if let Some(search) = &mut this.search {
                        search.pending = Some(task);
                    }
                }
                cx.notify();
            }
        });
        self.search = Some(Search {
            input,
            query: String::new(),
            matcher: None,
            ran: (String::new(), false),
            error: None,
            hits: None,
            count: 0,
            current: None,
            stepped: None,
            only_page: false,
            pending: None,
            open: true,
            _subscription: subscription,
        });
        cx.notify();
    }

    /// Opens the bar with `text` in it and searches (--shot).
    pub(super) fn search_for(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.open_search(window, cx);
        if let Some(search) = &self.search {
            let input = search.input.clone();
            input.update(cx, |input, cx| input.set_value(text.to_string(), window, cx));
        }
        self.run_search(cx);
    }

    /// Hides the bar. The results stay until they are cleared.
    pub(super) fn close_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(search) = &self.search else { return };
        // what was typed last counts, even if its search hadn't run yet
        if self.wanted(cx) != search.ran {
            self.run_search(cx);
        }
        let Some(search) = &mut self.search else { return };
        if search.query.is_empty() {
            self.clear_search(window, cx);
            return;
        }
        search.open = false;
        search.pending = None;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    /// Discards the results: every value shows again.
    pub(super) fn clear_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.search.take().is_some() {
            self.refilter(true);
            window.focus(&self.focus, cx);
            cx.notify();
        }
    }

    /// What is typed, as typed (a pattern's `\D` isn't `\d`).
    fn typed(&self, cx: &App) -> String {
        self.search.as_ref().map(|search| search.input.read(cx).value().trim().to_string()).unwrap_or_default()
    }

    /// What should be searched for now: the text and whether it's a pattern.
    fn wanted(&self, cx: &App) -> (String, bool) {
        (self.typed(cx), app_state::settings(cx).search_regex)
    }

    /// Filters the workspace for what is typed.
    fn run_search(&mut self, cx: &mut Context<Self>) {
        let (query, regex) = self.wanted(cx);
        let matcher = if query.is_empty() { Ok(None) } else { Matcher::new(&query, regex).map(|matcher| Some(Arc::new(matcher))) };
        let matcher = match matcher {
            Ok(matcher) => matcher,
            Err(error) => {
                // keep showing the last valid search's results
                if let Some(search) = &mut self.search {
                    search.pending = None;
                    search.error = Some(error);
                    search.ran = (query, regex);
                }
                cx.notify();
                return;
            }
        };
        let hits = matcher.as_ref().map(|matcher| Arc::new(matches(self.state.values.iter(), matcher)));
        let Some(search) = &mut self.search else { return };
        search.pending = None;
        search.error = None;
        search.hits = hits;
        search.matcher = matcher;
        search.ran = (query.clone(), regex);
        search.query = query;
        search.current = None;
        self.count_matches();
        self.refilter(false);
        cx.notify();
    }

    /// Turns regular expressions on or off (".*", Alt+R) and searches again.
    fn toggle_regex(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        app_state::update(cx, |settings| settings.search_regex = !settings.search_regex);
        self.run_search(cx);
        // typing goes on in the box
        if let Some(search) = &self.search {
            let input = search.input.clone();
            input.update(cx, |input, cx| input.focus(window, cx));
        }
    }

    /// The scope of the search: the open page when "Only in" is on.
    fn search_scope(&self) -> Option<&Arc<str>> {
        self.search.as_ref().filter(|search| search.only_page).and(self.page.as_ref())
    }

    /// Counts the matches in the search's scope.
    fn count_matches(&mut self) {
        let scope = self.search_scope().cloned();
        let values = &self.state.values;
        let Some(search) = &mut self.search else { return };
        search.count = match (&search.hits, &scope) {
            (None, _) => 0,
            (Some(hits), None) => hits.iter().filter(|hit| **hit).count(),
            (Some(hits), Some(page)) => hits.iter().zip(values.iter()).filter(|(hit, value)| **hit && value.block == *page).count(),
        };
    }

    /// Turns "Only in" (the open peripheral) on or off.
    fn toggle_only_page(&mut self, cx: &mut Context<Self>) {
        if let Some(search) = &mut self.search {
            search.only_page = !search.only_page;
        }
        self.count_matches();
        self.refilter(false);
        cx.notify();
    }

    /// The page changed: the counts of a search limited to it change too.
    pub(super) fn page_changed(&mut self) {
        self.count_matches();
    }

    /// The query matches again after a change (call when values change).
    pub(super) fn refresh_search(&mut self, cx: &mut Context<Self>) {
        if let Some(matcher) = self.search.as_ref().and_then(|search| search.matcher.clone()) {
            let hits = Arc::new(matches(self.state.values.iter(), &matcher));
            let search = self.search.as_mut().unwrap();
            search.hits = Some(hits);
            self.count_matches();
            let _ = cx;
        }
    }

    /// Enter / the arrows: search for new text, else go to the next or previous match.
    fn go(&mut self, direction: isize, cx: &mut Context<Self>) {
        let wanted = self.wanted(cx);
        let Some(search) = &self.search else { return };
        if wanted != search.ran {
            self.run_search(cx);
            return;
        }
        let Some(hits) = search.hits.clone() else { return };
        let matches: Vec<usize> = hits.iter().enumerate().filter(|(index, hit)| **hit && self.shown(*index)).map(|(index, _)| index).collect();
        if matches.is_empty() {
            return;
        }
        let count = matches.len() as isize;
        let current = search.current.and_then(|current| matches.iter().position(|&index| index == current));
        let next = match current {
            Some(position) => (position as isize + direction).rem_euclid(count),
            None if direction > 0 => 0,
            None => count - 1,
        } as usize;
        let index = matches[next];
        if let Some(search) = &mut self.search {
            search.current = Some(index);
            search.stepped = Some((index, std::time::Instant::now()));
        }
        self.scroll_to_value(index);
        if let Some(id) = self.state.values.get(index).map(|value| value.id) {
            self.active = Some(id);
        }
        cx.notify();
    }

    /// Forgets the results (another workspace is shown); the text stays.
    pub(super) fn reset_search(&mut self) {
        if let Some(search) = &mut self.search {
            search.hits = None;
            search.query.clear();
            search.matcher = None;
            search.ran = (String::new(), false);
            search.error = None;
            search.count = 0;
            search.current = None;
        }
    }

    /// Whether the value at `index` is shown (all are, unless a search filters them).
    pub(super) fn shown(&self, index: usize) -> bool {
        let in_page = |page: &Arc<str>| self.state.values.get(index).is_none_or(|value| value.block == *page);
        match self.search.as_ref().and_then(|search| search.hits.as_ref()) {
            // a search looks everywhere, unless "Only in" keeps it to the open page
            Some(hits) => hits.get(index).copied().unwrap_or(true) && self.search_scope().is_none_or(in_page),
            None => self.page.as_ref().is_none_or(in_page),
        }
    }

    /// What the search matches with, and the flash, for the value at `index`.
    pub(super) fn highlight_for(&self, index: usize) -> (Option<Arc<Matcher>>, Option<std::time::Instant>) {
        let Some(search) = &self.search else { return (None, None) };
        let flash = search.stepped.filter(|(at, _)| *at == index).map(|(_, when)| when);
        (search.matcher.clone(), flash)
    }

    /// A search is filtering the values (collapsed peripherals open while it does).
    pub(super) fn searching(&self) -> bool {
        self.search.as_ref().is_some_and(|search| search.hits.is_some())
    }

    pub(super) fn render_search(&mut self, cx: &mut Context<Self>) -> Option<Div> {
        let search = self.search.as_ref()?;
        let palette = theme::current();
        if !search.open {
            return Some(self.render_results_bar(cx));
        }
        let regex = app_state::settings(cx).search_regex;
        // an empty bar has nothing to search, whichever mode it is in
        let text = search.input.read(cx).value().trim().to_string();
        let pending = !text.is_empty() && (text, regex) != search.ran;
        let total = self.state.len();
        let count = if pending {
            "Searching…".to_string()
        } else if let Some(error) = &search.error {
            format!("Invalid pattern: {error}")
        } else if search.query.is_empty() {
            String::new()
        } else if search.count > 0 {
            let place = match self.search_scope() {
                Some(page) if page.is_empty() => " outside peripherals".to_string(),
                Some(page) => format!(" in {page}"),
                None => " in all peripherals".to_string(),
            };
            format!("{} of {total} value{}{place}", search.count, if total == 1 { "" } else { "s" })
        } else {
            "No matches".to_string()
        };
        let only_page = search.only_page;
        let scope_toggle = self.page.clone().map(|page| {
            let label = if page.is_empty() { "Only values outside peripherals".to_string() } else { format!("Search within {page} only") };
            Btn::new("search-scope", if only_page { Look::On } else { Look::Ghost })
                .small()
                .icon("cpu")
                .label(label)
                .tip("Limit the search to the peripheral whose tab is open; off searches every peripheral and register")
                .test_label("search-scope")
                .on_click(cx.listener(|this, _, window, cx| {
                    this.toggle_only_page(cx);
                    // typing goes on in the box
                    if let Some(search) = &this.search {
                        let input = search.input.clone();
                        input.update(cx, |input, cx| input.focus(window, cx));
                    }
                }))
        });
        let invalid = !pending && (search.error.is_some() || (!search.query.is_empty() && search.count == 0));
        let regex_toggle = Btn::new("search-regex", if regex { Look::On } else { Look::Ghost })
            .small()
            .label(".*")
            .tip("Regular expression (Alt+R): ^ and $ anchor a name, | means or, \\d is a digit… Ignores case unless the pattern starts with (?-i)")
            .test_label("search-regex")
            .on_click(cx.listener(|this, _, window, cx| this.toggle_regex(window, cx)));
        let input = div()
            .flex()
            .items_center()
            .flex_1()
            .max_w(r(520.0))
            .h(r(28.0))
            .px(r(10.0))
            .rounded(r(8.0))
            .border_1()
            .border_color(if invalid { palette.error } else { palette.border_strong })
            .bg(if invalid { palette.error_bg } else { palette.input })
            .child(Input::new(&search.input).appearance(false).w_full());
        Some(
            div()
                .flex()
                .items_center()
                .gap(r(8.0))
                .px(r(14.0))
                .py(r(6.0))
                .bg(palette.surface)
                .border_b_1()
                .border_color(palette.border)
                .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| match event.keystroke.key.as_str() {
                    "enter" => {
                        this.go(if event.keystroke.modifiers.shift { -1 } else { 1 }, cx);
                        cx.stop_propagation();
                    }
                    "escape" => {
                        this.close_search(window, cx);
                        cx.stop_propagation();
                    }
                    "r" if event.keystroke.modifiers.alt => {
                        this.toggle_regex(window, cx);
                        cx.stop_propagation();
                    }
                    _ => {}
                }))
                .child(icon("search", 15.0).text_color(palette.muted))
                .child(input)
                .child(regex_toggle)
                .children(scope_toggle)
                .child(
                    div()
                        .min_w(r(9.0 * 7.2))
                        .whitespace_nowrap()
                        .text_size(r(12.0))
                        .text_color(if search.error.is_some() && !pending { palette.error } else { palette.muted })
                        .child(count),
                )
                .child(
                    Btn::new("search-prev", Look::Ghost)
                        .small()
                        .icon("chevron-up")
                        .tip("Previous match (Shift+Enter)")
                        .on_click(cx.listener(|this, _, _, cx| this.go(-1, cx))),
                )
                .child(
                    Btn::new("search-next", Look::Ghost)
                        .small()
                        .icon("chevron-down")
                        .tip("Next match (Enter)")
                        .on_click(cx.listener(|this, _, _, cx| this.go(1, cx))),
                )
                .child(
                    Btn::new("search-clear", Look::Ghost)
                        .small()
                        .label("Clear")
                        .tip("Discard the results and show every value")
                        .test_label("search-clear")
                        .on_click(cx.listener(|this, _, window, cx| this.clear_search(window, cx))),
                )
                .child(
                    Btn::new("search-close", Look::Ghost)
                        .small()
                        .icon("x")
                        .tip("Hide the search bar (Esc); the results stay")
                        .test_label("search-close")
                        .on_click(cx.listener(|this, _, window, cx| this.close_search(window, cx))),
                ),
        )
    }

    /// While the bar is hidden: what the results are, and how to change or
    /// discard them.
    fn render_results_bar(&mut self, cx: &mut Context<Self>) -> Div {
        let palette = theme::current();
        let Some(search) = self.search.as_ref() else { return div() };
        let place = match self.search_scope() {
            Some(page) if page.is_empty() => " outside peripherals".to_string(),
            Some(page) => format!(" in {page}"),
            None => String::new(),
        };
        let what = match search.matcher.as_deref() {
            Some(Matcher::Regex(_)) => format!("the pattern /{}/", search.query),
            _ => format!("“{}”", search.query),
        };
        let text = match search.count {
            0 => format!("No values match {what}{place}"),
            1 => format!("1 value matches {what}{place}"),
            count => format!("{count} values match {what}{place}"),
        };
        div()
            .flex()
            .items_center()
            .gap(r(8.0))
            .px(r(14.0))
            .py(r(5.0))
            .bg(palette.accent_soft)
            .border_b_1()
            .border_color(palette.border)
            .debug_selector(|| "search-results".to_string())
            .child(icon("search", 14.0).text_color(palette.accent))
            .child(div().text_size(r(13.0)).font_weight(FontWeight::MEDIUM).text_color(palette.text).child(text))
            .child(div().flex_1())
            .child(
                Btn::new("results-prev", Look::Ghost).small().icon("chevron-up").tip("Previous match").on_click(cx.listener(|this, _, _, cx| this.go(-1, cx))),
            )
            .child(Btn::new("results-next", Look::Ghost).small().icon("chevron-down").tip("Next match").on_click(cx.listener(|this, _, _, cx| this.go(1, cx))))
            .child(
                Btn::new("results-edit", Look::Ghost)
                    .small()
                    .label("Edit search")
                    .tip("Open the search bar again (Ctrl+F)")
                    .test_label("search-edit")
                    .on_click(cx.listener(|this, _, window, cx| this.open_search(window, cx))),
            )
            .child(
                Btn::new("results-clear", Look::Outline)
                    .small()
                    .icon("x")
                    .label("Clear results")
                    .tip("Discard the results and show every value")
                    .test_label("results-clear")
                    .on_click(cx.listener(|this, _, window, cx| this.clear_search(window, cx))),
            )
    }
}

#[cfg(test)]
mod speed {
    use bitviewer_core::integers::{Base, Bits};
    use bitviewer_core::rows::View;
    use bitviewer_core::value::Value;
    use std::sync::Arc;

    /// cargo test --release -p bitviewer search_speed -- --ignored --nocapture
    #[test]
    #[ignore]
    fn search_speed() {
        let values: Vec<Arc<Value>> = (0..90_000)
            .map(|index| {
                let mut value = Value::new(
                    32,
                    Bits::from(index as u64 * 2654435761 % 4294967296),
                    &format!("PER{}.REG{}", index / 300, index % 300),
                    View::Line,
                    Base::Hex,
                )
                .unwrap();
                value.set_description(&format!("Control register {}: configures channel {}", index % 300, index % 16));
                for field in 0..8 {
                    value.add_field(field * 4, field * 4 + 3, Some(&format!("F{field}")), None, None).unwrap();
                }
                Arc::new(value)
            })
            .collect();
        for query in ["reg299", "channel 7", "zzz", "a8"] {
            let started = std::time::Instant::now();
            let hits = super::matches(values.iter(), &super::Matcher::new(query, false).unwrap()).into_iter().filter(|hit| *hit).count();
            println!("{query:>10}: {hits} hits in {:?}", started.elapsed());
        }
    }
}

#[cfg(test)]
mod matcher_tests {
    use super::{Matcher, match_value};
    use bitviewer_core::integers::{Base, Bits};
    use bitviewer_core::rows::View;
    use bitviewer_core::value::Value;

    fn register(name: &str, bits: u64) -> Value {
        let mut value = Value::new(32, Bits::from(bits), name, View::Line, Base::Hex).unwrap();
        value.add_field(13, 13, Some("UE"), None, None).unwrap();
        value
    }

    #[test]
    fn text_and_patterns_match_names_fields_and_hex() {
        let cr1 = register("USART1.CR1", 0xDEAD_0000);
        let text = |query: &str| match_value(&cr1, &Matcher::new(query, false).unwrap()).0;
        let pattern = |query: &str| match_value(&cr1, &Matcher::new(query, true).unwrap()).0;
        // plain text: any case, anywhere
        assert!(text("usart1") && text("cr1") && text("dead") && !text("cr2"));
        // a pattern anchors, alternates, classes; also any case
        assert!(pattern(r"^usart\d\.cr1$"));
        assert!(!pattern(r"^cr1"));
        assert!(pattern("CR2|CR1"));
        // fields match by name (and are the ones highlighted)
        let (hit, fields) = match_value(&cr1, &Matcher::new("^ue$", true).unwrap());
        assert!(hit && fields.contains("UE"));
        // hex digits: the value is DEAD0000
        assert!(pattern("^DEAD") && pattern("0000$") && !pattern("^0000"));
        // (?-i) makes it case-sensitive
        assert!(!pattern("(?-i)usart"));
    }

    #[test]
    fn a_bad_pattern_says_what_is_wrong() {
        let error = Matcher::new("usart[", true).err().unwrap();
        assert!(error.contains("unclosed"), "{error}");
        assert!(!error.contains('\n'));
        // as text, the same characters are fine
        assert!(Matcher::new("usart[", false).is_ok());
    }
}
