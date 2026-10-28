//! The in-app guide (the web app's dialogs/guide.ts): renders the markdown
//! pages in docs/guide, the same files GitHub shows, with their screenshots.

use std::sync::{Arc, OnceLock};

use crate::kit::component::WindowExt;
use crate::kit::*;

use crate::modal;
use crate::theme;
use crate::widgets::{Btn, Look, r};

macro_rules! pages {
    ($($file:literal),* $(,)?) => {
        [$(($file, include_str!(concat!("../../docs/guide/", $file)))),*]
    };
}

const PAGES: [(&str, &str); 10] = pages!(
    "01-bits-and-values.md",
    "02-expressions.md",
    "03-register-fields.md",
    "04-operations-and-compare.md",
    "05-templates-and-workspace.md",
    "06-generating-code.md",
    "07-export-templates.md",
    "08-importing-svd.md",
    "09-peripherals.md",
    "10-finding-your-way.md",
);

macro_rules! images {
    ($($file:literal),* $(,)?) => {
        [$((concat!("img/", $file), include_bytes!(concat!("../../docs/guide/img/", $file)) as &[u8])),*]
    };
}

const IMAGES: [(&str, &[u8]); 14] = images!(
    "bits-selection.png",
    "compare.png",
    "export-code.png",
    "export-editor.png",
    "export-struct.png",
    "expr-bar.png",
    "fields.png",
    "locked-bits.png",
    "peripheral.png",
    "peripheral-diff.png",
    "search.png",
    "settings.png",
    "svd-import.png",
    "template.png",
);

