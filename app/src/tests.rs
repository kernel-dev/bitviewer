//! Interface tests: a real window with simulated mouse and keyboard input
//! (GPUI's test platform), the way the web app's browser tests drive it.
//! Elements are found by their debug labels, e.g. "v0-bit-3".

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use bitviewer_core::integers::{Base, Bits};
use bitviewer_core::rows::View;
use bitviewer_core::value::Value;
use bitviewer_core::workspace::WorkspaceState;
use gpui::{AppContext as _, Entity, Modifiers, MouseButton, TestAppContext, VisualTestContext};
use gpui_kit::base::Root;

use crate::workspace_view::{self, WorkspaceView};

/// Select all in a text field: Cmd+A on macOS, Ctrl+A elsewhere.
const SELECT_ALL: &str = if cfg!(target_os = "macos") { "cmd-a" } else { "ctrl-a" };

fn value(width: usize, bits: u64) -> Value {
    Value::new(width, Bits::from(bits), "REG", View::Byte, Base::Hex).unwrap()
}

/// A window showing `values`.
fn open(cx: &mut TestAppContext, values: Vec<Value>) -> (Entity<WorkspaceView>, &mut VisualTestContext) {
    cx.update(|cx| workspace_view::init(Some(bitviewer_core::settings::Settings::default()), cx));
    let mut state = WorkspaceState::default();
    for value in values {
        state.values.push_back(Arc::new(value));
    }
    let made = Rc::new(RefCell::new(None));
    let slot = made.clone();
    let (_, cx) = cx.add_window_view(move |window, cx| {
        let view = cx.new(|cx| WorkspaceView::new(state, "test".into(), None, window, cx));
        *slot.borrow_mut() = Some(view.clone());
        Root::new(view, window, cx)
    });
    let view = made.borrow().clone().unwrap();
    draw(cx);
    (view, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        _ = window.draw(cx);
    });
    cx.run_until_parked();
}

fn center(cx: &mut VisualTestContext, label: &str) -> gpui::Point<gpui::Pixels> {
    let label: &'static str = Box::leak(label.to_string().into_boxed_str());
    cx.debug_bounds(label).unwrap_or_else(|| panic!("{label} isn't on screen")).center()
}

fn click(cx: &mut VisualTestContext, label: &str) {
    let at = center(cx, label);
    cx.simulate_click(at, Modifiers::none());
    draw(cx);
}

fn drag(cx: &mut VisualTestContext, from: &str, to: &str) {
    let (start, end) = (center(cx, from), center(cx, to));
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(end, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::none());
    draw(cx);
}

fn first(view: &Entity<WorkspaceView>, cx: &mut VisualTestContext) -> Value {
    view.read_with(cx, |view, _| Value::clone(&view.state().values[0]))
}

#[gpui::test]
fn clicking_a_bit_flips_it_and_undo_brings_it_back(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(8, 0)]);
    click(cx, "v0-bit-3");
    assert_eq!(first(&view, cx).value, Bits::from(0b1000u8));
    click(cx, "v0-bit-0");
    assert_eq!(first(&view, cx).value, Bits::from(0b1001u8));

    cx.simulate_keystrokes("ctrl-z");
    draw(cx);
    assert_eq!(first(&view, cx).value, Bits::from(0b1000u8));
    cx.simulate_keystrokes("ctrl-z");
    draw(cx);
    assert_eq!(first(&view, cx).value, Bits::ZERO);
    cx.simulate_keystrokes("ctrl-y");
    draw(cx);
    assert_eq!(first(&view, cx).value, Bits::from(0b1000u8));
}

#[gpui::test]
fn dragging_selects_bits_that_operations_and_fields_use(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(8, 0)]);
    drag(cx, "v0-bit-7", "v0-bit-4");
    // the drag selected bits 7..4 instead of flipping one
    assert_eq!(first(&view, cx).value, Bits::ZERO);

    click(cx, "v0-op-NOT");
    assert_eq!(first(&view, cx).value, Bits::from(0xF0u8));

    click(cx, "v0-make-field");
    click(cx, "prompt-ok"); // the suggested name
    let made = first(&view, cx);
    assert_eq!(made.fields.len(), 1);
    assert_eq!((made.fields[0].lo, made.fields[0].hi, &*made.fields[0].name), (4, 7, "FIELD1"));
}

