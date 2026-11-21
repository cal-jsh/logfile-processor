fn main() {
    // tauri-build embeds icons/icon.ico into the exe, but does not tell cargo
    // to watch the icons, so a changed icon was skipped until a clean build.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
