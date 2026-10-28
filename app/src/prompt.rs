//! A small dialog that asks for one line of text: a width, a snapshot name,
//! an operand. The answer is checked on OK (or Enter); when it can't be used
//! the reason shows under the field and the dialog stays open.

use std::rc::Rc;

use crate::kit::component::WindowExt;
use crate::kit::component::input::{InputEvent, InputState};
use crate::kit::*;

use crate::theme;
use crate::widgets::{Btn, Look, r};

/// What to do once the prompt has closed (e.g. ask about a protected field).
pub type Then = Option<Box<dyn FnOnce(&mut Window, &mut App)>>;

type Submit = Rc<dyn Fn(&str, &mut Window, &mut App) -> Result<Then, String>>;

pub struct Prompt {
    input: Entity<InputState>,
    hint: SharedString,
    error: Option<String>,
    submit: Submit,
    _subscription: Subscription,
}

impl Prompt {
    /// Checks the answer and closes the dialog when `submit` accepts it.
    fn confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let text = self.input.read(cx).value().to_string();
        match (self.submit)(&text, window, cx) {
            Ok(then) => {
                window.close_dialog(cx);
                if let Some(then) = then {
                    then(window, cx);
                }
                true
            }
            Err(error) => {
                self.error = Some(error);
                cx.notify();
                false
            }
        }
    }
}

impl Render for Prompt {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let palette = theme::current();
        div()
            .flex()
            .flex_col()
            .child(div().mt(r(4.0)).mb(r(8.0)).text_color(palette.muted).child(self.hint.clone()))
            .child(div().debug_selector(|| "prompt-input".into()).child(crate::value_dialogs::field_box(&self.input, self.error.is_some(), 34.0, false)))
            .children(self.error.clone().map(|error| div().mt(r(6.0)).text_size(r(12.0)).text_color(palette.error).child(error)))
    }
}

/// Opens the dialog. `submit` gets the text; Ok closes it (and runs what Ok
/// holds after that), Err shows why not.
pub fn ask(
    window: &mut Window,
    cx: &mut App,
    title: impl Into<SharedString>,
    hint: impl Into<SharedString>,
    initial: impl Into<SharedString>,
    submit: impl Fn(&str, &mut Window, &mut App) -> Result<Then, String> + 'static,
) {
    ask_with("pencil-line", window, cx, title, hint, initial, submit)
}

/// `ask` with the dialog's icon.
pub fn ask_with(
    icon_name: &'static str,
    window: &mut Window,
    cx: &mut App,
    title: impl Into<SharedString>,
    hint: impl Into<SharedString>,
    initial: impl Into<SharedString>,
    submit: impl Fn(&str, &mut Window, &mut App) -> Result<Then, String> + 'static,
) {
    let (title, hint, initial) = (title.into(), hint.into(), initial.into());
    let submit: Submit = Rc::new(submit);
    let prompt = cx.new(|cx| {
        let input = cx.new(|cx| InputState::new(window, cx).default_value(initial));
        let subscription = cx.subscribe_in(&input, window, |this: &mut Prompt, _, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { .. } = event {
                this.confirm(window, cx);
            }
        });
        Prompt { input, hint, error: None, submit, _subscription: subscription }
    });
    let input = prompt.read(cx).input.clone();
    input.update(cx, |state, cx| {
        state.focus(window, cx);
        state.select_all(window, cx);
    });

    window.open_dialog(cx, move |dialog, _, _| {
        let ok = prompt.clone();
        crate::modal::frame(dialog, icon_name, title.clone(), false).child(prompt.clone()).footer(
            crate::modal::footer()
                .child(Btn::new("prompt-cancel", Look::Ghost).label("Cancel").test_label("prompt-cancel").on_click(|_, window, cx| window.close_dialog(cx)))
                .child(Btn::new("prompt-ok", Look::Primary).label("OK").test_label("prompt-ok").on_click(move |_, window, cx| {
                    ok.update(cx, |prompt, cx| prompt.confirm(window, cx));
                })),
        )
    });
}
