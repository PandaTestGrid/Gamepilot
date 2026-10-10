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
    /// 每台设备的最新一帧 JPEG。
    ///
    /// 为什么不直接把这帧塞进事件发给前端：一帧 base64 有 80KB+，14fps 就是 1MB/s 的
    /// WebView IPC 流量，实测前端收不到画面。改成"事件只发元数据（识别框/节点/序号），
    /// 帧由前端按需用 `engine_frame` 拉原始字节"。
    frames: Mutex<HashMap<String, Vec<u8>>>,
    next_id: AtomicU64,
}

impl Bridge {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            frames: Mutex::new(HashMap::new()),
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

    // 帧走独立通道：引擎把 JPEG 以原始字节写进这个 unix socket。
    // 走 stdout 的话，两台设备就是 2.4MB/s 的 base64 JSON 挤在控制通道上，
    // RPC 响应排在几万行帧后面，界面会"卡在 connecting、一帧都收不到"。
    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // 引擎日志走 stderr，直接继承到应用日志，不污染协议流
        .stderr(Stdio::inherit());
    let frame_socket = bind_frame_socket();
    if let Some((path, listener)) = frame_socket {
        command.env("GAMEPILOT_FRAME_SOCKET", &path);
        let app_for_frames = app.clone();
        std::thread::spawn(move || read_frames(app_for_frames, listener));
        log::info!("帧通道: {}", path.display());
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("启动引擎失败 ({}): {e}", program.display()))?;

    let stdin = child.stdin.take().ok_or("无法获取引擎 stdin")?;
    let stdout = child.stdout.take().ok_or("无法获取引擎 stdout")?;

    let app_handle = app.clone();
    std::thread::spawn(move || read_loop(app_handle, stdout));

    *guard = Some(EngineProcess { child, stdin });
    Ok(format!("started: {}", program.display()))
}

/// 绑定帧通道的 unix socket。
///
/// 返回 `None` 时引擎会退回"base64 塞在通知里"的老路（单测/非 unix 平台用得上）。
#[cfg(unix)]
fn bind_frame_socket() -> Option<(std::path::PathBuf, std::os::unix::net::UnixListener)> {
    // 必须用短路径：macOS 的 AF_UNIX 地址上限约 104 字节，
    // std::env::temp_dir()（/var/folders/...）叠上文件名有超限风险
    let path =
        std::path::PathBuf::from(format!("/tmp/gamepilot-frames-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    match std::os::unix::net::UnixListener::bind(&path) {
        Ok(listener) => Some((path, listener)),
        Err(error) => {
            log::warn!("帧通道 socket 创建失败（回退 base64 通道）: {error}");
            None
        }
    }
}

#[cfg(not(unix))]
fn bind_frame_socket() -> Option<(std::path::PathBuf, ())> {
    None
}

/// 读帧通道：`[idLen u8][deviceId][jpegLen u32 BE][jpeg bytes]`，循环下去。
#[cfg(unix)]
fn read_frames(app: AppHandle, listener: std::os::unix::net::UnixListener) {
    use std::io::{BufReader, Read};

    let (stream, _) = match listener.accept() {
        Ok(pair) => pair,
        Err(error) => {
            log::warn!("帧通道连接失败: {error}");
            return;
        }
    };
    let mut reader = BufReader::new(stream);
    loop {
        let mut id_len = [0u8; 1];
        if reader.read_exact(&mut id_len).is_err() {
            break;
        }
        let mut id_buf = vec![0u8; id_len[0] as usize];
        if reader.read_exact(&mut id_buf).is_err() {
            break;
        }
        let mut size_buf = [0u8; 4];
        if reader.read_exact(&mut size_buf).is_err() {
            break;
        }
        let size = u32::from_be_bytes(size_buf) as usize;
        if size == 0 || size > 8 * 1024 * 1024 {
            log::warn!("帧通道收到非法长度 {size}，断开");
            break;
        }
        let mut jpeg = vec![0u8; size];
        if reader.read_exact(&mut jpeg).is_err() {
            break;
        }
        let device_id = String::from_utf8_lossy(&id_buf).to_string();
        if let Ok(mut frames) = app.state::<Bridge>().frames.lock() {
            frames.insert(device_id, jpeg);
        }
    }
    log::info!("帧通道已关闭");
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

/// 取某台设备的最新一帧 JPEG（原始字节）。
///
/// 前端拿到的是 ArrayBuffer，可以直接 `new Blob([buf])` 造 URL 给 `<img>`，
/// 不用 base64 解码，也没有大 JSON 的 IPC 开销。
#[tauri::command]
pub fn engine_frame(
    bridge: State<'_, Bridge>,
    device_id: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = bridge
        .frames
        .lock()
        .map_err(|error| error.to_string())?
        .get(&device_id)
        .cloned()
        .unwrap_or_default();
    Ok(tauri::ipc::Response::new(bytes))
}

/// 同上的 base64 版本：万一某些平台把二进制 IPC 序列化成别的形状，前端可以退回这条。
#[tauri::command]
pub fn engine_frame_base64(bridge: State<'_, Bridge>, device_id: String) -> Result<String, String> {
    let frames = bridge.frames.lock().map_err(|error| error.to_string())?;
    Ok(frames
        .get(&device_id)
        .map(|bytes| base64_encode(bytes))
        .unwrap_or_default())
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
        let mut params = payload.get("params").cloned().unwrap_or(Value::Null);

        // engine.frame：JPEG 留在本地缓存，事件里只留元数据（去掉 jpeg 字段）
        if method == "engine.frame" {
            if let Some(frame) = params.get("jpeg").and_then(Value::as_str)
                && let (Some(device_id), Some(bytes)) = (
                    params.get("deviceId").and_then(Value::as_str),
                    base64_decode(frame),
                )
                && let Ok(mut frames) = bridge.frames.lock()
            {
                frames.insert(device_id.to_string(), bytes);
            }
            if let Some(object) = params.as_object_mut() {
                object.remove("jpeg");
            }
        }

        if let Err(error) = app.emit(EVENT_ENGINE, Notification { method, params }) {
            log::warn!("转发引擎通知失败: {error}");
        }
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

/// 标准 base64 解码（忽略换行与 `=` 填充）。引擎只发 JPEG，字符集固定，够用。
fn base64_decode(input: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some((byte - b'A') as u32),
            b'a'..=b'z' => Some((byte - b'a' + 26) as u32),
            b'0'..=b'9' => Some((byte - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for byte in input.bytes() {
        if byte == b'=' || byte == b'\n' || byte == b'\r' {
            continue;
        }
        let digit = value(byte)?;
        buffer = (buffer << 6) | digit;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod frame_tests {
    use super::base64_decode;

    #[test]
    fn encodes_round_trip() {
        for sample in [
            &b""[..],
            b"a",
            b"ab",
            b"abc",
            b"hello world",
            &[0u8, 255, 128, 7][..],
        ] {
            let encoded = super::base64_encode(sample);
            assert_eq!(
                super::base64_decode(&encoded).unwrap(),
                sample,
                "样本: {sample:?}"
            );
        }
    }

    #[test]
    fn decodes_padding_and_newlines() {
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64_decode("aGVs\nbG8=").unwrap(), b"hello");
        assert_eq!(base64_decode("").unwrap(), Vec::<u8>::new());
        assert!(base64_decode("!!!").is_none());
    }
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 标准 base64 编码（带 `=` 填充）。只用于帧数据的兜底通道。
fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_ALPHABET[((triple >> 18) & 0x3F) as usize] as char);
        out.push(BASE64_ALPHABET[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            BASE64_ALPHABET[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_ALPHABET[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}
