//! Help (searchable topics and shortcuts) and About, as the web app's
//! dialogs/help.ts.

use crate::kit::component::WindowExt;
use crate::kit::component::input::{Input, InputEvent, InputState};
use crate::kit::*;

use crate::commands::COMMANDS;
use crate::modal;
use crate::theme;
use crate::widgets::{Btn, Look, icon, r};
use crate::workspace_view::logo;

/// The web app's version this port matches.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Short reminders (the web app's TOPICS).
const TOPICS: [(&str, &str); 13] = [
    ("Bits", "Click a bit to flip it, drag to select, Shift+click to extend. Right-click a bit for row operations."),
    ("Typing values", "Type in the selected base. 0x / 0b / 0o prefixes override it; spaces and _ are ignored. Esc reverts."),
    ("Paint mode", "Alt+drag sets bits to 1, Alt+Shift+drag sets them to 0."),
    ("Expressions", "The ƒx button opens an expression bar, e.g. 0x1F << 3 | bit(31). x is this value; field names work too."),
    ("Register fields", "Select bits and press Group selection (Ctrl+G). Right-click a field to rename, recolour or resize it."),
    ("Operations", "NOT, CLR, SET and shifts are on the toolbar, more under ⌄. They act on the selection when there is one."),
    ("Compare rows & snapshots", "Compare adds a linked row that outlines differing bits. Snapshots are in a value's ⋯ menu."),
    ("Generate code", "Name your fields, then ⋯ › Export code writes C, Rust or Python for them. Pick 32 or 64-bit registers for structs."),
    ("Export templates", "In Export code, + writes your own template for any language: your text with ${…} values and @for / @if lines."),
    ("Templates", "Templates apply ready-made field layouts, such as IEEE-754 floats or RGB565."),
    (
        "Peripherals",
        "Group values into a peripheral with a base address (⋯ › Peripheral): each register shows its address, and Export writes a C struct or Rust module for the whole block.",
    ),
    (
        "CMSIS-SVD import",
        "File › Import CMSIS-SVD… (or drop a .svd file) adds a chip's registers as values, with fields, reset values and named values, or saves them as templates.",
    ),
    ("Workspace", "Ctrl+Z / Ctrl+Y undo and redo, work is auto-saved, Ctrl+F searches (type, then press Enter), Ctrl+K opens the command palette."),
];

/// The guide page each topic links to (as TOPICS).
const GUIDE_PAGES: [&str; 13] = [
    "01-bits-and-values.md",
    "01-bits-and-values.md",
    "01-bits-and-values.md",
    "02-expressions.md",
    "03-register-fields.md",
    "04-operations-and-compare.md",
    "04-operations-and-compare.md",
    "06-generating-code.md",
    "07-export-templates.md",
    "05-templates-and-workspace.md",
    "09-peripherals.md",
    "08-importing-svd.md",
    "05-templates-and-workspace.md",
];

/// "Ctrl+Shift+S" as key caps.
pub fn key_caps(spec: &str) -> Div {
    let palette = theme::current();
    let parts: Vec<String> = match spec.strip_suffix("++") {
        Some(rest) => rest.split('+').map(String::from).chain(["+".to_string()]).collect(),
        None => spec.split('+').map(String::from).collect(),
    };
    let mut caps = div().flex().items_center();
    for part in parts {
        caps = caps.child(
            div()
                .min_w(r(20.0))
                .px(r(6.0))
                .py(r(2.0))
                .mx(r(1.0))
                .flex()
                .justify_center()
                .font_family(theme::mono())
                .font_weight(FontWeight::MEDIUM)
                .text_size(r(11.0))
                .text_color(palette.text)
                .bg(palette.surface_3)
                .border_1()
                .border_b_2()
                .border_color(palette.border_strong)
                .rounded(r(5.0))
                .child(part),
        );
    }
    caps
}

pub struct HelpView {
    search: Entity<InputState>,
    _subscription: Subscription,
}

