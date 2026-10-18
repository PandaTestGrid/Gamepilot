//! 多窗口：把任一栏弹成独立窗口（DESIGN.md §4.6）。
//!
//! 用 Tauri 原生多 WebView 实现，前端通过 URL query 决定渲染哪一栏：
//!     ?pane=screen&device=dev-a
//! 同一个 (pane, device) 只会存在一个窗口，重复调用会把已有窗口置顶。
//!
//! 窗口 label 不能直接塞设备 id：adb 序列号带 `:`，Tauri 的 label 虽然允许冒号，
//! 但 capabilities 的 glob（`pane-*`）和部分 WebView2 路径会踩坑。所以 label 只留
//! 字母数字和连字符，设备 id 走 query（百分号编码）。

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
pub fn open_pane_window(app: AppHandle, pane: String, device_id: String) -> Result<String, String> {
    let allowed = ["screen", "graph", "events"];
    if !allowed.contains(&pane.as_str()) {
        return Err(format!("未知的面板类型: {pane}"));
    }
    if device_id.trim().is_empty() {
        return Err("打开独立窗口需要设备 id".into());
    }

    let label = pane_window_label(&pane, &device_id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(label);
    }

    let url = format!(
        "index.html?pane={pane}&device={}",
        percent_encode_component(&device_id)
    );
    let title = match pane.as_str() {
        "screen" => "GamePilot · 画面",
        "graph" => "GamePilot · 状态图",
        _ => "GamePilot · 事件",
    };

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(820.0, 960.0)
        .min_inner_size(420.0, 320.0)
        .build()
        .map_err(|error| format!("创建窗口失败: {error}"))?;

    let app_for_close = app.clone();
    let closed_id = device_id.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = app_for_close.emit("pane-window-closed", &closed_id);
        }
    });

    Ok(label)
}

fn pane_window_label(pane: &str, device_id: &str) -> String {
    let mut safe = String::new();
    for ch in device_id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            safe.push(ch);
        } else {
            safe.push('-');
        }
    }
    if safe.len() > 48 {
        safe.truncate(48);
    }
    format!("pane-{pane}-{safe}-{:x}", fnv1a_32(device_id.as_bytes()))
}

fn fnv1a_32(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

fn percent_encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
