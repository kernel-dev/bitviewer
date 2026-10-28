//! How a card looks, part by part, after the web app's card.css and
//! bits.css: the header, the tools line, the rows of bits (with field bars
//! and compare rows), the "All bases" and "Register fields" panels, the
//! expression bar and the readout chips. Sizes are CSS pixels (see `r`).

use bitviewer_core::field::Access;
use bitviewer_core::integers::{Base, Bits, format_int, popcount, signed_decimal};
use bitviewer_core::interpretations::{
    bcd_decode, bit_length, bytes_as_text, count_leading_zeros, count_trailing_zeros, decode_float, float_breakdown, float_kinds, format_float_kind,
    gray_to_binary, ones_complement,
};
use bitviewer_core::meaning::{decode_field, is_invertible};
use bitviewer_core::ops::Op;
use bitviewer_core::rows::View;
use gpui_kit::component::input::Input;
use gpui_kit::component::menu::{ContextMenuExt, PopupMenu, PopupMenuItem};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{CardView, Slot};
use crate::app_state;
use crate::theme::{self, mono, ui};
use crate::widgets::{Btn, Look, SegSize, badge, icon, r, seg_button, seg_icon_button, seg_track};

// ------------------------------------------------------------ geometry
const MIN_CELL: f32 = 17.0;
/// The page column's widest and its side padding (datasheet.dc.html: max-width 1120, padding 28).
pub const PAGE_WIDTH: f32 = 1120.0;
pub const PAGE_PAD: f32 = 28.0;
/// Padding inside a card, at its sides.
pub(crate) const CARD_PAD: f32 = 24.0;
/// Width of the workspace's sidebar.
pub const SIDEBAR_WIDTH: f32 = 236.0;

/// Widths of the grid row's columns other than the bits (CSS px).
const LABEL_W: f32 = 92.0;
const ROW_SEG_W: f32 = 40.0;
const ROW_BUTTON_W: f32 = 30.0;
const MENU_W: f32 = 26.0;
const READOUT_W: f32 = 24.0 * 7.2;
const COLUMN_GAP: f32 = 12.0;

/// Width of one character of the mono font at `size` px.
fn ch(size: f32) -> f32 {
    theme::mono_width(size)
}

/// How many bits go on a line of a line-view strip `available` px wide:
/// everything, else 256, 128 … 8, the widest whose cells stay usable.
fn line_length(bits: usize, available: f32) -> usize {
    // datasheet tables: 16 bits each (all of a narrower value), 8 when cramped
    let per_line = bits.min(16);
    if per_line <= 8 || available / per_line as f32 >= MIN_CELL + 4.0 { per_line } else { 8 }
}

fn shadow(color: Rgba, x: f32, y: f32, blur: f32, spread: f32, inset: bool) -> BoxShadow {
    BoxShadow { color: color.into(), offset: point(px(x), px(y)), blur_radius: px(blur), spread_radius: px(spread), inset }
}

/// A row's left edge: a bar in `color` (the link to its compare row).
fn left_border(mut element: Div, color: Rgba) -> Div {
    element.style().border_widths.left = Some(px(3.0).into());
    element.border_color(color).rounded_tr(r(10.0)).rounded_br(r(10.0))
}

/// "0x00 · 0 · 0o0" (and the character, for a printable byte).
fn readout_text(value: Bits, width: usize) -> String {
    let mut parts = vec![format_int(value, Base::Hex, width, true, false), value.to_string(), format_int(value, Base::Oct, width, true, false)];
    if width == 8 && (0x20..0x7f).contains(&value.to::<u64>()) {
        parts.push(format!("'{}'", value.to::<u8>() as char));
    }
    parts.join(" · ")
}

fn plural(count: usize, word: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { "s" })
}

/// How a text field looks (.field and its variants).
#[derive(Clone, Copy)]
pub(super) struct Look2 {
    /// None: takes the free space.
    pub width: Option<f32>,
    pub min_width: f32,
    pub height: f32,
    pub font: f32,
    pub mono: bool,
    /// The name in the card header: borderless until hovered.
    pub title: bool,
    /// The selection's field: outlined in the selection colour.
    pub select: bool,
    /// A field's meaning: in the float colour.
    pub float: bool,
    /// `width` is what it wants; it gives way (to `min_width`) when the
    /// row has less room, and its text fits itself to what is left.
    pub shrink: bool,
}

impl Look2 {
    pub fn mono(width: Option<f32>) -> Look2 {
        Look2 { width, min_width: 0.0, height: 30.0, font: 13.0, mono: true, title: false, select: false, float: false, shrink: false }
    }
}

// ------------------------------------------------------------ readout chips
struct Chip {
    id: &'static str,
    label: &'static str,
    short: fn(usize) -> String,
    tip: fn(usize) -> String,
    value: fn(Bits, usize) -> String,
}

const CHIPS: [Chip; 12] = [
    Chip { id: "u", label: "Unsigned", short: |w| format!("u{w}"), tip: |w| format!("Unsigned {w}-bit integer"), value: |v, _| v.to_string() },
    Chip { id: "s", label: "Signed", short: |w| format!("s{w}"), tip: |w| format!("Signed {w}-bit integer (two's complement)"), value: signed_decimal },
    Chip { id: "pop", label: "Set bits", short: |_| "set bits".into(), tip: |_| "Number of bits set to 1".into(), value: |v, _| popcount(v).to_string() },
    Chip { id: "float", label: "Floats (16 / 32 / 64-bit)", short: |_| "float".into(), tip: |_| String::new(), value: |_, _| String::new() },
    Chip {
        id: "text",
        label: "Text (UTF-8 / ASCII)",
        short: |_| "text".into(),
        tip: |_| "The bytes as text, most significant first; · marks non-printable bytes".into(),
        value: |v, w| {
            let text = bytes_as_text(v, w);
            if text.is_empty() { "(empty)".into() } else { format!("“{text}”") }
        },
    },
    Chip {
        id: "bcd",
        label: "BCD",
        short: |_| "BCD".into(),
        tip: |_| "Binary-coded decimal: each nibble is one decimal digit".into(),
        value: |v, w| bcd_decode(v, w).unwrap_or_else(|| "not BCD".into()),
    },
    Chip {
        id: "gray",
        label: "Gray code → binary",
        short: |_| "gray⁻¹".into(),
        tip: |_| "The value read as a Gray code, converted to plain binary".into(),
        value: |v, _| gray_to_binary(v).to_string(),
    },
    Chip { id: "ones", label: "One's complement", short: |_| "1's comp".into(), tip: |_| "Signed value in one's complement".into(), value: ones_complement },
    Chip {
        id: "clz",
        label: "Leading zeros",
        short: |_| "lead 0s".into(),
        tip: |_| "Number of leading zero bits".into(),
        value: |v, w| count_leading_zeros(v, w).to_string(),
    },
    Chip {
        id: "ctz",
        label: "Trailing zeros",
        short: |_| "trail 0s".into(),
        tip: |_| "Number of trailing zero bits".into(),
        value: |v, w| count_trailing_zeros(v, w).to_string(),
    },
    Chip {
        id: "parity",
        label: "Parity",
        short: |_| "parity".into(),
        tip: |_| "Even or odd number of set bits".into(),
        value: |v, _| if popcount(v) % 2 == 1 { "odd".into() } else { "even".into() },
    },
    Chip {
        id: "msb",
        label: "Highest set bit",
        short: |_| "top bit".into(),
        tip: |_| "Index of the highest bit that is 1".into(),
        value: |v, _| if v == Bits::ZERO { "none".into() } else { (bit_length(v) - 1).to_string() },
    },
];

const OPS_SHOWN: [(&str, Option<&str>, Op, &str); 5] = [
    ("NOT", None, Op::Invert, "Invert every bit (bitwise NOT)"),
    ("CLR", None, Op::Clear, "Clear every bit to 0"),
    ("SET", None, Op::Set, "Set every bit to 1"),
    ("<<", Some("chevrons-left"), Op::Shl, "Logical shift left by one bit"),
    (">>", Some("chevrons-right"), Op::Shr, "Logical shift right by one bit"),
];
const SEL_NOTE: &str = " — applies to the selection when bits are selected";

/// One entry of a card menu that runs `action` on the card.
pub(super) fn entry(
    card: &WeakEntity<CardView>,
    label: impl Into<SharedString>,
    icon_name: Option<&'static str>,
    action: impl Fn(&mut CardView, &mut Window, &mut Context<CardView>) + 'static,
) -> PopupMenuItem {
    let card = card.clone();
    let mut item = PopupMenuItem::new(label).on_click(move |_, window, cx| {
        card.update(cx, |card, cx| action(card, window, cx)).ok();
    });
    if let Some(name) = icon_name {
        item = item.icon(gpui_kit::component::Icon::empty().path(format!("icons/{name}.svg")));
    }
    item
}

/// The operations beyond the five on the tools line; `apply` runs one on
/// the value, the selection, a row or a compare row.
pub(super) fn more_ops_menu(
    menu: PopupMenu,
    card: &WeakEntity<CardView>,
    width: usize,
    row: Option<(usize, bool)>,
    apply: impl Fn(&mut CardView, Op, &mut Window, &mut Context<CardView>) + Clone + 'static,
) -> PopupMenu {
    let op = |label: &'static str, icon_name: Option<&'static str>, op: Op| {
        let apply = apply.clone();
        entry(card, label, icon_name, move |c, w, cx| apply(c, op, w, cx))
    };
    let ask = |label: &'static str, op: Op| entry(card, label, None, move |c, w, cx| c.operand_prompt_on(row, op, w, cx));
    menu.item(op("Rotate left", Some("rotate-ccw"), Op::Rol))
        .item(op("Rotate right", Some("rotate-cw"), Op::Ror))
        .item(op("Arithmetic shift right", Some("chevrons-right"), Op::Asr))
        .item(ask("Shift / rotate by…", Op::Shl))
        .separator()
        .item(op("Swap bytes", Some("arrow-left-right"), Op::Bswap).disabled(!width.is_multiple_of(8) || width < 16))
        .item(op("Reverse bits", Some("flip-horizontal-2"), Op::Brev))
        .separator()
        .item(op("Negate (two's complement)", Some("minus"), Op::Neg))
        .item(op("Increment", Some("plus"), Op::Inc))
        .item(op("Decrement", Some("minus"), Op::Dec))
        .separator()
        .item(ask("AND with…", Op::And))
        .item(ask("OR with…", Op::Or))
        .item(ask("XOR with…", Op::Xor))
}

