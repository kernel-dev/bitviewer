//! The UI toolkit in one place: GPUI CE (the community edition of GPUI),
//! its GPUI Component library and default assets, and the few helpers the
//! app uses to start up. The rest of the app imports from here
//! (`use crate::kit::*`).

pub use gpui::*;
pub use gpui_component as component;
pub use gpui_component_assets as assets;
pub use gpui_platform::application;

/// Sets up the component library (themes, inputs, dialogs, menus). Call it
/// once, before opening a window.
pub fn init(cx: &mut App) {
    gpui_component::init(cx);
}

/// Opens a window whose content is `build`'s view inside the component
/// library's Root (which draws dialogs, notifications and sheets over it).
pub fn open_window<V: Render>(
    options: WindowOptions,
    cx: &mut App,
    build: impl FnOnce(&mut Window, &mut App) -> Entity<V>,
) -> Result<(AnyWindowHandle, Entity<V>)> {
    let mut built = None;
    let window = cx.open_window(options, |window, cx| {
        let view = build(window, cx);
        built = Some(view.clone());
        cx.new(|cx| gpui_component::Root::new(view, window, cx))
    })?;
    Ok((window.into(), built.expect("open_window ran its build closure")))
}