impl Render for HelpView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let query = self.search.read(cx).value().to_lowercase();
        let words: Vec<&str> = query.split_whitespace().collect();
        let hit = |text: &str| {
            let text = text.to_lowercase();
            words.iter().all(|word| text.contains(word))
        };
        let mut list = div().id("help-list").flex().flex_col().max_h(r(440.0)).overflow_y_scroll().pr(r(4.0));
        let mut any = false;
        for (index, (title, body)) in TOPICS.iter().enumerate() {
            if !hit(&format!("{title} {body}")) {
                continue;
            }
            any = true;
            // the topic, then a link to its guide page
            let text = format!("{body} Learn more");
            let link = body.len() + 1..text.len();
            let font = Font { family: theme::ui().into(), ..Font::default() };
            let runs = vec![
                TextRun {
                    len: body.len() + 1,
                    font: font.clone(),
                    color: crate::theme::hsla(palette.muted),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                    letter_spacing: None,
                },
                TextRun {
                    len: "Learn more".len(),
                    font,
                    color: crate::theme::hsla(palette.accent),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                    letter_spacing: None,
                },
            ];
            let page = GUIDE_PAGES[index];
            list = list
                .child(div().mt(r(if index == 0 { 2.0 } else { 14.0 })).mb(r(4.0)).font_weight(FontWeight::BOLD).text_color(palette.text).child(*title))
                .child(div().line_height(r(20.0)).child(InteractiveText::new(("topic", index), StyledText::new(text).with_runs(runs)).on_click(
                    vec![link],
                    move |_, window, cx| {
                        window.close_dialog(cx);
                        crate::guide_dialog::open(Some(page), window, cx);
                    },
                )));
        }
        let shortcuts: Vec<_> = COMMANDS
            .iter()
            .filter(|command| !command.keys.is_empty() && command.keys != ["Esc"] || command.id == "sel.clear")
            .filter(|command| hit(&format!("{} {} shortcut", command.label, command.keys.join(" "))))
            .collect();
        if !shortcuts.is_empty() {
            any = true;
            list = list.child(div().mt(r(14.0)).mb(r(4.0)).font_weight(FontWeight::BOLD).child("Shortcuts"));
            let mut grid = div().flex().flex_col().gap(r(7.0)).text_color(palette.muted);
            for command in shortcuts {
                let mut keys = div().flex().items_center().gap(r(4.0));
                for key in command.keys {
                    keys = keys.child(key_caps(key));
                }
                grid = grid.child(div().flex().items_center().justify_between().gap(r(16.0)).child(command.label).child(keys));
            }
            list = list.child(grid);
        }
        if !any {
            list = list.child(div().text_color(palette.muted).child("Nothing found — try another word."));
        }
        div()
            .flex()
            .flex_col()
            .child(
                div().flex().items_center().gap(r(8.0)).mb(r(8.0)).child(icon("search", 15.0).text_color(palette.muted)).child(
                    div()
                        .flex_1()
                        .h(r(32.0))
                        .px(r(10.0))
                        .flex()
                        .items_center()
                        .rounded(r(8.0))
                        .bg(palette.input)
                        .border_1()
                        .border_color(palette.border_strong)
                        .child(Input::new(&self.search).appearance(false).w_full()),
                ),
            )
            .child(list)
    }
}

pub fn open_help(window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search help…"));
        search.update(cx, |search, cx| search.focus(window, cx));
        let subscription = cx.subscribe(&search, |_, _, _: &InputEvent, cx| cx.notify());
        HelpView { search, _subscription: subscription }
    });
    window.open_dialog(cx, move |dialog, _, _| {
        modal::frame(dialog, "circle-question-mark", "Help", true).child(view.clone()).footer(
            modal::footer()
                .child(Btn::new("help-guide", Look::Outline).icon("book-open").label("Open the guide").on_click(|_, window, cx| {
                    window.close_dialog(cx);
                    window.dispatch_action(Box::new(crate::commands::HelpGuide), cx);
                }))
                .child(Btn::new("help-tour", Look::Outline).icon("sparkles").label("Take the tour").on_click(|_, window, cx| {
                    window.close_dialog(cx);
                    window.dispatch_action(Box::new(crate::commands::HelpTour), cx);
                }))
                .child(Btn::new("help-close", Look::Primary).label("Close").on_click(|_, window, cx| window.close_dialog(cx))),
        )
    });
}