#[gpui::test]
fn typing_a_value_changes_it_and_a_bad_one_does_not(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(16, 0)]);
    click(cx, "v0-input-Value");
    cx.simulate_keystrokes(SELECT_ALL);
    cx.simulate_input("12AB");
    draw(cx);
    assert_eq!(first(&view, cx).value, Bits::from(0x12ABu16));

    cx.simulate_input("Z");
    draw(cx);
    assert_eq!(first(&view, cx).value, Bits::from(0x12ABu16));

    // the typing is one undo step
    cx.simulate_keystrokes("escape");
    click(cx, "v0-bit-15");
    cx.simulate_keystrokes("ctrl-z");
    draw(cx);
    cx.simulate_keystrokes("ctrl-z");
    draw(cx);
    assert_eq!(first(&view, cx).value, Bits::ZERO);
}

#[gpui::test]
fn views_bases_and_compare_rows(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(16, 0x1234)]);
    click(cx, "v0-view-Nibbles");
    assert_eq!(first(&view, cx).view, View::Nibble);

    click(cx, "v0-base-DEC");
    assert_eq!(first(&view, cx).full_base, Base::Dec);

    click(cx, "v0-compare-0");
    assert!(first(&view, cx).has_compare(0));
    click(cx, "v0-cbit-0");
    assert_eq!(first(&view, cx).compares[&0], Bits::from(0x5u8));
}

#[gpui::test]
fn values_are_duplicated_and_removed(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(8, 7)]);
    // as in the web app, these are in the ⋯ menu and the command palette
    cx.dispatch_action(crate::commands::CardDuplicate);
    let names: Vec<String> = view.read_with(cx, |view, _| view.state().values.iter().map(|value| value.name.to_string()).collect());
    assert_eq!(names, ["REG", "REG copy"]);
    cx.dispatch_action(crate::commands::CardRemove); // the copy is the active value now
    assert_eq!(view.read_with(cx, |view, _| view.state().len()), 1);
}

/// A 16-bit value with a read-only top byte.
fn with_read_only_top() -> Value {
    use bitviewer_core::field::{Access, DetailsDraft};
    let mut value = value(16, 0);
    let top = value.add_field(8, 15, Some("STATUS"), None, None).unwrap();
    value.set_field_details(top, DetailsDraft { access: Some(Access::ReadOnly), ..Default::default() });
    value
}

#[gpui::test]
fn protected_fields_ask_before_changing(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![with_read_only_top()]);
    click(cx, "v0-bit-12");
    // asked; nothing changed yet
    assert_eq!(first(&view, cx).value, Bits::ZERO);
    click(cx, "dialog-cancel");
    assert_eq!(first(&view, cx).value, Bits::ZERO);

    click(cx, "v0-bit-12");
    click(cx, "dialog-change");
    assert_eq!(first(&view, cx).value, Bits::from(0x1000u16));

    // "Always" stops asking about that field
    click(cx, "v0-bit-13");
    click(cx, "dialog-always");
    click(cx, "v0-bit-14");
    assert_eq!(first(&view, cx).value, Bits::from(0x7000u16));

    // bits outside every field are reserved: locked too
    click(cx, "v0-bit-0");
    assert_eq!(first(&view, cx).value, Bits::from(0x7000u16));
    click(cx, "dialog-cancel");
    assert_eq!(first(&view, cx).value, Bits::from(0x7000u16));

    // "Always" unlocks the whole run of reserved bits
    click(cx, "v0-bit-0");
    click(cx, "dialog-always");
    assert_eq!(first(&view, cx).value, Bits::from(0x7001u16));
    click(cx, "v0-bit-5");
    assert_eq!(first(&view, cx).value, Bits::from(0x7021u16));
}

#[gpui::test]
fn values_without_fields_have_no_reserved_bits(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(8, 0)]);
    click(cx, "v0-bit-3");
    assert_eq!(first(&view, cx).value, Bits::from(0x08u8));
}

#[gpui::test]
fn the_expression_bar_sets_the_value_or_the_selection(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(16, 0x00F0)]);
    click(cx, "v0-expr");
    // the bar takes the keyboard when it opens
    cx.simulate_input("x | bit(12) + 1");
    cx.simulate_keystrokes("enter");
    draw(cx);
    // + binds tighter than |
    assert_eq!(first(&view, cx).value, Bits::from(0x10F1u16));

    drag(cx, "v0-bit-3", "v0-bit-0");
    click(cx, "v0-input-Expr");
    cx.simulate_keystrokes(SELECT_ALL);
    cx.simulate_input("-1");
    click(cx, "v0-expr-apply");
    // only the selected bits: -1 is all ones there
    assert_eq!(first(&view, cx).value, Bits::from(0x10FFu16));
}