impl CardView {
    /// The width the card's content has, in CSS px (from the window's width).
    fn content_width(&self, window: &Window, cx: &App) -> f32 {
        let zoom = app_state::settings(cx).zoom as f32;
        let window_width = f32::from(window.viewport_size().width) / zoom;
        // the page's column (beside the sidebar, at most 1120 px) less its
        // side padding, the scroll bar and the card's own padding
        (window_width - SIDEBAR_WIDTH).min(PAGE_WIDTH) - 2.0 * PAGE_PAD - 12.0 - 2.0 * CARD_PAD - 2.0
    }

    // ------------------------------------------------------------ text fields
    /// A text field: plain text styled as one until it is first clicked (a
    /// real editor per field would make every card that scrolls into view
    /// expensive to build), then a real editor.
    pub(super) fn field(&mut self, slot: Slot, look: Look2, window: &mut Window, cx: &mut Context<Self>) -> Stateful<Div> {
        let palette = theme::current();
        let error = self.errors.get(&slot).cloned();
        let input = self.inputs.get(&slot).cloned();
        let focused = input.as_ref().is_some_and(|input| input.read(cx).focus_handle(cx).is_focused(window));

        let mut field = div()
            .id(SharedString::from(format!("field-{slot:?}")))
            // Esc puts back what the field shows and leaves it
            .capture_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key != "escape" || slot == Slot::Expr {
                    return;
                }
                let Some(input) = this.inputs.get(&slot).cloned() else { return };
                if !input.read(cx).focus_handle(cx).is_focused(window) {
                    return;
                }
                this.errors.remove(&slot);
                let text = this.text_for(slot);
                input.update(cx, |input, cx| input.set_value(text, window, cx));
                window.focus(&this.bits_focus, cx);
                this.workspace.update(cx, |workspace, _| workspace.break_merge()).ok();
                cx.stop_propagation();
                cx.notify();
            }))
            // only the selection's own field and the expression work with the selection
            .capture_any_mouse_down(cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                if event.button == MouseButton::Left && !matches!(slot, Slot::Selection | Slot::Expr) && this.selection.is_some() {
                    this.selection = None;
                    cx.notify();
                }
            }))
            .flex()
            .items_center()
            .h(r(look.height))
            .rounded(r(8.0))
            .border_1()
            .text_size(r(look.font))
            .font_family(if look.mono { mono() } else { ui() })
            .text_color(if look.float { palette.float } else { palette.text })
            .overflow_hidden()
            .debug_selector(self.label(format!("input-{slot:?}")));
        field = match look.width {
            Some(width) if look.shrink => field.w(r(width)).flex_shrink(1.0).min_w(r(look.min_width)),
            Some(width) => field.w(r(width)).flex_none(),
            None => field.flex_1().min_w(r(look.min_width)),
        };
        field = if look.title {
            field.px(r(8.0)).ml(r(-8.0)).font_weight(if look.mono { FontWeight::MEDIUM } else { FontWeight::SEMIBOLD }).border_color(theme::transparent())
        } else {
            field.px(r(10.0)).bg(palette.input).border_color(if look.select { palette.select } else { palette.border_strong })
        };
        field = if error.is_some() {
            field.border_color(palette.error).bg(palette.error_bg)
        } else if focused {
            let ring = if look.select { palette.select_soft } else { palette.accent_soft };
            field
                .bg(palette.input)
                .border_color(if look.select { palette.select } else { palette.accent })
                .shadow(vec![shadow(ring, 0.0, 0.0, 0.0, 3.0, false)])
        } else if look.title {
            field.hover(move |style| style.bg(palette.surface_2).border_color(palette.border))
        } else {
            field.hover(move |style| style.border_color(palette.muted))
        };
        if let Some(error) = error {
            field = field.tooltip(move |window, cx| Tooltip::new(format!("⚠ {error}")).build(window, cx));
        }

        match input {
            Some(input) => {
                if !focused && slot != Slot::Expr {
                    let text = self.text_for(slot);
                    if input.read(cx).value().as_ref() != text {
                        input.update(cx, |state, cx| state.set_value(text, window, cx));
                    }
                }
                field.child(Input::new(&input).appearance(false).h_full().w_full())
            }
            None => field.cursor_text().child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .items_center()
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .map(|text| {
                        if look.shrink {
                            // as large as the box allows (fit.rs)
                            text.child(
                                crate::fit::fit_text(self.text_for(slot))
                                    .family(if look.mono { mono() } else { ui() })
                                    .weight(if look.mono { FontWeight::MEDIUM } else { FontWeight::SEMIBOLD })
                                    .size(look.font)
                                    .min_size(12.0)
                                    .color(if look.float { palette.float } else { palette.text })
                                    .size_full(),
                            )
                        } else {
                            text.child(self.text_for(slot))
                        }
                    })
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                            this.activate(slot, window, cx);
                            // or the workspace takes the keyboard back on this press
                            cx.stop_propagation();
                        }),
                    ),
            ),
        }
    }

    // ------------------------------------------------------------ header
    pub(super) fn render_header(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let palette = theme::current();
        let value = self.value.clone();
        let collapsed = value.collapsed;

        let grip = div()
            .id("grip")
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .w(r(18.0))
            .h(r(30.0))
            .ml(r(-10.0))
            .rounded(r(6.0))
            .text_color(palette.faint)
            .cursor_grab()
            .group("grip")
            .debug_selector(self.label("grip"))
            .hover(move |style| style.bg(palette.surface_3))
            .tooltip(|window, cx| Tooltip::new("Drag to reorder").build(window, cx))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, _, cx| {
                    let y = event.position.y;
                    this.workspace_do(cx, move |workspace, id, cx| workspace.start_drag(id, y, cx));
                    cx.stop_propagation();
                }),
            )
            .child(icon("grip-vertical", 16.0).text_color(palette.faint).group_hover("grip", move |style| style.text_color(palette.text)));

        let collapse = Btn::new("collapse", Look::Ghost)
            .small()
            .icon(if collapsed { "chevron-right" } else { "chevron-down" })
            .tip(if collapsed { "Expand" } else { "Collapse to the header line" })
            .test_label(self.label("collapse")())
            .on_click(cx.listener(|this, _, window, cx| this.toggle_collapsed(window, cx)));

        let name_tip: SharedString = if value.description.is_empty() {
            format!("{}\n\nClick to rename", value.name).into()
        } else {
            format!("{}\n{}\n\nClick to rename", value.name, value.description).into()
        };
        let name =
            div().id("name").flex().flex_shrink(1.0).min_w_0().tooltip(move |window, cx| Tooltip::new(name_tip.clone()).build(window, cx)).child(self.field(
                Slot::Name,
                {
                    // the width the name wants at full size; with less room
                    // the box shrinks and the name fits itself (fit.rs)
                    let natural = theme::ui_text_width(&value.name, 21.0, FontWeight::SEMIBOLD, window).max(60.0) + 26.0;
                    Look2 {
                        width: Some(natural),
                        min_width: 90.0,
                        height: 36.0,
                        font: 21.0,
                        mono: false,
                        title: true,
                        select: false,
                        float: false,
                        shrink: true,
                    }
                },
                window,
                cx,
            ));

        let width_badge = div()
            .id("width")
            .cursor_pointer()
            .tooltip(|window, cx| Tooltip::new("Change width…").build(window, cx))
            .on_click(cx.listener(|this, _, window, cx| this.width_prompt(window, cx)))
            .child(badge(format!("{}-bit", value.width), value.width > 32).hover(move |style| style.border_color(palette.accent).text_color(palette.accent)));

        let address = (!value.block.is_empty()).then(|| {
            let hex = |n: u64| format!("0x{n:08X}");
            let (text, warn) = match (value.offset, self.peripheral_base) {
                (Some(offset), Some(base)) => (hex(base + offset), false),
                (Some(offset), None) => (format!("+{}", hex(offset)), false),
                (None, _) => ("no offset".to_string(), true),
            };
            let element = div()
                .px(r(4.0))
                .rounded(r(4.0))
                .font_family(mono())
                .text_size(r(13.0))
                .text_color(if warn { palette.faint } else { palette.muted })
                .child(text);
            let tip = match value.offset {
                None => format!("In {}, without an offset. Click to set one.", value.block),
                Some(offset) => format!("Offset 0x{offset:X} in {}. Click to change it.", value.block),
            };
            div()
                .id("address")
                .cursor_pointer()
                .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                .on_click(cx.listener(|this, _, window, cx| this.workspace_do_in(window, cx, |ws, id, w, cx| ws.edit_offset(id, w, cx))))
                .child(element.hover(move |style| style.text_color(palette.accent).bg(palette.surface_2)))
        });

        let mut bases = div().flex().gap(r(14.0));
        for base in Base::ORDER {
            let on = base == value.full_base;
            bases = bases.child(
                div()
                    .id(("base", base.radix() as usize))
                    .py(r(2.0))
                    .text_size(r(12.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(if on { palette.text } else { palette.muted })
                    .border_b_2()
                    .border_color(if on { palette.accent } else { theme::transparent() })
                    .cursor_pointer()
                    .hover(move |style| style.text_color(palette.text))
                    .child(base.name())
                    .debug_selector(self.label(format!("base-{}", base.name())))
                    .on_click(cx.listener(move |this, _, window, cx| this.commit(None, window, cx, move |v| Ok(v.set_full_base(base))))),
            );
        }
        let bases = div().id("full-base").tooltip(|window, cx| Tooltip::new("Number base of the whole value").build(window, cx)).child(bases);

        let shown = self.text_for(Slot::Value).chars().count().max(8) as f32;
        let value_field = self.field(
            Slot::Value,
            Look2 {
                width: Some((shown * ch(26.0) + 30.0).min(560.0)),
                min_width: 150.0,
                height: 42.0,
                font: 26.0,
                mono: true,
                title: true,
                select: false,
                float: false,
                shrink: false,
            },
            window,
            cx,
        );

        let card = cx.entity().downgrade();
        let copy = Btn::new("copy", Look::Ghost).icon("copy").tip("Copy the whole value to the clipboard").menu(Anchor::TopRight, move |mut menu, _, _| {
            for base in Base::ORDER {
                menu = menu.item(entry(&card, format!("Copy as {}", base.name()), None, move |c, w, cx| c.copy_as(base, w, cx)));
            }
            menu
        });

        let description = (!value.description.is_empty()).then(|| {
            div()
                .pl(r(50.0))
                .text_size(r(13.5))
                .text_color(palette.muted)
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(value.description.to_string())
        });
        div()
            .flex()
            .flex_wrap()
            .items_start()
            .gap(r(16.0))
            .child(
                div()
                    .flex_1()
                    .min_w(r(280.0))
                    .flex()
                    .flex_col()
                    .gap(r(2.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(r(8.0))
                            .min_w_0()
                            .child(div().flex_none().child(grip))
                            .child(div().flex_none().ml(r(-4.0)).child(collapse))
                            .child(name)
                            .children(address.map(|address| address.flex_none()))
                            .child(width_badge.flex_none()),
                    )
                    .children(description),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_end()
                    .gap(r(2.0))
                    .child(div().flex().items_center().gap(r(2.0)).child(value_field).child(copy).child(self.menu_button(cx)))
                    .when(!collapsed, |right| right.child(div().mr(r(64.0)).child(bases))),
            )
    }

    // ------------------------------------------------------------ tools line
    pub(super) fn render_toolbar(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let palette = theme::current();
        let value = self.value.clone();
        let line = value.view == View::Line;

        let mut views = div().flex().items_center().gap(r(16.0)).mr(r(10.0));
        for (label, view, tip) in [
            ("Table", View::Line, "The register as datasheet tables, 16 bits each"),
            ("Bytes", View::Byte, "One row per byte, each with its own value"),
            ("Nibbles", View::Nibble, "One row per nibble, each with its own value"),
        ] {
            let on = value.view == view;
            views = views.child(
                div()
                    .id(("view", view as usize))
                    .py(r(3.0))
                    .text_size(r(13.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(if on { palette.text } else { palette.muted })
                    .border_b_2()
                    .border_color(if on { palette.accent } else { theme::transparent() })
                    .cursor_pointer()
                    .hover(move |style| style.text_color(palette.text))
                    .child(label)
                    .debug_selector(self.label(format!("view-{label}")))
                    .tooltip(move |window, cx| Tooltip::new(tip).build(window, cx))
                    .on_click(cx.listener(move |this, _, window, cx| this.commit(None, window, cx, move |v| Ok(v.set_view(view))))),
            );
        }

        let center = if line {
            let has = value.has_compare(0);
            Btn::new("compare-line", if has { Look::On } else { Look::Ghost })
                .icon("git-compare-arrows")
                .label("Compare")
                .tip("Show a linked compare row under the bits")
                .test_label(self.label("compare-0")())
                .on_click(cx.listener(move |this, _, window, cx| this.toggle_compare(0, window, cx)))
        } else {
            let msb_first = value.msb_first;
            Btn::new("order", Look::Ghost)
                .icon("arrow-up-down")
                .label(if msb_first { "MSB row first" } else { "LSB row first" })
                .tip("Toggle row order. LSB first in byte view is the little-endian memory order.")
                .on_click(cx.listener(move |this, _, window, cx| this.commit(None, window, cx, move |v| Ok(v.set_msb_first(!msb_first)))))
        };

        let bases = Btn::new("bases", if value.show_bases { Look::On } else { Look::Ghost })
            .icon("binary")
            .label("Bases")
            .tip("Show the value in every base (BIN · OCT · DEC · HEX)")
            .test_label(self.label("bases")())
            .on_click(cx.listener(|this, _, window, cx| this.toggle_bases(window, cx)));

        let mut ops = seg_track();
        for (label, icon_name, op, tip) in OPS_SHOWN {
            ops = ops.child(
                seg_icon_button(("op", op as usize), icon_name, if icon_name.is_some() { "" } else { label }, false, SegSize::Normal)
                    .text_color(palette.text)
                    .active(move |style| style.bg(palette.accent_soft).text_color(palette.accent))
                    .debug_selector(self.label(format!("op-{label}")))
                    .tooltip(move |window, cx| Tooltip::new(format!("{tip}{SEL_NOTE}")).build(window, cx))
                    // the selection stays: the operation applies to it
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _, window, cx| this.apply_op(op, window, cx))),
            );
        }
        let card = cx.entity().downgrade();
        let width = value.width;
        let more_ops = Btn::new("more-ops", Look::Ghost)
            .small()
            .icon("chevron-down")
            .tip(format!("More operations: rotate, swap bytes, reverse, negate, AND/OR/XOR…{SEL_NOTE}"))
            .menu(Anchor::TopLeft, move |menu, _, _| more_ops_menu(menu, &card, width, None, |c, op, w, cx| c.apply_op(op, w, cx)));

        let expr = Btn::new("expr", if self.expr_open { Look::On } else { Look::Ghost })
            .icon("square-function")
            .tip("Expression bar: type a calculation to set the value (or the selected bits)")
            .test_label(self.label("expr")())
            .on_click(cx.listener(|this, _, window, cx| this.toggle_expr(window, cx)));

        let selection = self.selection;
        let mut selection_bar = div().flex().items_center().gap(r(8.0)).min_w_0();
        match selection {
            None => {
                selection_bar = selection_bar
                    .child(div().font_family(mono()).text_size(r(12.0)).text_color(palette.faint).whitespace_nowrap().child("drag across bits to select"))
            }
            Some((lo, hi)) => {
                let count = hi - lo + 1;
                let range = if count > 1 { format!("[{hi}:{lo}]") } else { format!("[{lo}]") };
                let mut seg = seg_track().rounded(r(8.0));
                for base in [Base::Hex, Base::Dec, Base::Bin] {
                    seg = seg.child(seg_button(("sel-base", base.radix() as usize), base.name(), base == self.selection_base, SegSize::Tiny).on_click(
                        cx.listener(move |this, _, _, cx| {
                            this.selection_base = base;
                            cx.notify();
                        }),
                    ));
                }
                let chars = if self.selection_base == Base::Bin { count } else { count.div_ceil(3) }.clamp(3, 24);
                let field = self.field(
                    Slot::Selection,
                    Look2 { width: Some(chars as f32 * ch(13.0) + 24.0), height: 26.0, select: true, ..Look2::mono(None) },
                    window,
                    cx,
                );
                selection_bar = selection_bar
                    .child(
                        div()
                            .font_family(mono())
                            .text_size(r(12.0))
                            .text_color(palette.select)
                            .whitespace_nowrap()
                            .child(format!("{range} · {}", plural(count, "bit"))),
                    )
                    .child(seg)
                    .child(field);
            }
        }

        let group = Btn::new("group", Look::AccentGhost)
            .icon("group")
            .label("Group selection")
            .tip("Make the selected bits a named register field (Ctrl+G)")
            .disabled(selection.is_none())
            .test_label(self.label("make-field")())
            .on_click(cx.listener(|this, _, window, cx| this.group_selection(window, cx)));

        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(r(6.0))
            .child(views)
            .child(center)
            .child(bases)
            .child(div().flex().items_center().gap(r(2.0)).child(ops).child(div().on_mouse_down(MouseButton::Left, self.keeps_selection(cx)).child(more_ops)))
            .child(div().on_mouse_down(MouseButton::Left, self.keeps_selection(cx)).child(crate::tour::anchor("expr", expr)))
            .child(div().flex_1())
            .child(div().on_mouse_down(MouseButton::Left, self.keeps_selection(cx)).child(crate::tour::anchor("selection", selection_bar)))
            .child(div().on_mouse_down(MouseButton::Left, self.keeps_selection(cx)).child(group))
            .when(selection.is_some(), |bar| {
                bar.child(
                    Btn::new("clear-selection", Look::Ghost)
                        .icon("x")
                        .tip("Clear selection (Esc)")
                        .on_click(cx.listener(|this, _, _, cx| this.clear_selection(cx))),
                )
            })
    }

    // ------------------------------------------------------------ expression bar
    pub(super) fn render_expr_bar(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let palette = theme::current();
        let target = match self.selection {
            Some((lo, hi)) if lo == hi => format!("→ bit [{lo}]"),
            Some((lo, hi)) => format!("→ bits [{hi}:{lo}]"),
            None => "→ value".to_string(),
        };
        let preview = crate::expr_field::preview(self.expr_result.as_ref(), self.target().1);
        let field = self.field(Slot::Expr, Look2 { height: 32.0, ..Look2::mono(None) }, window, cx);
        let ok = matches!(self.expr_result, Some(Ok(_)));
        div()
            .on_mouse_down(MouseButton::Left, self.keeps_selection(cx))
            .flex()
            .items_start()
            .gap(r(10.0))
            .px(r(12.0))
            .py(r(10.0))
            .bg(palette.surface_2)
            .border_1()
            .border_color(palette.border)
            .rounded(r(12.0))
            .child(div().flex().items_center().h(r(32.0)).text_color(palette.accent).child(icon("square-function", 16.0)))
            .child(div().flex().flex_col().gap(r(6.0)).flex_1().min_w_0().child(div().flex().w_full().child(field)).child(preview))
            .child(div().text_size(r(12.0)).text_color(palette.muted).whitespace_nowrap().line_height(r(32.0)).child(target))
            .child(
                div().mt(r(3.0)).child(
                    Btn::new("expr-apply", Look::Primary)
                        .small()
                        .icon("check")
                        .label("Apply")
                        .tip("Apply (Enter)")
                        .disabled(!ok)
                        .test_label(self.label("expr-apply")())
                        .on_click(cx.listener(|this, _, window, cx| this.apply_expression(window, cx))),
                ),
            )
            .child(
                div().mt(r(3.0)).child(
                    Btn::new("expr-close", Look::Ghost)
                        .small()
                        .icon("x")
                        .tip("Close (Esc)")
                        .on_click(cx.listener(|this, _, window, cx| this.toggle_expr(window, cx))),
                ),
            )
    }

    // ------------------------------------------------------------ bits
    /// One bit's cell in a datasheet table: `width` px wide, with a rule on
    /// its left (`edge`) unless it starts the line.
    #[allow(clippy::too_many_arguments)]
    fn bit(&self, bit: usize, lo: usize, compare: bool, width: f32, edge: Option<Rgba>, cell_height: f32, font: f32, cx: &mut Context<Self>) -> Stateful<Div> {
        let palette = theme::current();
        let value = &self.value;
        let on = if compare { value.compare_bit(lo, bit).unwrap_or(false) } else { value.bit(bit) };
        let field = value.field_at(bit).map(|index| &value.fields[index]);
        let reserved = field.is_none() && !value.fields.is_empty();
        let selected = !compare && self.selection.is_some_and(|(lo, hi)| (lo..=hi).contains(&bit));
        let differs = compare && on != value.bit(bit);

        let mut cell =
            div().relative().size_full().flex().items_center().justify_center().rounded(r(6.0)).overflow_hidden().font_family(mono()).text_size(r(font));
        if compare {
            cell = cell.bg(if on { palette.cmp_on } else { palette.cmp_off }).text_color(if on { palette.cmp_on_text } else { palette.cmp_off_text });
            if differs {
                cell = cell
                    .text_color(palette.text)
                    .font_weight(FontWeight::BOLD)
                    .shadow(vec![shadow(palette.diff, 0.0, 0.0, 0.0, 2.0, true)])
                    .child(div().absolute().top(r(3.0)).right(r(3.0)).size(r(5.0)).rounded_full().bg(palette.diff));
            }
        } else if on {
            cell = cell
                .bg(palette.bit_on)
                .text_color(palette.bit_on_text)
                .font_weight(FontWeight::SEMIBOLD)
                .group_hover("bit", move |style| style.bg(palette.accent_soft));
        } else {
            cell = cell
                .bg(palette.surface_2)
                .text_color(if reserved { palette.faint } else { palette.bit_off_text })
                .group_hover("bit", move |style| style.bg(palette.surface_3));
        }
        if !compare && (reserved || field.is_some_and(|field| field.protected())) {
            cell = cell.child(hatching(on, palette.name == theme::ThemeName::Light));
        }
        if !compare && reserved && self.gap_locked(bit) {
            cell = cell.line_through();
        }
        if palette.name == theme::ThemeName::Contrast && on && !compare {
            cell = cell.shadow(vec![shadow(rgb(0xffffff), 0.0, 0.0, 0.0, 1.0, true)]);
        }
        cell = cell.child(if on { "1" } else { "0" });
        if !compare && self.cursor == Some(bit) {
            let focused = self.bits_focused;
            let ring = div().absolute().top_0().left_0().right_0().bottom_0().rounded(r(6.0)).border_2().border_color(if focused {
                palette.text
            } else {
                palette.faint
            });
            cell = cell.child(if focused { ring } else { ring.border_dashed() });
        }
        if selected {
            cell = cell.child(div().absolute().top_0().left_0().right_0().bottom_0().rounded(r(6.0)).bg(palette.select_soft).shadow(vec![shadow(
                palette.select,
                0.0,
                0.0,
                0.0,
                2.0,
                true,
            )]));
        }

        let mut column = div()
            .w(r(width))
            .h(r(cell_height))
            .p(r(2.0))
            .flex_none()
            .cursor_pointer()
            .id(("bit", bit * 2 + compare as usize))
            .group("bit")
            .debug_selector(self.label(if compare { format!("cbit-{bit}") } else { format!("bit-{bit}") }));
        if let Some(color) = edge {
            column = column.border_l_1().border_color(color);
        }
        column = column.child(cell);

        // made only when the pointer rests on the bit
        let shown = self.value.clone();
        column = column.tooltip(move |window, cx| Tooltip::new(bit_tip(&shown, bit, lo, compare)).build(window, cx));

        if compare {
            column.on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, _: &MouseDownEvent, window, cx| this.commit(None, window, cx, move |v| v.flip_compare_bit(lo, bit))),
            )
        } else {
            column
                .on_mouse_down(MouseButton::Right, cx.listener(move |this, _: &MouseDownEvent, _, _| this.menu_bit = Some(bit)))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                        if event.modifiers.alt {
                            this.paint_start(bit, !event.modifiers.shift, window, cx);
                        } else {
                            this.press_bit(bit, event.modifiers.shift, cx);
                        }
                        window.focus(&this.bits_focus, cx);
                        cx.stop_propagation();
                    }),
                )
                .on_mouse_move(cx.listener(move |this, event: &MouseMoveEvent, window, cx| {
                    if event.pressed_button != Some(MouseButton::Left) {
                        return;
                    }
                    if this.paint.is_some() {
                        this.paint_bit(bit, window, cx);
                    } else {
                        this.drag_over(bit, cx);
                    }
                }))
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(move |this, _: &MouseUpEvent, window, cx| {
                        if this.paint.is_some() {
                            this.paint_end(cx);
                        } else {
                            this.release_bit(bit, window, cx);
                        }
                    }),
                )
        }
    }

    /// The bits of the row starting at `lo` (or of its compare row), drawn
    /// as datasheet tables: bit numbers, field names over their bits, the
    /// values, and the access of fields that aren't read-write. Each table
    /// covers `slots` positions aligned to a multiple of it; positions above
    /// the top bit are blank, so columns line up.
    fn strip(&self, lo: usize, compare: bool, line_view: bool, available: f32, cx: &mut Context<Self>) -> Div {
        let palette = theme::current();
        let value = &self.value;
        let count = value.row_width_at(lo);
        let top = lo + count - 1;
        let msb_left = app_state::settings(cx).msb_left;
        let slots = if line_view { line_length(count, available) } else { value.row_width() };
        // whole pixels, so every row of the table lines up
        let cell_width = (available / slots as f32).floor().max(MIN_CELL);
        let cell_height = if line_view { theme::space(42.0, 34.0) } else { theme::space(36.0, 30.0) };
        let font = (cell_width * 0.5).clamp(10.0, 15.0);
        let has_fields = !value.fields.is_empty();
        let reserved_width = crate::fit::text_width("Reserved", ui(), FontWeight::NORMAL, 12.0, cx);
        let show_access = has_fields && !compare && value.fields.iter().any(|field| field.details.access != Access::ReadWrite);

        // pills need no rules between bits
        let edge = |_previous: Option<usize>, _bit: usize| -> Option<Rgba> { None };
        let small = |text: String| div().flex().items_center().justify_center().overflow_hidden().whitespace_nowrap().text_ellipsis().child(text);

        let mut keys: Vec<usize> = (0..count.div_ceil(slots)).collect();
        if msb_left {
            keys.reverse();
        }
        let mut strip = div().flex().flex_col().gap(r(if line_view { 14.0 } else { 6.0 })).min_w(r(slots as f32 * cell_width));
        for key in keys {
            let start = lo + key * slots;
            let mut positions: Vec<usize> = (start..start + slots).collect();
            if msb_left {
                positions.reverse();
            }
            let mut table = div().flex().flex_col().gap(r(2.0)).w(r(slots as f32 * cell_width));

            if !compare {
                let mut numbers = div().flex();
                let mut previous = None;
                for &bit in &positions {
                    let mut number = small(if bit <= top { bit.to_string() } else { String::new() })
                        .w(r(cell_width))
                        .flex_none()
                        .py(r(3.0))
                        .font_family(mono())
                        .text_size(r(11.0))
                        .text_color(palette.muted);
                    if let Some(color) = edge(previous, bit) {
                        number = number.border_l_1().border_color(color);
                    }
                    previous = Some(bit);
                    numbers = numbers.child(number);
                }
                table = table.child(numbers);
            }

            // runs of positions in the same field (or the same gap between fields)
            let mut runs: Vec<(Option<usize>, Vec<usize>)> = Vec::new();
            for &bit in &positions {
                let field = if bit <= top { value.field_at(bit) } else { None };
                let blank = bit > top;
                match runs.last_mut() {
                    Some((current, bits)) if *current == field && (bits[0] > top) == blank => bits.push(bit),
                    _ => runs.push((field, vec![bit])),
                }
            }
            let segment = |run: &(Option<usize>, Vec<usize>), previous: Option<usize>| {
                let mut segment = div().w(r(cell_width * run.1.len() as f32)).flex_none().relative();
                if let Some(color) = edge(previous, run.1[0]) {
                    segment = segment.border_l_1().border_color(color);
                }
                segment
            };

            if has_fields && !compare {
                let mut names = div().flex();
                for run in &runs {
                    let blank_run = run.1[0] > top;
                    let cell = div()
                        .w(r(cell_width * run.1.len() as f32 - 4.0))
                        .mx(r(2.0))
                        .flex_none()
                        .relative()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(r(6.0))
                        .overflow_hidden()
                        .when(!blank_run, |cell| cell.bg(palette.surface_2))
                        .py(r(6.0))
                        .px(r(4.0))
                        .text_size(r(12.0));
                    let blank = run.1[0] > top;
                    let cell: AnyElement = match run.0 {
                        Some(index) => {
                            let field = &value.fields[index];
                            let tip: SharedString = if field.details.description.is_empty() {
                                format!("{} {}", field.name, field.label()).into()
                            } else {
                                format!("{} {}\n{}", field.name, field.label(), field.details.description).into()
                            };
                            cell.font_weight(FontWeight::MEDIUM)
                                .text_color(palette.text)
                                .child(div().absolute().top_0().left_0().right_0().h(r(2.0)).bg(theme::field_color(&field.color, 1.0)))
                                .child(
                                    crate::fit::fit_text(field.name.to_string())
                                        .weight(FontWeight::MEDIUM)
                                        .size(12.0)
                                        .min_size(8.5)
                                        .align(crate::fit::Align::Center)
                                        .color(palette.text)
                                        .flex_1()
                                        .min_w_0()
                                        .h(r(16.0)),
                                )
                                .id(("field-name", index * 1024 + run.1[0]))
                                .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                                .into_any_element()
                        }
                        None if blank => cell.into_any_element(),
                        None => cell
                            .text_color(palette.faint)
                            .gap(r(3.0))
                            .when(run.1.len() > 1, |cell| cell.child(icon("lock", 10.0).text_color(palette.faint)))
                            .child(
                                // as wide as the word, so the lock stays beside it
                                crate::fit::fit_text("Reserved")
                                    .size(12.0)
                                    .min_size(8.5)
                                    .align(crate::fit::Align::Center)
                                    .color(palette.faint)
                                    .w(r(reserved_width + 1.0))
                                    .flex_shrink(1.0)
                                    .min_w_0()
                                    .h(r(16.0)),
                            )
                            .into_any_element(),
                    };
                    names = names.child(cell);
                }
                table = table.child(names);
            }

            let mut bits = div().flex();
            let mut previous = None;
            for &bit in &positions {
                let line = edge(previous, bit);
                previous = Some(bit);
                bits = bits.child(if bit > top {
                    let mut blank = div().w(r(cell_width)).h(r(cell_height)).flex_none();
                    if let Some(color) = line {
                        blank = blank.border_l_1().border_color(color);
                    }
                    blank.into_any_element()
                } else {
                    self.bit(bit, lo, compare, cell_width, line, cell_height, font, cx).into_any_element()
                });
            }
            table = table.child(bits);

            if show_access {
                let mut access = div().flex();
                let mut previous = None;
                for run in &runs {
                    let text = match run.0 {
                        Some(index) => match value.fields[index].details.access {
                            Access::ReadWrite => "rw",
                            Access::ReadOnly => "r",
                            Access::Reserved => "res",
                        },
                        None => "",
                    };
                    access = access
                        .child(segment(run, previous).py(r(2.0)).font_family(mono()).text_size(r(10.5)).text_color(palette.muted).child(small(text.into())));
                    previous = run.1.last().copied();
                }
                table = table.child(access);
            }
            strip = strip.child(table);
        }
        strip
    }

    // ------------------------------------------------------------ rows
    /// Right-clicking the bits of a row opens its menu (with entries for the
    /// field under the pointer).
    fn with_row_menu(&self, element: Div, lo: usize, compare: bool, cx: &mut Context<Self>) -> AnyElement {
        let card = cx.entity().downgrade();
        element
            .context_menu(move |menu, window, cx| {
                let bit = card.update(cx, |card, _| card.menu_bit.take()).ok().flatten();
                row_menu_items(menu, window, cx, &card, lo, compare, bit)
            })
            .into_any_element()
    }

    /// The row's ⋯ menu: grouping, row operations, copying, compare.
    fn row_menu(&self, lo: usize, compare: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let card = cx.entity().downgrade();
        Btn::new(("row-menu", lo * 2 + compare as usize), Look::Ghost)
            .small()
            .icon("ellipsis")
            .tip(if compare { "Compare row operations" } else { "Row operations" })
            .menu(Anchor::TopRight, move |menu, window, cx| row_menu_items(menu, window, cx, &card, lo, compare, None))
    }

    /// A row's ⋯ and its Compare button as in the web app; `label` for tests.
    fn grid_row(&mut self, lo: usize, available: f32, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let palette = theme::current();
        let value = self.value.clone();
        let width = value.row_width_at(lo);
        let hi = lo + width - 1;
        let linked = value.has_compare(lo);
        let show_readouts = app_state::settings(cx).show_readouts;

        let label = div()
            .id(("row-label", lo))
            .w(r(LABEL_W))
            .flex_none()
            .flex()
            .flex_col()
            .gap(r(1.0))
            .py(r(2.0))
            .cursor_pointer()
            .group("row-label")
            .tooltip(|window, cx| Tooltip::new("Click to select this row · Shift+click to extend over consecutive rows").build(window, cx))
            .on_mouse_down(MouseButton::Left, self.keeps_selection(cx))
            .on_click(cx.listener(move |this, event: &ClickEvent, _, cx| this.select_row(lo, event.modifiers().shift, cx)))
            .child(
                div()
                    .text_size(r(13.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .group_hover("row-label", move |style| style.text_color(palette.accent))
                    .child(value.row_title(lo)),
            )
            .child(div().text_size(r(11.0)).font_family(mono()).text_color(palette.muted).child(format!("[{hi}:{lo}]")));

        // the row's base: a quiet label that steps BIN → OCT → DEC → HEX
        let row_base = value.row_base(lo);
        let next_base = Base::ORDER[(Base::ORDER.iter().position(|base| *base == row_base).unwrap_or(0) + 1) % Base::ORDER.len()];
        let seg = div()
            .id(("row-base", lo))
            .w_full()
            .py(r(3.0))
            .rounded(r(5.0))
            .flex()
            .justify_center()
            .font_family(mono())
            .font_weight(FontWeight::SEMIBOLD)
            .text_size(r(11.5))
            .text_color(palette.muted)
            .cursor_pointer()
            .hover(move |style| style.bg(palette.surface_2).text_color(palette.accent))
            .tooltip(move |window, cx| Tooltip::new(format!("This row in {}; click for {}", row_base.name(), next_base.name())).build(window, cx))
            .on_click(cx.listener(move |this, _, window, cx| this.commit(None, window, cx, move |v| v.set_row_base(lo, next_base))))
            .child(row_base.name());
        let edit_width = value.row_width() as f32 * ch(13.0) + 24.0;
        let edit = self.field(Slot::Row(lo), Look2::mono(Some(edit_width)), window, cx);
        let readout = div()
            .w(r(if show_readouts { READOUT_W } else { 0.0 }))
            .flex_none()
            .font_family(mono())
            .text_size(r(12.0))
            .text_color(palette.muted)
            .whitespace_nowrap()
            .overflow_hidden()
            .when(show_readouts, |readout| readout.child(readout_text(value.row_value(lo), width)));
        let compare = Btn::new(("row-compare", lo), if linked { Look::On } else { Look::Ghost })
            .small()
            .icon("git-compare-arrows")
            .tip(if linked { "Hide the compare row" } else { "Compare: a linked row under this one, to see what differs" })
            .test_label(self.label(format!("compare-{lo}"))())
            .on_click(cx.listener(move |this, _, window, cx| this.toggle_compare(lo, window, cx)));

        let strip = self.strip(lo, false, false, available, cx);
        let row = div()
            .flex()
            .items_center()
            .gap(r(COLUMN_GAP))
            .py(r(theme::space(5.0, 3.0)))
            .when(linked, |row| row.bg(palette.row_linked))
            .child(label)
            .child(div().flex_1().min_w_0().child(self.with_row_menu(crate::tour::anchor("bits", strip), lo, false, cx)))
            .child(div().w(r(ROW_SEG_W)).flex_none().flex().child(seg))
            .child(edit)
            .child(readout)
            .child(div().w(r(ROW_BUTTON_W)).flex_none().flex().child(compare))
            .child(div().w(r(MENU_W)).flex_none().child(self.row_menu(lo, false, cx)));
        left_border(row, if linked { palette.link } else { theme::transparent() })
    }

    /// The compare row under the row starting at `lo` (byte and nibble views).
    fn grid_compare_row(&mut self, lo: usize, available: f32, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let palette = theme::current();
        let value = self.value.clone();
        let edit_width = value.row_width() as f32 * ch(13.0) + 24.0;
        let edit = self.field(Slot::Compare(lo), Look2::mono(Some(edit_width)), window, cx);
        let strip = self.with_row_menu(self.strip(lo, true, false, available, cx), lo, true, cx);
        let row = div()
            .flex()
            .items_center()
            .gap(r(COLUMN_GAP))
            .py(r(theme::space(4.0, 2.0)))
            .px(r(8.0))
            .bg(palette.cmp_bg)
            .child(div().w(r(LABEL_W)).flex_none().child(compare_label()))
            .child(div().flex_1().min_w_0().child(strip))
            .child(
                div()
                    .w(r(ROW_SEG_W))
                    .flex_none()
                    .flex()
                    .justify_center()
                    .font_family(mono())
                    .text_size(r(12.0))
                    .text_color(palette.muted)
                    .child(value.row_base(lo).name()),
            )
            .child(edit)
            .child(div().w(r(READOUT_W)).flex_none().overflow_hidden().child(self.compare_readout(lo, false)))
            .child(div().w(r(ROW_BUTTON_W)).flex_none().flex().child(self.remove_compare_button(lo, cx)))
            .child(div().w(r(MENU_W)).flex_none().child(self.row_menu(lo, true, cx)));
        left_border(row, palette.link)
    }

    fn remove_compare_button(&self, lo: usize, cx: &mut Context<Self>) -> Btn {
        Btn::new(("remove-compare", lo), Look::Danger)
            .small()
            .icon("x")
            .tip("Remove this compare row")
            .on_click(cx.listener(move |this, _, window, cx| this.commit(None, window, cx, move |v| Ok(v.remove_compare(lo)))))
    }

    /// "Δ 2 bits · XOR 0x0C" or "identical".
    fn compare_readout(&self, lo: usize, grouped: bool) -> Div {
        let palette = theme::current();
        let value = &self.value;
        let readout = div().font_family(mono()).text_size(r(12.0)).text_color(palette.muted).whitespace_nowrap().flex();
        match value.compare_diff(lo) {
            Ok(diff) if diff != Bits::ZERO => {
                let count = popcount(diff);
                readout
                    .child(div().text_color(palette.diff).font_weight(FontWeight::SEMIBOLD).child(format!("Δ {}", plural(count, "bit"))))
                    .child(format!(" · XOR {}", format_int(diff, Base::Hex, value.row_width_at(lo), true, grouped)))
            }
            _ => readout.child(div().text_color(palette.ok).child("identical")),
        }
    }

    pub(super) fn render_rows(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let focus = self.bits_focus.clone();
        self.bits_focused = focus.is_focused(window);
        self.rows(window, cx).track_focus(&focus).on_key_down(cx.listener(Self::bit_key))
    }

    fn rows(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let palette = theme::current();
        let value = self.value.clone();
        let content = self.content_width(window, cx);
        if value.view == View::Line {
            self.line_bits = line_length(value.row_width_at(0), content - 17.0);
            let mut rows = div().flex().flex_col().gap(r(6.0));
            for lo in value.row_los() {
                let linked = value.has_compare(lo);
                let strip = self.strip(lo, false, true, content - 17.0, cx);
                let row = div().pt(r(2.0)).pr(r(6.0)).pb(r(6.0)).pl(r(8.0)).when(linked, |row| row.bg(palette.row_linked)).child(self.with_row_menu(
                    crate::tour::anchor("bits", strip),
                    lo,
                    false,
                    cx,
                ));
                rows = rows.child(left_border(row, if linked { palette.link } else { theme::transparent() }));
                if linked {
                    let edit = self.field(Slot::Compare(lo), Look2 { min_width: 200.0, ..Look2::mono(None) }, window, cx);
                    let strip = self.with_row_menu(self.strip(lo, true, true, content - 17.0, cx), lo, true, cx);
                    let bar = div()
                        .flex()
                        .items_center()
                        .gap(r(10.0))
                        .min_w_0()
                        .child(compare_label())
                        .child(div().font_family(mono()).text_size(r(12.0)).text_color(palette.muted).child(value.full_base.name()))
                        .child(div().flex().max_w(r(380.0)).flex_1().min_w(r(200.0)).child(edit))
                        .child(self.compare_readout(lo, true))
                        .child(div().flex_1())
                        .child(self.remove_compare_button(lo, cx))
                        .child(self.row_menu(lo, true, cx));
                    let row = div().flex().flex_col().gap(r(10.0)).pt(r(10.0)).pr(r(6.0)).pb(r(10.0)).pl(r(8.0)).bg(palette.cmp_bg).child(bar).child(strip);
                    rows = rows.child(left_border(row, palette.link));
                }
            }
            return rows;
        }

        let show_readouts = app_state::settings(cx).show_readouts;
        let edit_width = value.row_width() as f32 * ch(13.0) + 24.0;
        let others = LABEL_W + ROW_SEG_W + edit_width + if show_readouts { READOUT_W } else { 0.0 } + ROW_BUTTON_W + MENU_W + 6.0 * COLUMN_GAP + 16.0 + 3.0;
        let available = content - others;
        let mut rows = div().flex().flex_col().gap(r(2.0));
        for lo in value.row_los() {
            rows = rows.child(self.grid_row(lo, available, window, cx));
            if value.has_compare(lo) {
                rows = rows.child(self.grid_compare_row(lo, available, window, cx));
            }
        }
        rows
    }

    // ------------------------------------------------------------ panels
    /// A panel's heading line (.fields-head).
    fn panel_head(icon_name: &'static str, title: &'static str) -> Div {
        let palette = theme::current();
        div()
            .flex()
            .items_center()
            .gap(r(8.0))
            .child(icon(icon_name, 15.0).text_color(palette.muted))
            .child(div().font_weight(FontWeight::SEMIBOLD).child(title))
    }

    fn panel() -> Div {
        let palette = theme::current();
        div()
            .flex()
            .flex_col()
            .bg(palette.surface_2)
            .border_1()
            .border_color(palette.border)
            .rounded(r(12.0))
            .pt(r(theme::space(10.0, 8.0)))
            .px(r(theme::space(14.0, 12.0)))
            .pb(r(theme::space(12.0, 10.0)))
    }

    pub(super) fn render_bases(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let palette = theme::current();
        let head = Self::panel_head("binary", "All bases")
            .child(div().ml(r(4.0)).text_size(r(12.0)).text_color(palette.muted).child("Type into any line to change the value"))
            .child(div().flex_1())
            .child(
                Btn::new("hide-bases", Look::Ghost)
                    .small()
                    .icon("x")
                    .tip("Hide all bases")
                    .on_click(cx.listener(|this, _, window, cx| this.toggle_bases(window, cx))),
            );
        let mut list = div().flex().flex_col().gap(r(6.0)).mt(r(10.0));
        for base in [Base::Hex, Base::Dec, Base::Oct, Base::Bin] {
            list = list.child(
                div()
                    .flex()
                    .items_center()
                    .gap(r(10.0))
                    .min_w_0()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .w(r(46.0))
                            .flex_none()
                            .font_family(mono())
                            .font_weight(FontWeight::BOLD)
                            .text_size(r(12.0))
                            .line_height(r(13.2))
                            .text_color(palette.accent)
                            .child(base.name())
                            .child(
                                div()
                                    .font_family(ui())
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_size(r(10.0))
                                    .text_color(palette.faint)
                                    .child(format!("base {}", base.radix())),
                            ),
                    )
                    .child(self.field(Slot::InBase(base), Look2::mono(None), window, cx))
                    .child(
                        Btn::new(("copy-base", base.radix() as usize), Look::Ghost)
                            .small()
                            .icon("copy")
                            .tip(format!("Copy as {}", base.name()))
                            .on_click(cx.listener(move |this, _, window, cx| this.copy_as(base, window, cx))),
                    ),
            );
        }
        Self::panel().child(head).child(list)
    }

    /// The register's fields as a datasheet lists them: name, bits and value
    /// on one line, the description under it, then the named values to pick
    /// from. Editing tools show on hover.
    pub(super) fn render_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let palette = theme::current();
        let value = self.value.clone();
        let count = value.fields.len();
        let mut head = div().flex().items_center().gap(r(8.0)).child(div().text_size(r(14.0)).font_weight(FontWeight::SEMIBOLD).child("Fields"));
        if count > 0 {
            head = head.child(div().text_size(r(13.0)).text_color(palette.muted).child(count.to_string()));
        } else {
            head = head.child(
                div()
                    .ml(r(4.0))
                    .text_size(r(12.5))
                    .text_color(palette.muted)
                    .child("None yet. Drag across bits (or click a row label, then Shift+click another) and press “Group selection”."),
            );
        }
        head = head.child(div().flex_1()).child(
            Btn::new("templates", Look::Ghost)
                .small()
                .icon("layout-template")
                .label("Templates")
                .tip("Apply a field layout (IEEE-754, RGB565, IPv4, your own…)")
                .on_click(cx.listener(|this, _, window, cx| this.apply_template_prompt(window, cx))),
        );
        let mut panel = div().flex().flex_col().gap(r(4.0)).child(head);
        if count == 0 {
            return panel;
        }

        // as many 300 px columns as fit, 36 px apart
        let content = self.content_width(window, cx);
        let columns = (((content + 36.0) / 336.0).floor() as usize).clamp(1, 3);
        let column_width = ((content - 36.0 * (columns - 1) as f32) / columns as f32).floor();

        let mut list = div().flex().flex_wrap().gap_x(r(36.0));
        for (index, field) in value.fields.iter().enumerate() {
            let raw = value.field_value(index);
            let color = theme::field_color(&field.color, 1.0);
            let swatch_card = cx.entity().downgrade();
            let swatch = crate::widgets::with_menu(
                div()
                    .id(("swatch", index))
                    .size(r(10.0))
                    .flex_none()
                    .rounded(r(3.0))
                    .bg(color)
                    .cursor_pointer()
                    .hover(move |style| style.shadow(vec![shadow(color, 0.0, 0.0, 0.0, 2.0, false)]))
                    .tooltip(|window, cx| Tooltip::new("Change colour").build(window, cx)),
                Anchor::TopLeft,
                move |menu, _, _| colour_menu(menu, &swatch_card, index),
            );
            let name_chars = field.name.chars().count().max(4) as f32;
            let name = self.field(
                Slot::FieldName(index),
                Look2 { title: true, height: 26.0, font: 13.0, ..Look2::mono(Some(name_chars * ch(13.0) + 20.0)) },
                window,
                cx,
            );
            let bits = div()
                .flex()
                .items_center()
                .gap(r(4.0))
                .font_family(mono())
                .text_size(r(12.0))
                .text_color(palette.muted)
                .whitespace_nowrap()
                .when(field.protected(), |bits| bits.child(icon("lock", 11.0).text_color(palette.select)))
                .child(field.label());
            let chars = match field.base {
                Base::Bin => field.width(),
                Base::Hex => field.width().div_ceil(4) + 2,
                _ => field.width().div_ceil(3) + 1,
            }
            .clamp(3, 34) as f32;
            let edit =
                self.field(Slot::Field(index), Look2 { title: true, height: 26.0, font: 13.0, ..Look2::mono(Some(chars * ch(13.0) + 20.0)) }, window, cx);
            let shown_base = field.base;
            let next_base = Base::ORDER[(Base::ORDER.iter().position(|base| *base == field.base).unwrap_or(0) + 1) % Base::ORDER.len()];
            let base_label = div()
                .id(("field-base", index))
                .px(r(4.0))
                .rounded(r(4.0))
                .font_family(mono())
                .text_size(r(10.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(palette.faint)
                .cursor_pointer()
                .hover(move |style| style.text_color(palette.accent).bg(palette.surface_2))
                .tooltip(move |window, cx| Tooltip::new(format!("Shown in {}; click for {}", shown_base.name(), next_base.name())).build(window, cx))
                .on_click(cx.listener(move |this, _, window, cx| this.commit(None, window, cx, move |v| v.update_field(index, None, None, Some(next_base)))))
                .child(field.base.name());

            let (lo, hi) = (field.lo, field.hi);
            let group: SharedString = format!("field-{index}").into();
            let tools = div()
                .flex()
                .items_center()
                .opacity(0.0)
                .group_hover(group.clone(), |style| style.opacity(1.0))
                .child(
                    Btn::new(("field-details", index), Look::Ghost)
                        .tiny()
                        .icon("sliders-vertical")
                        .tip("Field details: description, signed, formula & unit, named values, access")
                        .test_label(self.label(format!("field-edit-{index}"))())
                        .on_click(cx.listener(move |this, _, window, cx| this.open_field_editor(index, window, cx))),
                )
                .child(Btn::new(("field-select", index), Look::Ghost).tiny().icon("mouse-pointer-click").tip("Select this field's bits").on_click(cx.listener(
                    move |this, _, _, cx| {
                        this.selection = Some((lo, hi));
                        cx.notify();
                    },
                )))
                .child(
                    Btn::new(("field-remove", index), Look::Danger)
                        .tiny()
                        .icon("trash")
                        .tip("Remove this field")
                        .test_label(self.label(format!("field-remove-{index}"))())
                        .on_click(cx.listener(move |this, _, window, cx| this.commit(None, window, cx, move |v| Ok(v.remove_field(index))))),
                );

            let mut first = div().flex().items_center().gap(r(6.0)).min_w_0().child(swatch).child(name).child(bits).child(div().flex_1()).child(tools);
            // the meaning a formula, unit or sign gives the raw value
            if field.details.signed || !field.details.formula.is_empty() || !field.details.unit.is_empty() {
                if is_invertible(field) {
                    first = first.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(r(4.0))
                            .child(self.field(
                                Slot::Meaning(index),
                                Look2 { title: true, height: 26.0, float: true, ..Look2::mono(Some(10.0 * ch(13.0) + 20.0)) },
                                window,
                                cx,
                            ))
                            .when(!field.details.unit.is_empty(), |decoded| {
                                decoded.child(div().text_size(r(12.0)).text_color(palette.muted).child(field.details.unit.to_string()))
                            }),
                    );
                } else {
                    first = first.child(div().font_family(mono()).text_size(r(12.5)).text_color(palette.float).whitespace_nowrap().child(
                        match decode_field(field, raw) {
                            Ok(text) => text,
                            Err(error) => format!("⚠ {}", error.0),
                        },
                    ));
                }
            }
            first = first.child(edit).child(base_label);

            let matched = self.matches.contains(&*field.name);
            let mut item = div()
                .id(("field", index))
                .group(group)
                .w(r(column_width))
                .flex()
                .flex_col()
                .gap(r(3.0))
                .py(r(8.0))
                .border_b_1()
                .border_color(palette.border)
                .when(matched, |item| item.bg(palette.select_soft))
                .child(first);
            if !field.details.description.is_empty() {
                item = item.child(div().pl(r(16.0)).text_size(r(12.5)).text_color(palette.muted).child(field.details.description.to_string()));
            }
            if !field.details.named.is_empty() {
                let card = cx.entity().downgrade();
                let width = field.width();
                if field.details.named.len() <= 8 {
                    let mut pills = div().flex().flex_wrap().gap(r(5.0)).pl(r(16.0)).pt(r(3.0));
                    for (position, named) in field.details.named.iter().enumerate() {
                        let number = named.value;
                        let on = number == raw;
                        let card = card.clone();
                        pills = pills.child(
                            div()
                                .id(("named", index * 256 + position))
                                .h(r(24.0))
                                .px(r(9.0))
                                .flex()
                                .items_center()
                                .rounded_full()
                                .border_1()
                                .border_color(if on { palette.accent } else { palette.border })
                                .bg(if on { palette.accent } else { theme::transparent() })
                                .text_color(if on { palette.on_accent } else { palette.text })
                                .text_size(r(12.0))
                                .cursor_pointer()
                                .when(!on, |pill| pill.hover(move |style| style.border_color(palette.muted)))
                                .tooltip(move |window, cx| Tooltip::new(format!("Value {number}")).build(window, cx))
                                .on_click(move |_, window, cx| {
                                    card.update(cx, |c, cx| {
                                        let next = c.value.with_bits(lo, width, number);
                                        c.set_value_guarded(next, None, None, window, cx);
                                    })
                                    .ok();
                                })
                                .child(named.label.to_string()),
                        );
                    }
                    item = item.child(pills);
                } else {
                    let named: Vec<(Bits, String)> = field.details.named.iter().map(|named| (named.value, named.label.to_string())).collect();
                    let current = field.name_of(raw).map(str::to_string).unwrap_or_else(|| "—".into());
                    item = item.child(div().pl(r(16.0)).pt(r(3.0)).child(Btn::new(("named", index), Look::Outline).small().label(current).menu(
                        Anchor::TopLeft,
                        move |mut menu, _, _| {
                            for (number, label) in &named {
                                let number = *number;
                                menu = menu.item(
                                    entry(&card, format!("{label}  ({number})"), None, move |c, w, cx| {
                                        let next = c.value.with_bits(lo, width, number);
                                        c.set_value_guarded(next, None, None, w, cx);
                                    })
                                    .checked(number == raw),
                                );
                            }
                            menu
                        },
                    )));
                }
            }
            list = list.child(item);
        }
        panel = panel.child(list);
        panel
    }

    /// The fields panel, for the tour to point at.
    pub(super) fn render_fields_anchored(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let panel = self.render_fields(window, cx);
        crate::tour::anchor("fields", panel)
    }

    // ------------------------------------------------------------ readout chips
    pub(super) fn render_stats(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<Div> {
        let settings = app_state::settings(cx);
        if !settings.show_interp {
            return None;
        }
        let palette = theme::current();
        let enabled = settings.readout_chips.clone();
        let (bits, width) = (self.value.value, self.value.width);
        let stat = |label: String, label_color: Rgba| {
            div()
                .flex()
                .items_baseline()
                .gap(r(8.0))
                .pr(r(theme::space(14.0, 10.0)))
                .py(r(2.0))
                .max_w_full()
                .child(div().text_size(r(11.0)).font_weight(FontWeight::SEMIBOLD).text_color(label_color).child(label.to_uppercase()))
        };
        let mut stats = div().flex().flex_wrap().gap(r(8.0));
        for chip in &CHIPS {
            if !enabled.iter().any(|id| id == chip.id) {
                continue;
            }
            if chip.id == "float" {
                for (index, &kind) in float_kinds(width).iter().enumerate() {
                    let number = decode_float(bits, kind);
                    let shown: AnyElement = if self.editing_float == Some(index) {
                        self.field(Slot::Float(index), Look2 { height: 22.0, font: 12.5, ..Look2::mono(Some(16.0 * ch(12.5) + 12.0)) }, window, cx)
                            .px(r(6.0))
                            .into_any_element()
                    } else {
                        div()
                            .id(("float", index))
                            .debug_selector(self.label(format!("float-{index}")))
                            .px(r(2.0))
                            .rounded(r(4.0))
                            .cursor_text()
                            .font_family(mono())
                            .text_size(r(12.5))
                            .hover(move |style| style.bg(palette.surface_3))
                            .tooltip(|window, cx| Tooltip::new("Click to type a number").build(window, cx))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.editing_float = Some(index);
                                this.activate(Slot::Float(index), window, cx);
                            }))
                            .child(format_float_kind(number, kind))
                            .into_any_element()
                    };
                    let breakdown: SharedString = format!("IEEE-754 {}: {}", kind.name(), float_breakdown(number)).into();
                    stats = stats.child(
                        div().id(("float-chip", index)).tooltip(move |window, cx| Tooltip::new(breakdown.clone()).build(window, cx)).child(
                            stat(kind.name().to_string(), palette.float)
                                .child(shown)
                                .child(div().font_family(mono()).text_size(r(11.0)).text_color(palette.faint).child(float_breakdown(number))),
                        ),
                    );
                }
                continue;
            }
            let tip = (chip.tip)(width);
            stats = stats.child(
                div()
                    .id(chip.id)
                    .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                    .child(stat((chip.short)(width), palette.muted).child(div().font_family(mono()).text_size(r(12.5)).child((chip.value)(bits, width)))),
            );
        }
        let chosen = enabled.clone();
        stats = stats.child(div().flex().items_center().opacity(0.7).hover(|style| style.opacity(1.0)).child(
            Btn::new("chips", Look::Ghost).small().icon("plus").tip("Choose readouts").menu(Anchor::TopLeft, move |mut menu, _, _| {
                for chip in &CHIPS {
                    let id = chip.id;
                    menu = menu.item(PopupMenuItem::new(chip.label).checked(chosen.iter().any(|c| c == id)).on_click(move |_, _, cx| {
                        app_state::update(cx, |settings| {
                            let on = settings.readout_chips.iter().any(|c| c == id);
                            let mut now: Vec<&str> = settings.readout_chips.iter().map(String::as_str).collect();
                            if on {
                                now.retain(|c| *c != id);
                            } else {
                                now.push(id);
                            }
                            settings.readout_chips = CHIPS.iter().map(|c| c.id).filter(|c| now.contains(c)).map(String::from).collect();
                        });
                    }));
                }
                menu
            }),
        ));
        Some(stats)
    }
}

