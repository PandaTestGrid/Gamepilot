//! 引擎 sidecar 桥：把 Python 引擎的 stdio JSON-RPC 暴露成两个 Tauri 命令。
//!
//! 契约（docs/rpc.md）：NDJSON，每行一个 JSON 对象。
//! - 前端调用 `engine_rpc` → 这里写一行请求，按 `id` 等待响应（上限 10s）
//! - 引擎主动推送（无 `id`）→ 转成 `engine://event` 事件发给前端
//!
//! 为什么要自己写这一层而不是用 shell 插件：
//! 需要「按 id 路由响应 + 区分通知 + 进程生命周期守护」，插件层做不了这个语义。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};

/// 引擎通知转发给前端时用的事件名（前端 src/lib/rpc.ts 订阅同名事件）
const EVENT_ENGINE: &str = "engine://event";
/// 单次 RPC 的等待上限；超时说明引擎卡死或崩溃
const RPC_TIMEOUT: Duration = Duration::from_secs(10);

struct EngineProcess {
    child: Child,
    stdin: ChildStdin,
}

/// 引擎桥的全局状态（Tauri `manage`）。
pub struct Bridge {
    process: Mutex<Option<EngineProcess>>,
    pending: Mutex<HashMap<u64, Sender<Value>>>,
    next_id: AtomicU64,
}

impl Bridge {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
        }
    }
}

impl Default for Bridge {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Serialize)]
struct Notification {
    method: String,
    params: Value,
}

/// 启动引擎（幂等）。开发态用仓库内 `engine/.venv`，打包后走 `GAMEPILOT_ENGINE_BIN`。
#[tauri::command]
pub fn engine_start(app: AppHandle, bridge: State<'_, Bridge>) -> Result<String, String> {
    let mut guard = bridge.process.lock().map_err(|e| e.to_string())?;

    // 已在运行：直接返回，不重复拉起
    if let Some(existing) = guard.as_mut()
        && existing
            .child
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
    {
        return Ok("already-running".to_string());
    }

    let (program, args, cwd) = resolve_engine_command()?;
    let mut child = Command::new(&program)
        .args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // 引擎日志走 stderr，直接继承到应用日志，不污染协议流
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("启动引擎失败 ({}): {e}", program.display()))?;

    let stdin = child.stdin.take().ok_or("无法获取引擎 stdin")?;
    let stdout = child.stdout.take().ok_or("无法获取引擎 stdout")?;

    let app_handle = app.clone();
    std::thread::spawn(move || read_loop(app_handle, stdout));

    *guard = Some(EngineProcess { child, stdin });
    Ok(format!("started: {}", program.display()))
}

/// 发一个 JSON-RPC 请求并等待对应响应。
#[tauri::command]
pub fn engine_rpc(
    bridge: State<'_, Bridge>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let id = bridge.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let request = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params.unwrap_or_else(|| json!({})),
    });

    let (sender, receiver) = channel::<Value>();
    bridge
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, sender);

    {
        let mut guard = bridge.process.lock().map_err(|e| e.to_string())?;
        let process = guard.as_mut().ok_or("引擎未启动，请先调用 engine_start")?;
        writeln!(process.stdin, "{request}").map_err(|e| format!("写入引擎失败: {e}"))?;
        process.stdin.flush().map_err(|e| e.to_string())?;
    }

    match receiver.recv_timeout(RPC_TIMEOUT) {
        Ok(payload) => {
            if let Some(error) = payload.get("error") {
                return Err(format!("引擎返回错误: {error}"));
            }
            Ok(payload.get("result").cloned().unwrap_or(Value::Null))
        }
        Err(_) => {
            let _ = bridge.pending.lock().map(|mut map| map.remove(&id));
            Err(format!("引擎响应超时（>{RPC_TIMEOUT:?}）"))
        }
    }
}

/// 停止引擎。会先尝试优雅退出（发 engine.shutdown 由前端负责），这里直接终止进程。
#[tauri::command]
pub fn engine_stop(bridge: State<'_, Bridge>) -> Result<(), String> {
    let mut guard = bridge.process.lock().map_err(|e| e.to_string())?;
    if let Some(mut process) = guard.take() {
        process.child.kill().map_err(|e| e.to_string())?;
        let _ = process.child.wait();
    }
    bridge.pending.lock().map_err(|e| e.to_string())?.clear();
    Ok(())
}