fn image(path: &str) -> Option<Arc<Image>> {
    static LOADED: OnceLock<Vec<(&'static str, Arc<Image>)>> = OnceLock::new();
    let loaded = LOADED.get_or_init(|| IMAGES.iter().map(|(name, bytes)| (*name, Arc::new(Image::from_bytes(ImageFormat::Png, bytes.to_vec())))).collect());
    loaded.iter().find(|(name, _)| *name == path).map(|(_, image)| image.clone())
}

fn title(text: &str) -> String {
    text.lines().find_map(|line| line.strip_prefix("# ")).unwrap_or("").to_string()
}

/// One piece of a line: plain, `code`, **bold**, or a [link](target).
enum Span {
    Text(String),
    Code(String),
    Bold(String),
    Link(String, String),
}

fn spans(source: &str) -> Vec<Span> {
    let mut out = Vec::new();
    let mut rest = source;
    let mut text = String::new();
    while !rest.is_empty() {
        let found = if let Some(after) = rest.strip_prefix('`') {
            after.find('`').filter(|end| *end > 0).map(|end| (Span::Code(after[..end].into()), end + 2))
        } else if let Some(after) = rest.strip_prefix("**") {
            after.find("**").filter(|end| *end > 0 && !after[..*end].contains('*')).map(|end| (Span::Bold(after[..end].into()), end + 4))
        } else if let Some(after) = rest.strip_prefix('[') {
            after.find("](").filter(|end| !after[..*end].contains(']')).and_then(|label_end| {
                let target = &after[label_end + 2..];
                target.find(')').filter(|end| *end > 0).map(|end| (Span::Link(after[..label_end].into(), target[..end].into()), 1 + label_end + 2 + end + 1))
            })
        } else {
            None
        };
        match found {
            Some((span, length)) => {
                if !text.is_empty() {
                    out.push(Span::Text(std::mem::take(&mut text)));
                }
                out.push(span);
                rest = &rest[length..];
            }
            None => {
                let c = rest.chars().next().unwrap();
                text.push(c);
                rest = &rest[c.len_utf8()..];
            }
        }
    }
    if !text.is_empty() {
        out.push(Span::Text(text));
    }
    out
}

pub struct GuideView {
    page: usize,
    scroll: ScrollHandle,
}

impl GuideView {
    fn show(&mut self, file: &str, cx: &mut Context<Self>) {
        self.page = PAGES.iter().position(|(name, _)| *name == file).unwrap_or(0);
        self.scroll.set_offset(point(px(0.0), px(0.0)));
        cx.notify();
    }

    /// A line of text with its code, bold and links (links to other pages
    /// open them; the app has no browser, so web addresses are shown).
    fn inline(&self, id: usize, source: &str, base: Hsla, size: f32, cx: &mut Context<Self>) -> AnyElement {
        let palette = theme::current();
        let mut text = String::new();
        let mut runs = Vec::new();
        let mut links = Vec::new();
        let font = |family: &'static str, weight: FontWeight| Font { family: family.into(), weight, ..Font::default() };
        let mut push = |piece: &str, font: Font, color: Hsla, text: &mut String| {
            runs.push(TextRun { len: piece.len(), font, color, background_color: None, underline: None, strikethrough: None, letter_spacing: None });
            text.push_str(piece);
        };
        for span in spans(source) {
            match span {
                Span::Text(piece) => push(&piece, font(theme::ui(), FontWeight::NORMAL), base, &mut text),
                Span::Code(piece) => push(&piece, font(theme::mono(), FontWeight::NORMAL), crate::theme::hsla(palette.text), &mut text),
                Span::Bold(piece) => push(&piece, font(theme::ui(), FontWeight::SEMIBOLD), crate::theme::hsla(palette.text), &mut text),
                Span::Link(label, target) if target.starts_with("http://") || target.starts_with("https://") => {
                    push(&format!("{label} ({target})"), font(theme::ui(), FontWeight::NORMAL), base, &mut text)
                }
                Span::Link(label, target) => {
                    let start = text.len();
                    push(&label, font(theme::ui(), FontWeight::NORMAL), crate::theme::hsla(palette.accent), &mut text);
                    links.push((start..text.len(), target));
                }
            }
        }
        if text.is_empty() {
            return div().into_any_element();
        }
        let styled = StyledText::new(text).with_runs(runs);
        let ranges: Vec<_> = links.iter().map(|(range, _)| range.clone()).collect();
        let targets: Vec<String> = links.into_iter().map(|(_, target)| target).collect();
        let me = cx.entity().downgrade();
        div()
            .text_size(r(size))
            .line_height(r(size * 1.6))
            .child(InteractiveText::new(("guide-text", id), styled).on_click(ranges, move |index, _, cx| {
                let target = targets[index].clone();
                me.update(cx, |guide, cx| guide.show(&target, cx)).ok();
            }))
            .into_any_element()
    }

    fn render_page(&self, cx: &mut Context<Self>) -> Div {
        let palette = theme::current();
        let muted: Hsla = crate::theme::hsla(palette.muted);
        let lines: Vec<&str> = PAGES[self.page].1.split('\n').map(|line| line.trim_end_matches('\r')).collect();
        let mut page = div().flex().flex_col();
        let mut i = 0;
        let mut id = 0;
        let is_item = |line: &str| line.starts_with("- ") || line.split_once(". ").is_some_and(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
        let block_start = |line: &str| line.starts_with('#') || line.starts_with("```") || line.starts_with("![") || line.starts_with('|') || is_item(line);
        while i < lines.len() {
            id += 1;
            let line = lines[i];
            if line.trim().is_empty() {
                i += 1;
            } else if line.starts_with("```") {
                let mut code = Vec::new();
                i += 1;
                while i < lines.len() && !lines[i].starts_with("```") {
                    code.push(lines[i]);
                    i += 1;
                }
                i += 1;
                page = page.child(
                    div()
                        .my(r(10.0))
                        .px(r(12.0))
                        .py(r(10.0))
                        .bg(palette.input)
                        .border_1()
                        .border_color(palette.border)
                        .rounded(r(10.0))
                        .font_family(theme::mono())
                        .text_size(r(12.0))
                        .line_height(r(18.0))
                        .children(code.iter().map(|line| div().whitespace_nowrap().child(if line.is_empty() { " ".to_string() } else { line.to_string() }))),
                );
            } else if let Some((hashes, heading)) =
                line.split_once(' ').filter(|(hashes, _)| (1..=3).contains(&hashes.len()) && hashes.chars().all(|c| c == '#'))
            {
                let first = hashes.len() == 1;
                page = page.child(
                    div().mt(r(if first { 0.0 } else { 18.0 })).mb(r(if first { 8.0 } else { 4.0 })).font_weight(FontWeight::BOLD).child(self.inline(
                        id,
                        heading,
                        crate::theme::hsla(palette.text),
                        if first { 18.0 } else { 14.0 },
                        cx,
                    )),
                );
                i += 1;
            } else if let Some(rest) = line.strip_prefix("![") {
                if let Some((alt, after)) = rest.split_once("](")
                    && let Some(path) = after.split(')').next()
                    && let Some(picture) = image(path)
                {
                    page = page.child(
                        div()
                            .my(r(12.0))
                            .flex()
                            .flex_col()
                            .child(img(picture).max_w_full().rounded(r(10.0)).border_1().border_color(palette.border))
                            .child(div().mt(r(4.0)).text_size(r(12.0)).text_color(palette.muted).child(alt.to_string())),
                    );
                }
                i += 1;
            } else if line.starts_with('|') {
                let mut rows: Vec<Vec<String>> = Vec::new();
                while i < lines.len() && lines[i].starts_with('|') {
                    let row = lines[i].trim();
                    let separator = row.chars().all(|c| matches!(c, '|' | ' ' | ':' | '-'));
                    if !separator {
                        let inner = row.trim_start_matches('|').trim_end_matches('|');
                        let mut cells = Vec::new();
                        let mut cell = String::new();
                        let mut escaped = false;
                        for c in inner.chars() {
                            if c == '|' && !escaped {
                                cells.push(cell.trim().to_string());
                                cell.clear();
                            } else if c == '\\' {
                                escaped = true;
                                continue;
                            } else {
                                if escaped && c != '|' {
                                    cell.push('\\');
                                }
                                cell.push(c);
                            }
                            escaped = false;
                        }
                        cells.push(cell.trim().to_string());
                        rows.push(cells);
                    }
                    i += 1;
                }
                let mut table = div().my(r(8.0)).flex().flex_col();
                for (row_index, row) in rows.iter().enumerate() {
                    let header = row_index == 0;
                    if header && row.iter().all(String::is_empty) {
                        continue;
                    }
                    let mut tr = div().flex().py(r(5.0));
                    for (column, cell) in row.iter().enumerate() {
                        id += 1;
                        let color: Hsla = if header || column == 0 { crate::theme::hsla(palette.text) } else { muted };
                        let mut td = div().pr(r(12.0)).child(self.inline(id, cell, color, 13.0, cx));
                        td = if column == 0 { td.w(r(220.0)).flex_none() } else { td.flex_1() };
                        if header {
                            td = td.font_weight(FontWeight::SEMIBOLD);
                        }
                        tr = tr.child(td);
                    }
                    table = table.child(tr);
                }
                page = page.child(table);
            } else if is_item(line) {
                let ordered = !line.starts_with("- ");
                let mut list = div().my(r(6.0)).pl(r(22.0)).flex().flex_col();
                let mut number = 0;
                while i < lines.len() && is_item(lines[i]) {
                    number += 1;
                    id += 1;
                    let text = lines[i].split_once(' ').map_or("", |(_, rest)| rest);
                    let marker = if ordered { format!("{number}.") } else { "•".to_string() };
                    list = list.child(
                        div()
                            .flex()
                            .gap(r(8.0))
                            .child(div().w(r(14.0)).flex_none().text_color(palette.muted).child(marker))
                            .child(div().flex_1().child(self.inline(id, text, muted, 13.0, cx))),
                    );
                    i += 1;
                }
                page = page.child(list);
            } else {
                let mut paragraph = Vec::new();
                while i < lines.len() && !lines[i].trim().is_empty() && !block_start(lines[i]) {
                    paragraph.push(lines[i]);
                    i += 1;
                }
                page = page.child(div().my(r(6.0)).child(self.inline(id, &paragraph.join(" "), muted, 13.0, cx)));
            }
        }
        page
    }
}

impl Render for GuideView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let mut nav = div().flex().flex_col().gap(r(2.0)).w(r(190.0)).flex_none();
        for (index, (file, text)) in PAGES.iter().enumerate() {
            let on = index == self.page;
            nav = nav.child(
                div()
                    .id(("guide-tab", index))
                    .px(r(10.0))
                    .py(r(7.0))
                    .rounded(r(8.0))
                    .cursor_pointer()
                    .text_color(if on { palette.text } else { palette.muted })
                    .when(on, |tab| tab.bg(palette.accent_soft).font_weight(FontWeight::SEMIBOLD))
                    .hover(move |style| style.bg(palette.accent_soft).text_color(palette.text))
                    .on_click(cx.listener(move |this, _, _, cx| this.show(file, cx)))
                    .child(title(text)),
            );
        }
        div()
            .flex()
            .gap(r(18.0))
            .h(window.viewport_size().height * 0.68)
            .child(nav)
            .child(div().id("guide-page").flex_1().min_w_0().overflow_y_scroll().track_scroll(&self.scroll).pr(r(6.0)).child(self.render_page(cx)))
    }
}

/// Opens the guide, optionally on a page ("02-expressions.md").
pub fn open(file: Option<&str>, window: &mut Window, cx: &mut App) {
    let view = cx.new(|_| GuideView { page: 0, scroll: ScrollHandle::new() });
    if let Some(file) = file {
        view.update(cx, |guide, cx| guide.show(file, cx));
    }
    window.open_dialog(cx, move |dialog, _, _| {
        modal::frame(dialog, "book-open", "Guide", true)
            .w(px(1040.0))
            .child(view.clone())
            .footer(modal::footer().child(Btn::new("guide-close", Look::Primary).label("Close").on_click(|_, window, cx| window.close_dialog(cx))))
    });
}

use crate::kit::prelude::FluentBuilder as _;

#[cfg(test)]
mod guide_tests {
    #[test]
    fn every_page_has_a_title_and_its_images() {
        for (file, text) in super::PAGES {
            assert!(!super::title(text).is_empty(), "{file}");
            for line in text.lines().filter(|line| line.starts_with("![")) {
                let path = line.split("](").nth(1).and_then(|rest| rest.split(')').next()).unwrap();
                assert!(super::image(path).is_some(), "{file}: {path}");
            }
        }
    }
}