#[gpui::test]
fn a_field_meaning_can_be_typed(cx: &mut TestAppContext) {
    use bitviewer_core::field::DetailsDraft;
    let mut temperature = value(8, 0);
    let field = temperature.add_field(0, 7, Some("TEMP"), None, None).unwrap();
    temperature.set_field_details(field, DetailsDraft { formula: Some("x * 0.5 - 40".into()), unit: Some("°C".into()), ..Default::default() });
    let (view, cx) = open(cx, vec![temperature]);
    click(cx, "v0-input-Meaning(0)");
    cx.simulate_keystrokes(SELECT_ALL);
    cx.simulate_input("21.5");
    draw(cx);
    assert_eq!(first(&view, cx).value, Bits::from(0x7Bu8));
}

#[gpui::test]
fn the_field_editor_changes_details_and_refuses_bad_ones(cx: &mut TestAppContext) {
    let mut register = value(8, 0x7B);
    register.add_field(0, 7, Some("RAW"), None, None).unwrap();
    let (view, cx) = open(cx, vec![register]);

    // the name is edited in the fields panel
    click(cx, "v0-input-FieldName(0)");
    cx.simulate_keystrokes(SELECT_ALL);
    cx.simulate_input("TEMP");
    cx.simulate_keystrokes("enter");
    draw(cx);

    // a formula with an unknown name can't be saved and the dialog stays
    click(cx, "v0-field-edit-0");
    click(cx, "field-formula");
    cx.simulate_input("y * 2");
    click(cx, "field-save");
    assert!(first(&view, cx).fields[0].details.formula.is_empty());

    click(cx, "field-formula");
    cx.simulate_keystrokes(SELECT_ALL);
    cx.simulate_input("x * 0.5 - 40");
    click(cx, "field-unit");
    cx.simulate_input("°C");
    click(cx, "access-ro");
    click(cx, "field-save");

    let saved = first(&view, cx);
    let field = &saved.fields[0];
    assert_eq!(&*field.name, "TEMP");
    assert_eq!(&*field.details.formula, "x * 0.5 - 40");
    assert_eq!(&*field.details.unit, "°C");
    assert_eq!(field.details.access, bitviewer_core::field::Access::ReadOnly);
    assert_eq!(bitviewer_core::meaning::decode_field(field, Bits::from(0x7Bu8)).unwrap(), "21.5 °C");

    // one undo step takes the details back
    cx.simulate_keystrokes("ctrl-z");
    draw(cx);
    assert!(first(&view, cx).fields[0].details.formula.is_empty());
    assert_eq!(&*first(&view, cx).fields[0].name, "TEMP");
}

/// Runs one of the card's menu actions on the first value.
fn menu_action(
    view: &Entity<WorkspaceView>,
    cx: &mut VisualTestContext,
    action: impl FnOnce(&mut crate::card::CardView, &mut gpui::Window, &mut gpui::Context<crate::card::CardView>),
) {
    let card = view.read_with(cx, |view, _| view.card_at(0)).expect("the card is on screen");
    cx.update(|window, cx| card.update(cx, |card, cx| action(card, window, cx)));
    draw(cx);
}

fn answer(cx: &mut VisualTestContext, text: &str) {
    click(cx, "prompt-input");
    cx.simulate_keystrokes(SELECT_ALL);
    cx.simulate_input(text);
    click(cx, "prompt-ok");
}

#[gpui::test]
fn menu_change_width_explains_what_it_refuses(cx: &mut TestAppContext) {
    let mut register = value(16, 0xFFFF);
    register.add_field(8, 15, Some("HI"), None, None).unwrap();
    let (view, cx) = open(cx, vec![register]);

    menu_action(&view, cx, |card, window, cx| card.width_prompt(window, cx));
    answer(cx, "8");
    // refused (the field wouldn't fit): the app says why
    click(cx, "dialog-ok");
    assert_eq!(first(&view, cx).width, 16);
    menu_action(&view, cx, |card, window, cx| card.width_prompt(window, cx));
    answer(cx, "24");
    assert_eq!(first(&view, cx).width, 24);
}