pub fn open_about(window: &mut Window, cx: &mut App) {
    window.open_dialog(cx, move |dialog, _, _| {
        let palette = theme::current();
        modal::frame(dialog, "info", "About", false)
            .child(
                div().flex().items_center().gap(r(16.0)).pt(r(4.0)).pb(r(8.0)).child(logo(64.0)).child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(r(2.0))
                        .child(div().text_size(r(18.0)).font_weight(FontWeight::BOLD).child("Bit Viewer"))
                        .child(div().text_color(palette.muted).child(format!("Version {VERSION}")))
                        .child(div().child("Inspect and edit values of 1 to 512 bits, bit by bit.")),
                ),
            )
            .footer(modal::footer().child(Btn::new("about-close", Look::Primary).label("Close").on_click(|_, window, cx| window.close_dialog(cx))))
    });
}

/// A changelog line: `code`, **bold**, and links as their text.
fn changelog_line(text: &str) -> StyledText {
    let palette = theme::current();
    let mut out = String::new();
    let mut runs = Vec::new();
    let font = |family: &'static str, weight: FontWeight| Font { family: family.into(), weight, ..Font::default() };
    let mut push = |piece: &str, font: Font, out: &mut String| {
        if piece.is_empty() {
            return;
        }
        runs.push(TextRun {
            len: piece.len(),
            font,
            color: crate::theme::hsla(palette.text),
            background_color: None,
            underline: None,
            strikethrough: None,
            letter_spacing: None,
        });
        out.push_str(piece);
    };
    let mut rest = text;
    while !rest.is_empty() {
        let next = [rest.find('`'), rest.find("**"), rest.find('[')].into_iter().flatten().min().unwrap_or(rest.len());
        push(&rest[..next], font(theme::ui(), FontWeight::NORMAL), &mut out);
        rest = &rest[next..];
        if let Some(after) = rest.strip_prefix('`')
            && let Some(end) = after.find('`').filter(|end| *end > 0)
        {
            push(&after[..end], font(theme::mono(), FontWeight::NORMAL), &mut out);
            rest = &after[end + 1..];
        } else if let Some(after) = rest.strip_prefix("**")
            && let Some(end) = after.find("**").filter(|end| *end > 0)
        {
            push(&after[..end], font(theme::ui(), FontWeight::BOLD), &mut out);
            rest = &after[end + 2..];
        } else if let Some(after) = rest.strip_prefix('[')
            && let Some((label, target)) = after.split_once("](")
            && !label.contains(']')
            && let Some(end) = target.find(')')
        {
            push(label, font(theme::ui(), FontWeight::NORMAL), &mut out);
            rest = &target[end + 1..];
        } else if !rest.is_empty() {
            let c = rest.chars().next().unwrap();
            push(&rest[..c.len_utf8()], font(theme::ui(), FontWeight::NORMAL), &mut out);
            rest = &rest[c.len_utf8()..];
        }
    }
    StyledText::new(out).with_runs(runs)
}

/// "Bit Viewer X.Y.Z Changes": this version's entry from CHANGELOG.md.
/// False (no dialog) when the changelog has none.
pub fn open_whats_new(window: &mut Window, cx: &mut App) -> bool {
    let Some(release) = bitviewer_core::changelog::find_release(include_str!("../../CHANGELOG.md"), VERSION) else {
        return false;
    };
    window.open_dialog(cx, move |dialog, window, _| {
        let palette = theme::current();
        let mut notes =
            div().id("whats-new").w_full().flex().flex_col().max_h(window.viewport_size().height * 0.55).overflow_y_scroll().line_height(r(13.0 * 1.55));
        if !release.date.is_empty() {
            notes = notes.child(div().mb(r(6.0)).text_color(palette.muted).child(format!("Released {}", release.date)));
        }
        for section in &release.sections {
            if !section.title.is_empty() {
                notes = notes.child(
                    div().mt(r(14.0)).mb(r(4.0)).text_size(r(13.0)).font_weight(FontWeight::BOLD).text_color(palette.muted).child(section.title.to_uppercase()),
                );
            }
            for item in &section.items {
                notes = notes.child(
                    div()
                        .flex()
                        .gap(r(8.0))
                        .my(r(4.0))
                        .pl(r(6.0))
                        .child(div().flex_none().text_color(palette.muted).child("•"))
                        // min_w_0: the line may be narrower than its text, so it wraps
                        .child(div().flex_1().min_w_0().child(changelog_line(item))),
                );
            }
        }
        modal::frame(dialog, "scroll-text", format!("Bit Viewer {VERSION} Changes"), true)
            .child(notes)
            .footer(modal::footer().child(Btn::new("whatsnew-close", Look::Primary).label("Close").on_click(|_, window, cx| window.close_dialog(cx))))
    });
    true
}
