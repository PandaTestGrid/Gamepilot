fn main() {
    let target = std::env::var("TARGET").unwrap_or_else(|_| "unknown".into());
    let sidecar = if target.contains("windows") {
        format!("gamepilot-engine-{target}.exe")
    } else {
        format!("gamepilot-engine-{target}")
    };
    println!("cargo:rustc-env=GAMEPILOT_SIDECAR_NAME={sidecar}");
    tauri_build::build()
}