#[gpui::test]
fn menu_operations_take_any_expression(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(8, 0b0011_0110)]);
    menu_action(&view, cx, |card, window, cx| card.operand_prompt(bitviewer_core::ops::Op::And, window, cx));
    answer(cx, "mask(4)");
    assert_eq!(first(&view, cx).value, Bits::from(0b0110u8));

    menu_action(&view, cx, |card, window, cx| card.operand_prompt(bitviewer_core::ops::Op::Shl, window, cx));
    answer(cx, "1 + 1");
    assert_eq!(first(&view, cx).value, Bits::from(0b1_1000u8));
}

#[gpui::test]
fn pasted_bytes_still_ask_about_protected_fields(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![with_read_only_top()]);
    menu_action(&view, cx, |card, window, cx| card.paste_bytes_prompt(window, cx));
    answer(cx, "12 34");
    // the prompt closed; now the protected-field question is open
    assert_eq!(first(&view, cx).value, Bits::ZERO);
    click(cx, "dialog-change");
    assert_eq!(first(&view, cx).value, Bits::from(0x1234u16));
}

#[gpui::test]
fn snapshots_copy_and_compare(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(16, 0xBEEF)]);
    menu_action(&view, cx, |card, window, cx| card.take_snapshot_prompt(window, cx));
    answer(cx, "boot");
    let snapshots = first(&view, cx).snapshots;
    assert_eq!((&*snapshots[0].name, snapshots[0].value), ("boot", Bits::from(0xBEEFu16)));

    menu_action(&view, cx, |card, window, cx| card.copy_as(bitviewer_core::integers::Base::Hex, window, cx));
    let copied = cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()));
    assert_eq!(copied.as_deref(), Some("0xBEEF"));

    menu_action(&view, cx, |card, window, cx| card.compare_prompt(window, cx));
    answer(cx, "x ^ 0xFF");
    let compared = first(&view, cx);
    assert_eq!(compared.compares[&8], Bits::from(0xBEu8));
    assert_eq!(compared.compares[&0], Bits::from(0x10u8));
}

#[gpui::test]
fn the_palette_runs_commands(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(8, 1)]);
    cx.simulate_keystrokes("ctrl-k");
    draw(cx);
    cx.simulate_input("add 64");
    draw(cx);
    cx.simulate_keystrokes("enter");
    draw(cx);
    let widths: Vec<usize> = view.read_with(cx, |view, _| view.state().values.iter().map(|v| v.width).collect());
    assert_eq!(widths, [8, 64]);
}

#[gpui::test]
fn search_filters_values_as_you_type(cx: &mut TestAppContext) {
    let mut second = value(16, 0xBEEF);
    second.name = "STATUS".into();
    let (view, cx) = open(cx, vec![value(8, 1), second]);
    cx.simulate_keystrokes("ctrl-f");
    draw(cx);
    cx.simulate_input("status");
    draw(cx);
    // the search runs once typing pauses
    assert_eq!(view.read_with(cx, |view, _| view.shown_values()), 2);
    pause(cx);
    assert_eq!(view.read_with(cx, |view, _| view.shown_values()), 1);
    // Enter runs it at once; hex digits match too
    cx.simulate_keystrokes(&format!("{SELECT_ALL} backspace"));
    draw(cx);
    assert_eq!(view.read_with(cx, |view, _| view.shown_values()), 2);
    cx.simulate_input("0xbeef");
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert_eq!(view.read_with(cx, |view, _| view.shown_values()), 1);
    // hiding the bar keeps the results; only Clear discards them
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert_eq!(view.read_with(cx, |view, _| view.shown_values()), 1);
    assert!(cx.debug_bounds("search-results").is_some());
    click(cx, "search-edit");
    assert_eq!(view.read_with(cx, |view, _| view.shown_values()), 1);
    click(cx, "search-close");
    assert_eq!(view.read_with(cx, |view, _| view.shown_values()), 1);
    click(cx, "results-clear");
    assert_eq!(view.read_with(cx, |view, _| view.shown_values()), 2);
    assert!(cx.debug_bounds("search-results").is_none());
}

