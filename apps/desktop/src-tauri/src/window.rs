//! 多窗口：把任一栏弹成独立窗口（DESIGN.md §4.6）。
//!
//! 用 Tauri 原生多 WebView 实现，前端通过 URL query 决定渲染哪一栏：
//!     ?pane=screen&device=dev-a
//! 同一个 (pane, device) 只会存在一个窗口，重复调用会把已有窗口置顶。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
pub fn open_pane_window(app: AppHandle, pane: String, device_id: String) -> Result<String, String> {
    let allowed = ["screen", "graph", "events"];
    if !allowed.contains(&pane.as_str()) {
        return Err(format!("未知的面板类型: {pane}"));
    }

    let label = format!("pane-{pane}-{device_id}");
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(label);
    }

    let url = format!("index.html?pane={pane}&device={device_id}");
    let title = match pane.as_str() {
        "screen" => "GamePilot · 画面",
        "graph" => "GamePilot · 状态图",
        _ => "GamePilot · 事件",
    };

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(820.0, 960.0)
        .min_inner_size(420.0, 320.0)
        .build()
        .map_err(|error| format!("创建窗口失败: {error}"))?;

    Ok(label)
}
