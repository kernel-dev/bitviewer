//! Files bundled into the app: the Lucide icons the web app uses (ISC
//! licence, assets/LICENSE-LUCIDE.txt), on top of the component library's
//! own assets.

use std::borrow::Cow;

use gpui_kit::{AssetSource, Result, SharedString};

#[derive(rust_embed::RustEmbed)]
#[folder = "assets"]
#[include = "icons/*.svg"]
struct Icons;

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        match Icons::get(path) {
            Some(file) => Ok(Some(file.data)),
            None => gpui_kit::assets::Assets.load(path),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut names: Vec<SharedString> = Icons::iter().filter(|name| name.starts_with(path)).map(|name| name.to_string().into()).collect();
        names.extend(gpui_kit::assets::Assets.list(path)?);
        Ok(names)
    }
}