#[gpui::test]
fn a_filtered_list_holds_only_the_values_on_show(cx: &mut TestAppContext) {
    let values = (0..400)
        .map(|index| {
            let mut value = value(8, index as u64 % 256);
            value.name = if index % 100 == 7 { format!("NEEDLE{index}").into() } else { format!("V{index}").into() };
            value
        })
        .collect();
    let (view, cx) = open(cx, values);
    cx.simulate_keystrokes("ctrl-f");
    draw(cx);
    cx.simulate_input("needle");
    cx.simulate_keystrokes("enter");
    draw(cx);
    // four matches: the list has four rows, not 400 mostly empty ones
    assert_eq!(view.read_with(cx, |view, _| (view.shown_values(), view.list_rows())), (4, 4));
    click(cx, "search-clear");
    assert_eq!(view.read_with(cx, |view, _| view.list_rows()), 400);
}

/// Lets the search's typing pause pass.
fn pause(cx: &mut VisualTestContext) {
    cx.executor().advance_clock(std::time::Duration::from_millis(300));
    draw(cx);
}

#[gpui::test]
fn search_covers_every_peripheral_unless_limited(cx: &mut TestAppContext) {
    let mut a = value(8, 1);
    a.set_peripheral("UART", Some(0));
    a.name = "UART.CTRL".into();
    let mut b = value(8, 2);
    b.set_peripheral("GPIO", Some(4));
    b.name = "GPIO.CTRL".into();
    let (view, cx) = open(cx, vec![a, b]);
    let shown = |view: &Entity<WorkspaceView>, cx: &mut VisualTestContext| view.read_with(cx, |view, _| view.shown_values());
    click(cx, "page-GPIO");
    assert_eq!(shown(&view, cx), 1);
    cx.simulate_keystrokes("ctrl-f");
    draw(cx);
    cx.simulate_input("ctrl");
    pause(cx);
    // found in both peripherals, though GPIO's tab is open
    assert_eq!(shown(&view, cx), 2);
    click(cx, "search-scope");
    assert_eq!(shown(&view, cx), 1);
    click(cx, "search-scope");
    assert_eq!(shown(&view, cx), 2);
    // hiding the search keeps its results; clearing them goes back to the page
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert_eq!(shown(&view, cx), 2);
    click(cx, "results-clear");
    assert_eq!(shown(&view, cx), 1);
}

#[gpui::test]
fn arrow_keys_move_the_cursor_and_space_flips(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(8, 0)]);
    click(cx, "v0-bit-0"); // flips bit 0 and puts the cursor there
    assert_eq!(first(&view, cx).value, Bits::from(1u8));
    cx.simulate_keystrokes("left space");
    draw(cx);
    assert_eq!(first(&view, cx).value, Bits::from(3u8));
    cx.simulate_keystrokes("0");
    draw(cx);
    assert_eq!(first(&view, cx).value, Bits::from(1u8));
    cx.simulate_keystrokes("shift-left shift-left ctrl-g");
    draw(cx);
    click(cx, "prompt-ok");
    draw(cx);
    let fields: Vec<(usize, usize)> = first(&view, cx).fields.iter().map(|f| (f.lo, f.hi)).collect();
    assert_eq!(fields, [(1, 3)]);
}

#[gpui::test]
fn values_are_reordered_by_dragging_the_grip(cx: &mut TestAppContext) {
    let mut second = value(8, 2);
    second.name = "SECOND".into();
    let (view, cx) = open(cx, vec![value(8, 1), second]);
    let grip = center(cx, "v1-grip");
    let top = cx.debug_bounds("v0-grip").unwrap().top() - gpui::px(20.0);
    cx.simulate_mouse_down(grip, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(gpui::point(grip.x, top), MouseButton::Left, Modifiers::none());
    draw(cx);
    cx.simulate_mouse_up(gpui::point(grip.x, top), MouseButton::Left, Modifiers::none());
    draw(cx);
    let names: Vec<String> = view.read_with(cx, |view, _| view.state().values.iter().map(|v| v.name.to_string()).collect());
    assert_eq!(names, ["SECOND", "REG"]);
    cx.simulate_keystrokes("ctrl-z");
    draw(cx);
    let names: Vec<String> = view.read_with(cx, |view, _| view.state().values.iter().map(|v| v.name.to_string()).collect());
    assert_eq!(names, ["REG", "SECOND"]);
}

#[gpui::test]
fn svd_registers_become_values_in_their_peripherals(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(8, 1)]);
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../core/tests/fixtures/sample.svd");
    cx.update(|window, cx| view.update(cx, |view, cx| view.import_svd(Some(path), window, cx)));
    draw(cx);
    click(cx, "svd-add");
    // more than 50 registers would ask first; the sample has fewer
    let (count, blocks) = view.read_with(cx, |view, _| {
        let state = view.state();
        (state.len(), state.peripherals.len())
    });
    assert!(count > 1, "registers were added");
    assert!(blocks > 0, "with their peripherals");
    cx.simulate_keystrokes("ctrl-z");
    draw(cx);
    assert_eq!(view.read_with(cx, |view, _| view.state().len()), 1, "one undo step");
}