/// The menu of the row starting at `lo` (or of its compare row). `bit` is
/// the bit that was right-clicked, if any: its field gets entries too.
pub(super) fn row_menu_items(
    mut menu: PopupMenu,
    window: &mut Window,
    cx: &mut Context<PopupMenu>,
    card: &WeakEntity<CardView>,
    lo: usize,
    compare: bool,
    bit: Option<usize>,
) -> PopupMenu {
    let Some(view) = card.upgrade() else { return menu };
    let (value, has_selection) = {
        let this = view.read(cx);
        (this.value.clone(), this.selection.is_some())
    };
    let row_width = value.row_width_at(lo);
    let has_compare = value.has_compare(lo);
    let row_op = move |c: &mut CardView, op: Op, w: &mut Window, cx: &mut Context<CardView>| c.row_op(lo, compare, op, w, cx);
    if !compare {
        menu = menu.item(entry(card, "Group selection", Some("group"), |c, w, cx| c.group_selection(w, cx)).disabled(!has_selection));
        if let Some(index) = bit.and_then(|bit| value.field_at(bit)) {
            let field = value.fields[index].clone();
            let name = field.name.to_string();
            let colour_card = card.clone();
            menu = menu
                .item(entry(card, format!("Rename “{name}”…"), Some("pencil-line"), move |c, w, cx| c.rename_field_prompt(index, w, cx)))
                .submenu_with_icon(
                    Some(gpui_kit::component::Icon::empty().path("icons/palette.svg")),
                    format!("Colour of “{name}”"),
                    window,
                    cx,
                    move |menu, _, _| colour_menu(menu, &colour_card, index),
                )
                .item(entry(card, format!("Select “{name}”"), Some("mouse-pointer-click"), move |c, _, cx| {
                    c.selection = Some((field.lo, field.hi));
                    cx.notify();
                }))
                .item(
                    entry(card, format!("Resize “{name}” to selection"), Some("move-horizontal"), move |c, w, cx| {
                        let Some((lo, hi)) = c.selection else { return };
                        c.commit(None, w, cx, move |v| v.resize_field(index, lo, hi).map(|_| true));
                        c.clear_selection(cx);
                        crate::sound::play(crate::sound::Sound::Group, cx);
                    })
                    .disabled(!has_selection),
                )
                .item(entry(card, format!("Remove “{name}”"), Some("trash"), move |c, w, cx| {
                    c.commit(None, w, cx, move |v| Ok(v.remove_field(index)));
                    crate::sound::play(crate::sound::Sound::Remove, cx);
                }));
        }
        menu = menu.separator();
    }
    for (op, text) in
        [(Op::Invert, "Invert bits"), (Op::Clear, "Clear (all 0)"), (Op::Set, "Set (all 1)"), (Op::Shl, "Shift left ≪ 1"), (Op::Shr, "Shift right ≫ 1")]
    {
        menu = menu.item(entry(card, text, None, move |c, w, cx| row_op(c, op, w, cx)));
    }
    let more_card = card.clone();
    menu = menu.submenu_with_icon(Some(gpui_kit::component::Icon::empty().path("icons/chevron-down.svg")), "More operations", window, cx, move |menu, _, _| {
        more_ops_menu(menu, &more_card, row_width, Some((lo, compare)), row_op)
    });
    let copy_card = card.clone();
    menu = menu.separator().submenu_with_icon(Some(gpui_kit::component::Icon::empty().path("icons/copy.svg")), "Copy", window, cx, move |mut menu, _, _| {
        for base in Base::ORDER {
            menu = menu.item(entry(&copy_card, format!("as {}", base.name()), None, move |c, w, cx| c.copy_row_as(lo, compare, base, w, cx)));
        }
        menu
    });
    menu = menu.separator();
    let remove = entry(card, "Remove compare row", Some("x"), move |c, w, cx| {
        c.commit(None, w, cx, move |v| Ok(v.remove_compare(lo)));
        crate::sound::play(crate::sound::Sound::Remove, cx);
    });
    if compare {
        menu.item(entry(card, "Reset to parent value", Some("undo-2"), move |c, w, cx| {
            c.commit(None, w, cx, move |v| {
                let parent = v.row_value(lo);
                v.set_compare(lo, parent)
            })
        }))
        .item(entry(card, "Copy compare into parent", Some("arrow-up"), move |c, w, cx| {
            if let Ok(compare) = c.value.compare_value(lo) {
                let next = c.value.with_bits(lo, row_width, compare);
                c.set_value_guarded(next, None, None, w, cx);
            }
        }))
        .item(remove)
    } else if has_compare {
        menu.item(remove)
    } else {
        menu.item(entry(card, "Compare", Some("git-compare-arrows"), move |c, w, cx| c.toggle_compare(lo, w, cx)))
    }
}

