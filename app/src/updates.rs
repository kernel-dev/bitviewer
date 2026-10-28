//! Updates (the web app's app/updates.ts, which uses Tauri's updater): the
//! same release feed (latest.json on GitHub) and the same signing key. An
//! installer is only used when its minisign signature checks out.
//!
//! The native build's installer is the feed's "windows-x86_64-native" (or
//! "<platform>-native") entry; until a release carries one, a newer version
//! is reported without an install button.

use std::io::Read;

use base64::Engine;
use gpui_kit::component::WindowExt;
use gpui_kit::component::notification::Notification;
use gpui_kit::*;
use serde_json::Value as Json;

use crate::help_dialog::VERSION;
use crate::modal;
use crate::theme;
use crate::widgets::{Btn, Look, r};

const ENDPOINT: &str = "https://github.com/kernel-dev/bitviewer/releases/latest/download/latest.json";
/// The Tauri app's updater key (src-tauri/tauri.conf.json).
const PUBLIC_KEY: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDU3NEQ3RjRBQ0UzODg2MEYKUldRUGhqak9TbjlOVjJpVm1QZGx3aG0vSFpJdnF1Q2NaOHVlUHJLWitBQTAxdjJwQXZxLzl6VXMK";
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug)]
struct Release {
    version: String,
    notes: String,
    /// The native installer's address and signature, if the release has one.
    installer: Option<(String, String)>,
}

fn platform() -> String {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };
    format!("{os}-{arch}-native")
}

/// "2.10.0" > "2.9.1" (numeric parts; a pre-release tag counts as older).
fn newer(candidate: &str, current: &str) -> bool {
    let parts = |version: &str| -> (Vec<u64>, bool) {
        let version = version.trim_start_matches('v');
        let (core, pre) = version.split_once('-').map_or((version, false), |(core, _)| (core, true));
        (core.split('.').map(|part| part.parse().unwrap_or(0)).collect(), pre)
    };
    let (a, a_pre) = parts(candidate);
    let (b, b_pre) = parts(current);
    match a.cmp(&b) {
        std::cmp::Ordering::Equal => !a_pre && b_pre,
        order => order.is_gt(),
    }
}

fn fetch() -> Result<Option<Release>, String> {
    let feed: Json = ureq::get(ENDPOINT)
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|error| error.to_string())?
        .into_json()
        .map_err(|error| error.to_string())?;
    let version = feed.get("version").and_then(Json::as_str).ok_or("The release feed has no version")?.to_string();
    if !newer(&version, VERSION) {
        return Ok(None);
    }
    let installer = feed
        .get("platforms")
        .and_then(|platforms| platforms.get(platform()))
        .and_then(|entry| Some((entry.get("url")?.as_str()?.to_string(), entry.get("signature")?.as_str()?.to_string())));
    let notes = feed.get("notes").and_then(Json::as_str).unwrap_or("").to_string();
    Ok(Some(Release { version, notes, installer }))
}

/// Downloads the installer and checks its signature; the file's path.
fn download(url: &str, signature: &str) -> Result<std::path::PathBuf, String> {
    let response = ureq::get(url).call().map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    response.into_reader().take(MAX_DOWNLOAD).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    let decode = |text: &str| -> Result<String, String> {
        let raw = base64::engine::general_purpose::STANDARD.decode(text.trim()).map_err(|error| error.to_string())?;
        String::from_utf8(raw).map_err(|error| error.to_string())
    };
    let key = minisign_verify::PublicKey::decode(&decode(PUBLIC_KEY)?).map_err(|error| error.to_string())?;
    let signature = minisign_verify::Signature::decode(&decode(signature)?).map_err(|error| error.to_string())?;
    key.verify(&bytes, &signature, false).map_err(|_| "The download's signature doesn't match; it was not installed".to_string())?;
    let name = url.rsplit('/').next().filter(|name| !name.is_empty()).unwrap_or("bitviewer-setup.exe");
    let path = std::env::temp_dir().join(name);
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path)
}