#[gpui::test]
fn the_tour_steps_through_and_is_remembered(cx: &mut TestAppContext) {
    let (_view, cx) = open(cx, vec![value(8, 1)]);
    cx.dispatch_action(crate::commands::HelpTour);
    draw(cx);
    let mut steps = 0;
    while cx.debug_bounds("tour-next").is_some() && steps < 20 {
        click(cx, "tour-next");
        steps += 1;
    }
    assert!(steps >= 5, "the tour has its steps ({steps})");
    assert!(cx.update(|_, cx| crate::app_state::settings(cx).tour_done));
}

#[gpui::test]
fn alt_drag_paints_bits_in_one_undo_step(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(8, 0)]);
    let (from, to) = (center(cx, "v0-bit-0"), center(cx, "v0-bit-3"));
    let (one, two) = (center(cx, "v0-bit-1"), center(cx, "v0-bit-2"));
    let alt = Modifiers { alt: true, ..Modifiers::none() };
    cx.simulate_mouse_down(from, MouseButton::Left, alt);
    cx.simulate_mouse_move(one, MouseButton::Left, alt);
    cx.simulate_mouse_move(two, MouseButton::Left, alt);
    cx.simulate_mouse_move(to, MouseButton::Left, alt);
    cx.simulate_mouse_up(to, MouseButton::Left, alt);
    draw(cx);
    assert_eq!(first(&view, cx).value, Bits::from(0b1111u8));
    cx.simulate_keystrokes("ctrl-z");
    draw(cx);
    assert_eq!(first(&view, cx).value, Bits::ZERO);
}

#[gpui::test]
fn a_float_can_be_typed_into_its_readout(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(32, 0)]);
    click(cx, "v0-float-0");
    cx.simulate_keystrokes(SELECT_ALL);
    cx.simulate_input("1.5");
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert_eq!(first(&view, cx).value, Bits::from(0x3FC0_0000u32));
}

#[gpui::test]
fn forms_ask_before_their_edits_are_thrown_away(cx: &mut TestAppContext) {
    let mut register = value(8, 0);
    register.add_field(0, 3, Some("RAW"), None, None).unwrap();
    let (view, cx) = open(cx, vec![register]);
    click(cx, "v0-field-edit-0");
    click(cx, "field-unit");
    cx.simulate_input("mV");
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert!(cx.debug_bounds("dialog-discard").is_some(), "asks first");
    click(cx, "dialog-keep");
    assert!(cx.debug_bounds("field-save").is_some(), "the form stays open");
    cx.simulate_keystrokes("escape");
    draw(cx);
    click(cx, "dialog-discard");
    assert!(cx.debug_bounds("field-save").is_none(), "the form is gone");
    assert!(first(&view, cx).fields[0].details.unit.is_empty(), "nothing was saved");
}

#[gpui::test]
fn pressing_elsewhere_drops_the_selection(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(8, 0)]);
    drag(cx, "v0-bit-1", "v0-bit-3");
    let selected = |view: &Entity<WorkspaceView>, cx: &mut VisualTestContext| view.read_with(cx, |view, cx| view.card_at(0).unwrap().read(cx).has_selection());
    assert!(selected(&view, cx));
    // an operation works on the selection and keeps it
    click(cx, "v0-op-NOT");
    assert!(selected(&view, cx));
    assert_eq!(first(&view, cx).value, Bits::from(0b1110u8));
    // the value's field doesn't work with the selection
    click(cx, "v0-input-Value");
    assert!(!selected(&view, cx));
}

#[gpui::test]
fn esc_puts_back_what_a_field_shows(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(8, 0x12)]);
    click(cx, "v0-input-Value");
    cx.simulate_keystrokes(SELECT_ALL);
    cx.simulate_input("zz");
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert_eq!(first(&view, cx).value, Bits::from(0x12u8));
    let text = view.read_with(cx, |view, cx| view.card_at(0).unwrap().read(cx).value_field_text(cx));
    assert_eq!(text, "12");
}