/// The field colours to pick from, each with its swatch.
pub(super) fn colour_menu(mut menu: PopupMenu, card: &WeakEntity<CardView>, index: usize) -> PopupMenu {
    for colour in bitviewer_core::field::FIELD_COLORS {
        let swatch = theme::field_color(colour, 1.0);
        let card = card.clone();
        menu = menu.item(
            PopupMenuItem::element(move |_, _| {
                div().flex().items_center().gap(r(8.0)).child(div().size(r(12.0)).rounded_full().bg(swatch)).child(colour.to_uppercase())
            })
            .on_click(move |_, window, cx| {
                card.update(cx, |c, cx| {
                    c.commit(None, window, cx, move |v| v.update_field(index, None, Some(colour), None));
                })
                .ok();
            }),
        );
    }
    menu
}

/// A bit's tooltip (the web app's bitTip): its value, its field, hints.
fn bit_tip(value: &bitviewer_core::value::Value, bit: usize, lo: usize, compare: bool) -> String {
    let mut lines = Vec::new();
    let own = u8::from(value.bit(bit));
    if compare {
        let compare_bit = u8::from(value.compare_bit(lo, bit).unwrap_or(false));
        let differs = if compare_bit == own { String::new() } else { format!("   ≠ parent {own}") };
        lines.push(format!("Bit {bit} (compare) = {compare_bit}{differs}"));
    } else {
        lines.push(format!("Bit {bit} = {own}"));
    }
    if let Some(index) = value.field_at(bit) {
        let field = &value.fields[index];
        let raw = value.field_value(index);
        let decoded = decode_field(field, raw).unwrap_or_default();
        let extra: Vec<&str> = [decoded.as_str(), field.name_of(raw).unwrap_or("")].into_iter().filter(|part| !part.is_empty()).collect();
        let extra = if extra.is_empty() { String::new() } else { format!("  ({})", extra.join(" · ")) };
        lines.push(format!("{} {} = {}{extra}", field.name, field.label(), format_int(raw, field.base, field.width(), true, false)));
        match field.details.access {
            bitviewer_core::field::Access::ReadOnly => lines.push("🔒 read-only field".into()),
            bitviewer_core::field::Access::Reserved => lines.push("🔒 reserved field".into()),
            bitviewer_core::field::Access::ReadWrite => {}
        }
        if !field.details.description.is_empty() {
            lines.push(field.details.description.to_string());
        }
    }
    if !compare {
        lines.push("Click: flip · Drag: select · Shift+click: extend".into());
    }
    lines.join(
        "
",
    )
}