/// Starts the installer (it replaces the app), passively as the Tauri app does.
fn run_installer(path: &std::path::Path) -> Result<(), String> {
    let lower = path.to_string_lossy().to_lowercase();
    let mut command = if lower.ends_with(".msi") {
        let mut command = std::process::Command::new("msiexec");
        command.arg("/i").arg(path).arg("/passive");
        command
    } else {
        let mut command = std::process::Command::new(path);
        command.arg("/P").arg("/R");
        command
    };
    command.spawn().map(|_| ()).map_err(|error| error.to_string())
}

/// Checks for a newer version. `manual` reports "up to date" and errors;
/// the start-up check stays silent unless an update exists.
pub fn check(manual: bool, window: &mut Window, cx: &mut App) {
    if manual {
        window.push_notification(Notification::info("Checking for updates…"), cx);
    }
    let task = cx.background_spawn(async move { fetch() });
    window
        .spawn(cx, async move |cx| {
            let result = task.await;
            cx.update(|window, cx| match result {
                Err(error) if manual => {
                    let message = format!("{error}\n\nIf no release has been published yet, this is expected.");
                    crate::value_dialogs::tell(window, cx, "Couldn't check for updates", message);
                }
                Err(_) => {}
                Ok(None) => {
                    if manual {
                        window.push_notification(Notification::success("You're on the latest version"), cx);
                    }
                }
                Ok(Some(release)) => offer(release, window, cx),
            })
            .ok();
        })
        .detach();
}

fn offer(release: Release, window: &mut Window, cx: &mut App) {
    window.open_dialog(cx, move |dialog, _, _| {
        let palette = theme::current();
        let release = release.clone();
        let mut body = div().flex().flex_col().child(div().mt(r(4.0)).mb(r(8.0)).text_color(palette.muted).child(format!("You have {VERSION}.")));
        if release.installer.is_none() {
            body = body.child(
                div().mb(r(8.0)).text_color(palette.muted).child("This release has no build of the native app yet; it can be installed once one is published."),
            );
        }
        if !release.notes.is_empty() {
            body = body.child(
                div()
                    .id("release-notes")
                    .max_h(r(260.0))
                    .overflow_y_scroll()
                    .px(r(14.0))
                    .py(r(12.0))
                    .bg(palette.input)
                    .border_1()
                    .border_color(palette.border)
                    .rounded(r(10.0))
                    .font_family(theme::mono())
                    .text_size(r(12.0))
                    .children(
                        release.notes.lines().map(|line| div().child(if line.is_empty() { " ".to_string() } else { line.to_string() })).collect::<Vec<_>>(),
                    ),
            );
        }
        let installer = release.installer.clone();
        let mut footer = modal::footer().child(Btn::new("update-later", Look::Ghost).label("Later").on_click(|_, window, cx| window.close_dialog(cx)));
        if let Some((url, signature)) = installer {
            footer = footer.child(Btn::new("update-install", Look::Primary).label("Install and restart").on_click(move |_, window, cx| {
                window.close_dialog(cx);
                install(url.clone(), signature.clone(), window, cx);
            }));
        }
        modal::frame(dialog, "cloud-download", format!("Bit Viewer {} is available", release.version), false).child(body).footer(footer)
    });
}

/// Asks about unsaved work (as Quit does), downloads, checks and runs the installer.
fn install(url: String, signature: String, window: &mut Window, cx: &mut App) {
    window.push_notification(Notification::info("Downloading update…"), cx);
    let task = cx.background_spawn(async move { download(&url, &signature) });
    window
        .spawn(cx, async move |cx| {
            let result = task.await.and_then(|path| run_installer(&path));
            cx.update(|window, cx| match result {
                Ok(()) => {
                    window.push_notification(Notification::info("Installing…"), cx);
                    window.dispatch_action(Box::new(crate::commands::Quit), cx);
                }
                Err(error) => window.push_notification(Notification::error(format!("Update failed: {error}")), cx),
            })
            .ok();
        })
        .detach();
}

#[cfg(test)]
mod update_tests {
    #[test]
    fn compares_versions() {
        use super::newer;
        assert!(newer("2.1.4", "2.1.3"));
        assert!(newer("2.10.0", "2.9.9"));
        assert!(!newer("2.1.3", "2.1.3"));
        assert!(newer("2.1.3", "2.1.3-beta"));
        assert!(!newer("2.1.3-beta", "2.1.3"));
    }
}
