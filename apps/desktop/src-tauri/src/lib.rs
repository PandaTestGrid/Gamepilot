//! GamePilot 桌面壳。
//!
//! 壳的职责只有三件事（DESIGN.md §6.2）：
//! 1. 窗口/托盘/全局快捷键等原生能力；
//! 2. 守护 Python 引擎 sidecar（拉起、重启、退出）；
//! 3. 在引擎 stdio 与前端 WebView 之间转发 JSON-RPC 与通知。
//!
//! 业务逻辑（识别、状态机、设备控制）**一律不在这里**。

mod engine;

use engine::Bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Bridge::new())
        .invoke_handler(tauri::generate_handler![
            engine::engine_start,
            engine::engine_rpc,
            engine::engine_stop
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
