//! On Windows: the app's icon and version details in the exe, so Explorer,
//! the taskbar and the window show the Bit Viewer icon.

fn main() {
    println!("cargo:rerun-if-changed=assets/app-icon/icon.ico");
    #[cfg(windows)]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut resource = winresource::WindowsResource::new();
        resource
            .set_icon("assets/app-icon/icon.ico")
            .set("ProductName", "Bit Viewer")
            .set("FileDescription", "Bit Viewer")
            .set("CompanyName", "kernel-dev")
            .set("LegalCopyright", "MIT License");
        resource.compile().expect("the Windows resources (icon, version) compile");
    }
}