/// "⇄ Compare" before a compare row.
fn compare_label() -> Div {
    let palette = theme::current();
    div()
        .flex()
        .items_center()
        .gap(r(6.0))
        .text_color(palette.link)
        .font_weight(FontWeight::SEMIBOLD)
        .text_size(r(12.5))
        .child(icon("git-compare-arrows", 14.0).text_color(palette.link))
        .child("Compare")
}

/// Diagonal stripes over a protected field's bits.
fn hatching(on: bool, light: bool) -> impl IntoElement {
    // as bits.css: light stripes on dark cells, dark ones on light cells
    let alpha = match (on, light) {
        (false, _) => 0.07,
        (true, false) => 0.18,
        (true, true) => 0.22,
    };
    let level = if on == light { 1.0 } else { 0.0 };
    let stripe = Rgba { r: level, g: level, b: level, a: alpha };
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            window.with_content_mask(Some(ContentMask { bounds }), |window| {
                // 2px stripes every 6px, at 135°
                let step = px(6.0 * std::f32::consts::SQRT_2);
                let stripe_width = px(2.0 * std::f32::consts::SQRT_2);
                let height = bounds.size.height;
                let mut x = bounds.origin.x - height;
                while x < bounds.origin.x + bounds.size.width {
                    let mut path = PathBuilder::fill();
                    path.move_to(point(x, bounds.origin.y + height));
                    path.line_to(point(x + height, bounds.origin.y));
                    path.line_to(point(x + height + stripe_width, bounds.origin.y));
                    path.line_to(point(x + stripe_width, bounds.origin.y + height));
                    path.close();
                    if let Ok(path) = path.build() {
                        window.paint_path(path, stripe);
                    }
                    x += step;
                }
            });
        },
    )
    .absolute()
    .size_full()
    .rounded(px(6.0))
}