#[gpui::test]
fn an_interrupted_paint_stroke_still_ends_its_undo_step(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, vec![value(8, 0)]);
    let alt = Modifiers { alt: true, ..Modifiers::none() };
    let (from, next) = (center(cx, "v0-bit-0"), center(cx, "v0-bit-1"));
    let outside = center(cx, "toolbar-undo");
    cx.simulate_mouse_down(from, MouseButton::Left, alt);
    cx.simulate_mouse_move(next, MouseButton::Left, alt);
    // let go far from the bits
    cx.simulate_mouse_move(outside, MouseButton::Left, alt);
    cx.simulate_mouse_up(outside, MouseButton::Left, alt);
    draw(cx);
    click(cx, "v0-bit-7");
    assert_eq!(first(&view, cx).value, Bits::from(0b1000_0011u8));
    cx.simulate_keystrokes("ctrl-z");
    draw(cx);
    assert_eq!(first(&view, cx).value, Bits::from(0b11u8), "the click is a step of its own");
}

#[gpui::test]
fn peripheral_tabs_page_through_the_workspace(cx: &mut TestAppContext) {
    let mut a = value(8, 1);
    a.set_peripheral("UART", Some(0));
    let mut b = value(8, 2);
    b.set_peripheral("GPIO", Some(4));
    let (view, cx) = open(cx, vec![a, b, value(8, 3)]);
    let shown = |view: &Entity<WorkspaceView>, cx: &mut VisualTestContext| view.read_with(cx, |view, _| view.shown_values());
    assert_eq!(shown(&view, cx), 3);
    click(cx, "page-GPIO");
    assert_eq!(shown(&view, cx), 1);
    click(cx, "page-Values");
    assert_eq!(shown(&view, cx), 1);
    click(cx, "page-All");
    assert_eq!(shown(&view, cx), 3);
}

#[gpui::test]
fn colour_schemes_are_picked_in_settings(cx: &mut TestAppContext) {
    let (_view, cx) = open(cx, vec![value(8, 1)]);
    assert_eq!(cx.update(|_, cx| crate::app_state::settings(cx).scheme.clone()), "lavender");
    cx.update(crate::settings_dialog::open);
    draw(cx);
    click(cx, "scheme-plum");
    assert_eq!(cx.update(|_, cx| crate::app_state::settings(cx).scheme.clone()), "plum");
    assert_eq!(crate::theme::current().accent, gpui::rgb(0x6d3fc0));
    click(cx, "scheme-signal");
    assert_eq!(crate::theme::current().accent, crate::theme::Palette::light().accent);
}

#[gpui::test]
fn font_pairings_are_picked_in_settings(cx: &mut TestAppContext) {
    let (_view, cx) = open(cx, vec![value(8, 1)]);
    assert_eq!(cx.update(|_, cx| crate::app_state::settings(cx).fonts.clone()), "outfit");
    assert_eq!(crate::theme::ui(), "Outfit");
    cx.update(crate::settings_dialog::open);
    draw(cx);
    click(cx, "fonts-inter");
    assert_eq!(cx.update(|_, cx| crate::app_state::settings(cx).fonts.clone()), "inter");
    assert_eq!((crate::theme::ui(), crate::theme::mono()), ("Inter", "JetBrains Mono"));
    click(cx, "fonts-geist");
    assert_eq!(crate::theme::mono(), "Geist Mono");
}

/// cargo test --release -p bitviewer search_redraw_speed -- --ignored --nocapture
#[gpui::test]
#[ignore]
fn search_redraw_speed(cx: &mut TestAppContext) {
    let values = (0..50_000)
        .map(|index| {
            let mut value = value(32, index as u64);
            value.name = if index % 10_000 == 7 { format!("NEEDLE{index}").into() } else { format!("V{index}").into() };
            value
        })
        .collect();
    let (view, cx) = open(cx, values);
    cx.simulate_keystrokes("ctrl-f");
    draw(cx);
    cx.simulate_input("needle");
    cx.simulate_keystrokes("enter");
    draw(cx);
    let time = |cx: &mut VisualTestContext| {
        let started = std::time::Instant::now();
        for _ in 0..10 {
            view.update(cx, |_, cx| cx.notify());
            draw(cx);
        }
        started.elapsed() / 10
    };
    println!("filtered rows: {:?} per redraw", time(cx));
    // the old way: a row per value, the hidden ones empty
    view.update(cx, |view, _| view.unfilter_rows_for_test());
    draw(cx);
    println!("a row per value: {:?} per redraw", time(cx));
}
