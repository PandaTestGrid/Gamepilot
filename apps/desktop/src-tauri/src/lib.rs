//! GamePilot 桌面壳。
//!
//! 壳的职责只有三件事（DESIGN.md §6.2）：
//! 1. 窗口/托盘/全局快捷键等原生能力；
//! 2. 守护 Python 引擎 sidecar（拉起、重启、退出）；
//! 3. 在引擎 stdio 与前端 WebView 之间转发 JSON-RPC 与通知。
//!
//! 业务逻辑（识别、状态机、设备控制）**一律不在这里**。

mod engine;
mod window;

use engine::Bridge;

/// 前端诊断日志：打印到应用终端（`pnpm tauri dev` 的输出）。
///
/// 前端跑在 WebView 里，console 看不到；排查"事件到没到前端"这类问题时
/// （比如画面不出来、fps 一直是 0），这条通道是唯一能从终端观察前端状态的办法。
#[tauri::command]
fn dev_log(message: String) {
    println!("[ui] {message}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 原生"选文件夹"对话框（工作区面板的「添加工作区 ⌘O」用）。
        // 前端是**动态 import + try/catch** 调的：拿不到原生对话框就退回手输绝对路径，
        // 所以这个插件即使没装/没权限也不会让界面出现"点＋没反应"（见 features/library/native-dialog.ts）。
        .plugin(tauri_plugin_dialog::init())
        .manage(Bridge::new())
        .invoke_handler(tauri::generate_handler![
            engine::engine_start,
            engine::engine_rpc,
            engine::engine_stop,
            engine::engine_frame,
            engine::engine_frame_base64,
            dev_log,
            window::open_pane_window
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