/// 读引擎 stdout：带 `id` 的是响应（路由给等待方），其余是通知（转发给前端）。
fn read_loop(app: AppHandle, stdout: impl std::io::Read) {
    let bridge = app.state::<Bridge>();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(payload) = serde_json::from_str::<Value>(trimmed) else {
            // 协议帧解析失败不能打死读线程：多为引擎侧误写 stdout，记录后跳过
            log::warn!("引擎输出不是合法 JSON: {}", trimmed);
            continue;
        };

        if let Some(id) = payload.get("id").and_then(Value::as_u64) {
            let waiter = bridge
                .pending
                .lock()
                .ok()
                .and_then(|mut map| map.remove(&id));
            if let Some(sender) = waiter {
                let _ = sender.send(payload);
            } else {
                log::warn!("收到无人等待的响应 id={id}");
            }
            continue;
        }

        let method = payload
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let params = payload.get("params").cloned().unwrap_or(Value::Null);
        let _ = app.emit(EVENT_ENGINE, Notification { method, params });
    }
    log::info!("引擎 stdout 已关闭（进程退出？）");
}

/// 解析如何启动引擎：
/// 1. `GAMEPILOT_ENGINE_BIN` —— 打包后指向 PyInstaller 单文件 sidecar；
/// 2. 开发态 —— 仓库 `engine/.venv` 里的解释器（M5 再做 PyInstaller 打包）。
fn resolve_engine_command() -> Result<(PathBuf, Vec<String>, PathBuf), String> {
    if let Ok(raw) = std::env::var("GAMEPILOT_ENGINE_BIN") {
        let program = PathBuf::from(raw);
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        return Ok((program, vec!["--stdio".to_string()], cwd));
    }

    // CARGO_MANIFEST_DIR = <repo>/apps/desktop/src-tauri
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or("无法定位仓库根目录")?
        .to_path_buf();
    let engine_dir = repo_root.join("engine");

    let venv_python = if cfg!(windows) {
        engine_dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        engine_dir.join(".venv").join("bin").join("python")
    };
    let program = if venv_python.exists() {
        venv_python
    } else {
        log::warn!("未找到 engine/.venv，回退到系统 python3（先跑 `cd engine && uv sync`）");
        PathBuf::from("python3")
    };

    Ok((
        program,
        vec!["-m".to_string(), "gamepilot.rpc".to_string()],
        engine_dir,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spawn_engine() -> (
        std::process::Child,
        std::process::ChildStdin,
        BufReader<std::process::ChildStdout>,
    ) {
        let (program, args, cwd) = resolve_engine_command().expect("解析引擎启动命令");
        let mut child = Command::new(&program)
            .args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap_or_else(|e| panic!("启动引擎失败 ({}): {e}", program.display()));
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        (child, stdin, BufReader::new(stdout))
    }

    /// 骨架级端到端：Rust 侧启动命令解析出来的 Python 引擎，确实能 ping 通。
    #[test]
    fn engine_responds_to_ping_over_stdio() {
        let (mut child, mut stdin, mut reader) = spawn_engine();

        let mut line = String::new();
        reader.read_line(&mut line).expect("读取 engine.ready");
        let ready: Value = serde_json::from_str(line.trim()).expect("engine.ready 是合法 JSON");
        assert_eq!(ready["method"], "engine.ready");
        assert!(ready.get("id").is_none(), "通知不应带 id");

        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":1,"method":"engine.ping","params":{{}}}}"#
        )
        .expect("写入请求");
        stdin.flush().expect("flush");

        line.clear();
        reader.read_line(&mut line).expect("读取 ping 响应");
        let response: Value = serde_json::from_str(line.trim()).expect("响应是合法 JSON");
        assert_eq!(response["id"], 1);
        assert_eq!(response["result"]["pong"], true);
        assert_eq!(response["result"]["protocol"], 1);

        let _ = child.kill();
        let _ = child.wait();
    }

    /// 开发态必须解析到仓库内的 venv 解释器（否则说明目录结构或 uv sync 有问题）。
    #[test]
    fn resolves_engine_interpreter_in_repo() {
        let (program, args, cwd) = resolve_engine_command().expect("解析引擎启动命令");
        assert!(
            cwd.ends_with("engine"),
            "cwd 应为 engine 目录: {}",
            cwd.display()
        );
        assert_eq!(args, vec!["-m".to_string(), "gamepilot.rpc".to_string()]);
        if std::env::var("GAMEPILOT_ENGINE_BIN").is_err() && !cfg!(windows) {
            assert!(
                program.exists(),
                "找不到 engine/.venv 解释器（先执行 cd engine && uv sync）: {}",
                program.display()
            );
        }
    }
}
