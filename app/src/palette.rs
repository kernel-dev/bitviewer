//! The command palette (Ctrl+K): type to find any command, Enter runs it.
//! The ranking and the look are the web app's palette.ts and overlays.css.

use crate::kit::component::input::{Input, InputEvent, InputState};
use crate::kit::*;

use crate::commands::{COMMANDS, Command};
use crate::theme;
use crate::widgets::r;
use crate::workspace_view::WorkspaceView;

/// How well a command matches the query words; None: no match.
pub fn score(label: &str, extra: &str, query: &str) -> Option<u32> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Some(0);
    }
    let label = label.to_lowercase();
    let haystack = format!("{label} {}", extra.to_lowercase());
    let mut total = 0;
    for word in query.split_whitespace() {
        let at = haystack.find(word)?;
        total += if label.starts_with(word) {
            30
        } else if word_start(&label, word) {
            20
        } else if at < label.len() {
            10
        } else {
            2 // only in the keywords or the group
        };
    }
    Some(total)
}

/// `word` starts a word somewhere in `text` (as the regex \bword).
fn word_start(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(at, _)| {
        let starts_word = word.chars().next().is_some_and(|c| c.is_alphanumeric() || c == '_');
        let before = text[..at].chars().next_back();
        let boundary = |c: Option<char>| c.is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
        !starts_word || boundary(before)
    })
}

/// Commands the palette offers (the palette itself and the browser no-ops aren't).
fn offered() -> impl Iterator<Item = (usize, &'static Command)> {
    COMMANDS.iter().enumerate().filter(|(_, command)| command.id != "app.palette")
}

pub struct PaletteView {
    input: Entity<InputState>,
    /// Indices into COMMANDS, best match first.
    shown: Vec<usize>,
    active: usize,
    workspace: WeakEntity<WorkspaceView>,
    _subscription: Subscription,
}

impl PaletteView {
    pub fn new(workspace: WeakEntity<WorkspaceView>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Type a command…"));
        input.update(cx, |input, cx| input.focus(window, cx));
        let subscription = cx.subscribe_in(&input, window, |this, input, event: &InputEvent, window, cx| match event {
            InputEvent::Change => {
                let query = input.read(cx).value().to_string();
                this.filter(&query);
                cx.notify();
            }
            InputEvent::PressEnter { .. } => this.run(this.active, window, cx),
            _ => {}
        });
        let mut palette = PaletteView { input, shown: Vec::new(), active: 0, workspace, _subscription: subscription };
        palette.filter("");
        palette
    }

    fn filter(&mut self, query: &str) {
        let mut ranked: Vec<(u32, usize)> = offered()
            .filter_map(|(index, command)| score(command.label, &format!("{} {}", command.keywords, command.group.name()), query).map(|s| (s, index)))
            .collect();
        // best first; equal scores keep the commands' order
        ranked.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        self.shown = ranked.into_iter().map(|(_, index)| index).collect();
        self.active = 0;
    }

    fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.workspace.update(cx, |workspace, cx| workspace.close_palette(window, cx)).ok();
    }

    fn run(&mut self, position: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(&index) = self.shown.get(position) else { return };
        self.close(window, cx);
        window.dispatch_action((COMMANDS[index].action)(), cx);
    }

    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let count = self.shown.len();
        match event.keystroke.key.as_str() {
            "escape" => self.close(window, cx),
            "down" | "up" if count > 0 => {
                let step = if event.keystroke.key == "down" { 1 } else { count - 1 };
                self.active = (self.active + step) % count;
                cx.notify();
            }
            "enter" => self.run(self.active, window, cx),
            _ => return,
        }
        cx.stop_propagation();
    }
}

impl Render for PaletteView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        let viewport = window.viewport_size();
        let mut list = div().id("palette-list").flex().flex_col().p(r(6.0)).overflow_y_scroll();
        if self.shown.is_empty() {
            list = list.child(div().p(r(14.0)).flex().justify_center().text_color(palette.muted).child("No matching commands"));
        }
        for (position, &index) in self.shown.iter().enumerate() {
            let command = &COMMANDS[index];
            let active = position == self.active;
            let key = command.keys.first().copied().unwrap_or("");
            list = list.child(
                div()
                    .id(("palette-item", index))
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(r(10.0))
                    .w_full()
                    .h(r(34.0))
                    .px(r(10.0))
                    .rounded(r(8.0))
                    .text_size(r(13.0))
                    .cursor_pointer()
                    .when(active, |item| item.bg(palette.accent_soft))
                    .on_mouse_move(cx.listener(move |this, _: &MouseMoveEvent, _, cx| {
                        if this.active != position {
                            this.active = position;
                            cx.notify();
                        }
                    }))
                    .on_click(cx.listener(move |this, _, window, cx| this.run(position, window, cx)))
                    .child(div().w(r(15.0)).flex_none())
                    .child(
                        div()
                            .w(r(44.0))
                            .flex_none()
                            .text_size(r(10.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(palette.faint)
                            .child(command.group.name().to_uppercase()),
                    )
                    .child(div().flex_1().overflow_hidden().whitespace_nowrap().text_ellipsis().child(command.label))
                    .when(!key.is_empty(), |item| item.child(div().font_family(theme::mono()).text_size(r(11.0)).text_color(palette.muted).child(key))),
            );
        }
        let panel = div()
            .id("palette")
            .flex()
            .flex_col()
            .w(r(620.0))
            .max_w(viewport.width * 0.92)
            .max_h(viewport.height * 0.64)
            .overflow_hidden()
            .bg(palette.elevated)
            .border_1()
            .border_color(palette.border_strong)
            .rounded(r(14.0))
            .shadow_lg()
            .capture_key_down(cx.listener(Self::on_key))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .flex()
                    .items_center()
                    .h(r(48.0))
                    .px(r(18.0))
                    .border_b_1()
                    .border_color(palette.border)
                    .text_size(r(15.0))
                    .child(Input::new(&self.input).appearance(false).w_full()),
            )
            .child(list);
        div()
            .absolute()
            .inset_0()
            .flex()
            .justify_center()
            .items_start()
            .pt(viewport.height * 0.12)
            .bg(Rgba::new(0.0, 0.0, 0.0, 0.45))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| this.close(window, cx)))
            .child(panel)
    }
}

use crate::kit::prelude::FluentBuilder as _;

#[cfg(test)]
mod palette_tests {
    #[test]
    fn ranks_like_the_web_app() {
        use super::score;
        assert_eq!(score("Save as…", "", "save"), Some(30));
        assert_eq!(score("Add 32-bit value", "new", "value"), Some(20));
        assert_eq!(score("Add 32-bit value", "new", "new"), Some(2));
        assert_eq!(score("Open…", "", "zzz"), None);
        assert_eq!(score("Open…", "", "  "), Some(0));
    }
}
