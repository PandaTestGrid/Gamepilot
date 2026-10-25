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

const MAIN_WINDOW: &str = "main";
const SPLASH_WINDOW: &str = "splash";

/// 冷启动只显示固定尺寸的小窗口；工作台在后台预创建但保持隐藏。
/// 这样任务栏只出现一个应用，且大窗口不会先以整屏空白画面闪一下。
pub fn create_windows(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(MAIN_WINDOW).is_none() {
        WebviewWindowBuilder::new(
            app,
            MAIN_WINDOW,
            WebviewUrl::App("index.html?launch=main".into()),
        )
        .title("GamePilot")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1100.0, 700.0)
        .resizable(true)
        .visible(false)
        .center()
        .theme(Some(tauri::Theme::Dark))
        .build()
        .map_err(|error| format!("创建主窗口失败: {error}"))?;

        // 这里不注册销毁即退出的全局钩子：Tauri 在多 WebView 环境下会按窗口
        // 生命周期完成退出；主动 `exit(0)` 会打断另一个窗口的启动初始化。
    }

    if app.get_webview_window(SPLASH_WINDOW).is_none() {
        WebviewWindowBuilder::new(
            app,
            SPLASH_WINDOW,
            WebviewUrl::App("index.html?launch=splash".into()),
        )
        .title("GamePilot · 正在启动")
        .inner_size(520.0, 400.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .theme(Some(tauri::Theme::Dark))
        .build()
        .map_err(|error| format!("创建启动窗口失败: {error}"))?;
    }

    Ok(())
}

/// 启动页完成真实握手后才显示工作台，并关闭启动窗口。
#[tauri::command]
pub fn finish_startup(app: AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or("主窗口不存在，请重新启动 GamePilot")?;
    main.center().map_err(|error| error.to_string())?;
    main.show().map_err(|error| error.to_string())?;
    main.set_focus().map_err(|error| error.to_string())?;

    Ok(())
}

/// 主窗口完成首次 React 提交后再隐藏启动窗口。Splash 先留在后台，关闭用户仍会
/// 触发自身的退出路径；主窗口就绪后由它发 `close_launch_window` 收口。
#[tauri::command]
pub fn close_launch_window(app: AppHandle) -> Result<(), String> {
    if let Some(splash) = app.get_webview_window(SPLASH_WINDOW) {
        // 先失焦再隐藏，避免 Windows 在销毁启动窗口时把应用事件循环也退出。
        // 启动窗口不参与后续业务，隐藏比销毁更稳定；主窗口仍是唯一的可见界面。
        splash
            .hide()
            .map_err(|error| format!("隐藏启动窗口失败: {error}"))?;
    }
    Ok(())
}

/// 把某一栏弹成独立窗口。
///
/// **必须是 `async`**：Tauri 在 Windows 上的 Webview2 创建是同步等待 COM 的，
/// 同步命令里 `build()` 会死锁 —— 表现就是点一下「独立窗口」整个应用立刻未响应
/// （`docs` 里 Known issues：`WebviewWindowBuilder::build` 在同步命令/事件处理器里
/// 会 deadlock，应使用 `async` 命令）。改异步后命令跑在异步运行时上，
/// 由 runtime 把创建请求投递给事件循环，主线程不会自锁。
#[tauri::command]
pub async fn open_pane_window(app: AppHandle, pane: String, device_id: String) -> Result<String, String> {
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

/// 关掉某个独立窗口（「收回主窗口」用）。
///
/// 走这条命令而不是前端直接 `getCurrentWindow().close()`：收回动作发生在**主窗口**里，
/// 它要关的是另一个 WebView。窗口销毁后 Rust 会照常发 `pane-window-closed`，
/// 主窗口据此把 `windowed` 复位并恢复拉帧 —— 只有一处真源。
#[tauri::command]
pub fn close_pane_window(app: AppHandle, pane: String, device_id: String) -> Result<(), String> {
    let label = pane_window_label(&pane, &device_id);
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|error| format!("关闭窗口失败: {error}"))?;
    }
    Ok(())
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



