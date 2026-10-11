/**
 * 与 Python 引擎的通信边界（唯一的出口）。
 *
 * 契约：docs/rpc.md —— JSON-RPC 2.0 over stdio，NDJSON 分帧。
 * 前端不直接读进程 stdout：Rust 侧负责收发与路由，这里只调用两个命令：
 *   - `engine_rpc`：发一个请求，等一个响应
 *   - `engine://event`：引擎主动推送的通知（engine.ready / engine.log / ...）
 *
 * 改契约时的顺序：engine/src/gamepilot/protocol.py → docs/rpc.md → 本文件类型。
 */
import { invoke } from '@tauri-apps/api/core';

import type { DeviceKind } from '@/types';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { pushUiLog } from '@/lib/log-bus';

/** 与 engine/src/gamepilot/protocol.py 的 PROTOCOL_VERSION 必须一致。 */
export const PROTOCOL_VERSION = 1;

export interface EngineNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * 把"引擎/Rust 桥抛上来的错误"整成一句能直接显示给人看的话。
 *
 * 踩过的坑：JSON-RPC 的错误信封是 `{code, message}`，Rust 桥整块 format 进字符串，
 * 于是错误条上显示的是
 * `引擎返回错误: {"code":-32603,"message":"RuntimeError: 『相机』还在被使用，先改掉再删：…"}`
 * —— 用户看不到重点（被谁引用了），只看到一坨 JSON。
 *
 * 处理三件事：
 * 1. **拆信封**：只留 `message`（"引擎返回错误: "这类前缀保留，它说明哪一层报的）；
 * 2. 去掉 Python 异常类名前缀（`RuntimeError: ` / `ValueError: ` …）：对用户没有意义；
 * 3. `KeyError` 的 `str()` 会带一层单引号（`'识别器不存在: x'`），也去掉。
 *
 * 不是 JSON 信封的（Rust 自己的"引擎响应超时"之类）原样返回。
 */
export function cleanErrorText(raw: string): string {
  const text = (raw ?? '').trim();
  const brace = text.indexOf('{');
  if (brace >= 0) {
    try {
      const parsed: unknown = JSON.parse(text.slice(brace));
      const message = (parsed as { message?: unknown } | null)?.message;
      if (typeof message === 'string' && message.trim()) {
        return `${text.slice(0, brace)}${stripPythonPrefix(message)}`.trim();
      }
    } catch {
      // 不是 JSON（消息里本来就带 `{`，比如"params 必须是对象"）：按原文处理
    }
  }
  return stripPythonPrefix(text);
}

function stripPythonPrefix(message: string): string {
  let text = message.replace(/^[A-Za-z_][A-Za-z0-9_]*(?:Error|Exception|Warning):\s*/, '').trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/**
 * 发一个 JSON-RPC 请求并等待响应。
 *
 * **错误在这里统一出口**：调用方 catch 到的永远是 message 已经清理过的 `Error`。
 * 以前 20 多处各写各的 `error instanceof Error ? error.message : String(error)`，
 * 谁也没拆信封 —— 所以修在这一处，而不是每个 catch 里各补一遍。
 */
export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>('engine_rpc', { method, params });
  } catch (error) {
    // cause 留着原始错误：文案给人看，原始信封给排查用（控制台里展开就能看到 code/data）
    throw new Error(cleanErrorText(error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }
}

/** 拉起引擎 sidecar（幂等：已在运行则直接返回）。 */
export async function engineStart(): Promise<string> {
  return invoke<string>('engine_start');
}

/** 停止引擎 sidecar。 */
export async function engineStop(): Promise<void> {
  await invoke('engine_stop');
}

/** 订阅引擎通知，返回取消订阅函数。 */
export async function onEngineNotification(
  handler: (notification: EngineNotification) => void,
): Promise<UnlistenFn> {
  return listen<EngineNotification>('engine://event', (event) => {
    handler(event.payload);
  });
}

export interface PingResult {
  readonly pong: boolean;
  readonly version: string;
  readonly protocol: number;
  readonly ts: number;
}

/** 骨架自检用：确认「前端 → Rust → Python」三段链路通畅。 */
export function ping(): Promise<PingResult> {
  return rpc<PingResult>('engine.ping');
}

/** 引擎侧 `device.list` 的返回项（对应 engine/src/gamepilot/devices/base.py::DeviceInfo）。 */
export interface DeviceInfoPayload {
  readonly id: string;
  readonly uri: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly serial: string | null;
  readonly model: string | null;
  readonly product: string | null;
  readonly resolution: readonly [number, number] | null;
  readonly error: string | null;
  readonly suggestedFix: string | null;
}

export interface DeviceScanError {
  readonly provider: string;
  readonly message: string;
}

export interface DeviceListResult {
  readonly devices: readonly DeviceInfoPayload[];
  readonly errors: readonly DeviceScanError[];
}

/** 扫描可用设备（adb 真机/模拟器 + Mock）。scan=false 时只返回 Mock，用于快速首屏。 */
export function listDevices(scan = true): Promise<DeviceListResult> {
  return rpc<DeviceListResult>('device.list', { scan });
}

/* ------------------------------------------------------------------ *
 * 会话相关（第 2~6 块）：连接设备、状态图、录制、运行
 * 契约见 docs/rpc.md
 * ------------------------------------------------------------------ */

export interface GraphEdgePayload {
  id: string;
  when?: string;
  from?: string | null;
  to?: string | null;
  kind?: string;
  priority?: number;
  min_score?: number;
  cooldown_ms?: number;
  retries?: number;
  condition?: Record<string, unknown> | null;
  action?: Record<string, unknown> | null;
}

export interface GraphPayload {
  readonly version: number;
  readonly defaults: Record<string, unknown>;
  readonly recognizers: Record<string, Record<string, unknown>>;
  readonly nodes: ReadonlyArray<{ id: string; name?: string; enter?: string[]; timeout_ms?: number }>;
  readonly edges: ReadonlyArray<Record<string, unknown>>;
  /** 变量（"黑板"）：动作参数可以引用它们 */
  readonly variables?: Record<string, { type?: string; value?: number | string | boolean }>;
}

export interface ConnectResult {
  readonly deviceId: string;
  readonly resolution: readonly [number, number];
  /** scrcpy（H.264，流畅）| screencap（adb 截图，约 1.8fps）| dvt（iOS）| quartz（macOS 窗口） */
  readonly channel: string;
  readonly linkNote: string;
  readonly graph: GraphPayload;
  /** 人类可读的名字（iOS 型号 / macOS 窗口标题）；界面用它显示设备条目 */
  readonly name?: string;
  /** 设备类型（ios / windows / …），界面用来选对图标与文案 */
  readonly kind?: DeviceKind;
}

export interface RecordResult {
  readonly label: string;
  readonly mode: 'template' | 'color';
  readonly template: string;
  readonly rect: readonly [number, number, number, number];
  readonly graph: GraphPayload;
}

/** 引擎推送的一帧画面（engine.frame 通知）。 */
export interface FramePayload {
  readonly deviceId: string;
  readonly index: number;
  readonly ts: number;
  readonly resolution: readonly [number, number];
  readonly node: string | null;
  readonly pending: string | null;
  readonly tick: number;
  readonly fps: number;
  readonly captureMs: number;
  readonly detections: ReadonlyArray<{
    label: string;
    rect: readonly [number, number, number, number];
    score: number;
    source: string;
    state: 'confirmed' | 'pending' | 'idle';
  }>;
  /** 只有老引擎会塞在事件里；新引擎的帧走 `fetchFrame`（原始字节） */
  readonly jpeg?: string;
}

/** 引擎推送的状态机事件（engine.event 通知）。 */
export interface EngineEventPayload {
  readonly deviceId: string;
  readonly seq: number;
  readonly ts: number;
  readonly type: string;
  readonly node: string | null;
  readonly edge: string | null;
  readonly message: string;
}

export interface DeviceNotificationPayload {
  readonly deviceId: string;
  readonly uri?: string;
  readonly phase?: string;
  readonly resolution?: readonly [number, number];
  readonly channel?: string;
  readonly linkNote?: string;
  readonly error?: string;
  readonly graph?: GraphPayload;
}

/**
 * 拉取某台设备的最新一帧 JPEG（原始字节）。
 *
 * 画面**不走事件**：一帧 base64 有 80KB+，14fps 就是 1MB/s 的 WebView IPC 流量，
 * 实测前端收不到画面。改成事件只发元数据（识别框/节点/序号），帧按需拉。
 */
export async function fetchFrame(deviceId: string): Promise<ArrayBuffer | null> {
  // 首选：原始字节（Tauri binary IPC → ArrayBuffer）
  try {
    const data = await invoke<ArrayBuffer | Uint8Array | number[]>('engine_frame', { deviceId });
    if (data instanceof ArrayBuffer && data.byteLength > 0) {
      return data;
    }
    if (data instanceof Uint8Array && data.byteLength > 0) {
      return data.slice().buffer;
    }
    if (Array.isArray(data) && data.length > 0) {
      return new Uint8Array(data).buffer;
    }
  } catch {
    // 某些平台把二进制响应序列化成别的形状：落到 base64 兜底
  }
  const text = await invoke<string>('engine_frame_base64', { deviceId });
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  const binary = atob(text);
  const buffer = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    buffer[index] = binary.charCodeAt(index);
  }
  return buffer.buffer;
}

/**
 * 取最新帧的 base64 版本（兜底路径）。
 *
 * 正常走 `fetchFrame` 的原始字节；只有在 blob URL 渲染失败时才用这条，
 * 换来的是"一定能显示"（data URL 不涉及对象 URL 生命周期）。
 */
export async function fetchFrameDataUrl(deviceId: string): Promise<string | null> {
  const text = await invoke<string>('engine_frame_base64', { deviceId });
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  return `data:image/jpeg;base64,${text}`;
}

/**
 * 告诉引擎这台设备界面要看多少帧（0 = 先别推）。
 *
 * 引擎的截图、识别、状态机照常跑，只是不再编码 JPEG 推给界面：
 * 多设备同时投屏时，这是最大的一笔开销（每帧 60~143KB，14fps 就是 1~2MB/s）。
 */
/**
 * 实时触控：一次一个事件（down/move/up），坐标是**相对画面**的归一化值。
 *
 * 拖动时前端会连续发 move，而不是松手后合成一次滑动 —— 这样手机上的滑动才是
 * 跟手的（合成滑动看起来是"延迟一下跳过去"）。
 */
export function deviceTouch(
  deviceId: string,
  phase: 'down' | 'move' | 'up',
  x: number,
  y: number,
): Promise<unknown> {
  return invoke('engine_rpc', { method: 'device.touch', params: { deviceId, phase, x, y } });
}

/** 手动控制：归一化坐标轻触（走 scrcpy 控制通道，实测 0.1ms） */
export function deviceTap(deviceId: string, x: number, y: number): Promise<unknown> {
  return invoke('engine_rpc', { method: 'device.tap', params: { deviceId, x, y } });
}

/** 手动控制：归一化坐标滑动 */
export function deviceSwipe(
  deviceId: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number,
): Promise<unknown> {
  return invoke('engine_rpc', {
    method: 'device.swipe',
    params: { deviceId, x1, y1, x2, y2, durationMs },
  });
}

/** 手动控制：功能键（back / home / recents / power / volume_up / volume_down） */
export function deviceKey(deviceId: string, key: string): Promise<unknown> {
  return invoke('engine_rpc', { method: 'device.key', params: { deviceId, key } });
}

export function setStreamFps(deviceId: string, fps: number): Promise<unknown> {
  return invoke('engine_rpc', { method: 'device.stream', params: { deviceId, fps } });
}

export function connectDevice(uri: string): Promise<ConnectResult> {
  return rpc<ConnectResult>('device.connect', { uri });
}

export async function disconnectDevice(deviceId: string): Promise<void> {
  await rpc('device.disconnect', { deviceId });
}

export function graphGet(deviceId: string): Promise<GraphPayload> {
  return rpc<GraphPayload>('graph.get', { deviceId });
}

/** 调试：给一条边设/清断点（走到这里暂停） */
export function setBreakpoint(
  deviceId: string,
  edgeId: string,
  enabled: boolean,
): Promise<{ breakpoints: string[] }> {
  return rpc<{ breakpoints: string[] }>('run.breakpoint', { deviceId, edgeId, enabled });
}

/** 断点暂停后继续 */
export function runResume(deviceId: string): Promise<{ ok: boolean }> {
  return rpc<{ ok: boolean }>('run.resume', { deviceId });
}

/** 调试：只执行一个动作（"单独跑这一步"），不影响状态机位置 */
export function actionRun(
  deviceId: string,
  action: Record<string, unknown>,
): Promise<{ ok: boolean; described: string }> {
  return rpc<{ ok: boolean; described: string }>('action.run', { deviceId, action });
}

/** 删除一个模板/识别器（被界面或边引用时引擎会拒绝并说明被谁用了） */
export function removeRecognizer(
  deviceId: string,
  label: string,
): Promise<{ removed: string; graph: GraphPayload }> {
  return rpc<{ removed: string; graph: GraphPayload }>('recognizer.remove', { deviceId, label });
}

/** 识别器改名（引用由引擎级联改掉：节点进入条件 / 边条件 / 动作目标 / $score） */
export interface RenameRecognizerResult {
  readonly from: string;
  readonly to: string;
  /** 顺带改动了几处引用（nodes / edges / scores） */
  readonly refs: { readonly nodes: number; readonly edges: number; readonly scores: number };
  readonly graph: GraphPayload;
}

export function renameRecognizer(
  deviceId: string,
  label: string,
  to: string,
): Promise<RenameRecognizerResult> {
  return rpc<RenameRecognizerResult>('recognizer.rename', { deviceId, label, to });
}

/** macOS 本机窗口列表（界面上的窗口选择器；也可手动输句柄） */
export interface MacWindowInfo {
  readonly handle: number;
  readonly pid: number;
  readonly app: string;
  readonly title: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly uri: string;
}

export function macWindows(): Promise<{
  platform: string;
  allowed: boolean;
  windows: MacWindowInfo[];
}> {
  return rpc<{ platform: string; allowed: boolean; windows: MacWindowInfo[] }>('mac.windows', {});
}

/** 把一步手动操作录成脚本里的一条边（画面栏开着「录操作」时调） */
export function recordAction(
  deviceId: string,
  action: Record<string, unknown>,
  to?: string,
): Promise<{ edgeId: string; graph: GraphPayload }> {
  return rpc<{ edgeId: string; graph: GraphPayload }>('record.action', { deviceId, action, to });
}

export function graphNodeAdd(
  deviceId: string,
  params: { nodeId?: string; name?: string; enter?: string[] } = {},
): Promise<{ nodeId: string; graph: GraphPayload }> {
  return rpc<{ nodeId: string; graph: GraphPayload }>('graph.node.add', { deviceId, ...params });
}

export function graphNodeUpdate(
  deviceId: string,
  nodeId: string,
  patch: { name?: string; enter?: string[]; timeout_ms?: number },
): Promise<{ nodeId: string; graph: GraphPayload }> {
  return rpc<{ nodeId: string; graph: GraphPayload }>('graph.node.update', { deviceId, nodeId, patch });
}

export function graphNodeRemove(deviceId: string, nodeId: string): Promise<{ graph: GraphPayload }> {
  return rpc<{ graph: GraphPayload }>('graph.node.remove', { deviceId, nodeId });
}

export function graphEdgeAdd(
  deviceId: string,
  params: {
    from?: string | null;
    to?: string | null;
    when?: string;
    action?: Record<string, unknown>;
    condition?: Record<string, unknown>;
  },
): Promise<{ edgeId: string; graph: GraphPayload }> {
  return rpc<{ edgeId: string; graph: GraphPayload }>('graph.edge.add', { deviceId, ...params });
}

/** 模板截图（识别器录的是什么，界面要显示出来） */
export interface TemplateImage {
  readonly label: string;
  readonly mode: string;
  readonly width?: number;
  readonly height?: number;
  readonly png: string;
}

export function templateImage(label: string, grayscale = false): Promise<TemplateImage> {
  return rpc<TemplateImage>('template.image', { label, grayscale });
}

/** 脚本（工程）目录：当前在哪、有哪些、切换过去 */
export interface ProjectInfo {
  readonly root: string;
  readonly graphPath: string;
  readonly nodes: number;
  readonly edges: number;
  readonly recognizers: number;
  readonly templates: number;
}

export interface ProjectSummary {
  readonly name: string;
  readonly root: string;
  readonly nodes: number;
  readonly edges: number;
  readonly recognizers: number;
  readonly templates: number;
}

/** 库操作（新建/复制/重命名/删除）的统一返回：刷新后的整份列表 + 当前脚本 root。 */
export interface ScriptLibrary {
  readonly items: ProjectSummary[];
  readonly current: string;
}

export function projectGet(): Promise<ProjectInfo> {
  return rpc<ProjectInfo>('project.get', {});
}

export function projectSet(dir: string): Promise<ProjectInfo> {
  return rpc<ProjectInfo>('project.set', { dir });
}

/** 工作区 = 一个"库根"目录，里面每个子目录是一个任务（脚本） */
export interface WorkspaceSummary {
  readonly name: string;
  readonly root: string;
  readonly exists: boolean;
}

export function workspaceList(): Promise<{ items: WorkspaceSummary[] }> {
  return rpc<{ items: WorkspaceSummary[] }>('workspace.list', {});
}

/** 新建工作区（在仓库根 workspaces/<名字>/，不覆盖同名） */
export function workspaceCreate(name: string): Promise<{ items: WorkspaceSummary[] }> {
  return rpc<{ items: WorkspaceSummary[] }>('workspace.create', { name });
}

/** 三层目录树：项目 > 工作区 > 任务（任务 = 一张状态图） */
export interface TreeTask {
  readonly name: string;
  readonly root: string;
  readonly nodes: number;
  readonly edges: number;
  readonly recognizers: number;
}

export interface TreeWorkspace {
  readonly name: string;
  readonly root: string;
  readonly tasks: readonly TreeTask[];
}

export interface TreeProject {
  readonly name: string;
  readonly root: string;
  readonly workspaces: readonly TreeWorkspace[];
}

export function workspaceTree(): Promise<{ projects: TreeProject[] }> {
  return rpc<{ projects: TreeProject[] }>('workspace.tree', {});
}

export function projectList(base?: string): Promise<{ items: ProjectSummary[] }> {
  return rpc<{ items: ProjectSummary[] }>('project.list', base ? { base } : {});
}

/** 新建空脚本目录并切过去（多状态图 = 多个目录，见 docs/rpc.md「脚本库」）。 */
export function projectCreate(name: string, base?: string): Promise<ScriptLibrary> {
  return rpc<ScriptLibrary>('project.create', base ? { name, base } : { name });
}

/** 复制一个已有脚本（graph.json + templates/）到新名字，并切过去。 */
export function projectDuplicate(dir: string, name: string): Promise<ScriptLibrary> {
  return rpc<ScriptLibrary>('project.duplicate', { dir, name });
}

export function projectRename(dir: string, name: string): Promise<ScriptLibrary> {
  return rpc<ScriptLibrary>('project.rename', { dir, name });
}

/** 移到 <库根>/.trash/（可恢复，引擎不做真删除）。 */
export function projectDelete(dir: string): Promise<ScriptLibrary> {
  return rpc<ScriptLibrary>('project.delete', { dir });
}

export function graphSave(deviceId: string, graph: GraphPayload): Promise<GraphPayload> {
  return rpc<GraphPayload>('graph.save', { deviceId, graph });
}

export function recordTemplate(params: {
  deviceId: string;
  rect: readonly [number, number, number, number];
  label: string;
  threshold: number;
  nodeId?: string;
  nodeName?: string;
  asEnter?: boolean;
  asActionTarget?: boolean;
}): Promise<RecordResult> {
  return rpc<RecordResult>('record.template', { ...params });
}

export function setRecognizerThreshold(deviceId: string, label: string, threshold: number): Promise<void> {
  return rpc<void>('recognizer.threshold', { deviceId, label, threshold });
}

export function runStart(deviceId: string): Promise<{ running: boolean }> {
  return rpc<{ running: boolean }>('run.start', { deviceId });
}

export function runStop(deviceId: string): Promise<{ running: boolean }> {
  return rpc<{ running: boolean }>('run.stop', { deviceId });
}

export function timelineGet(deviceId: string, limit = 60): Promise<{ frames: unknown[]; events: unknown[] }> {
  return rpc<{ frames: unknown[]; events: unknown[] }>('timeline.get', { deviceId, limit });
}

/** 统一的引擎通知订阅：按 method 分发，返回取消订阅函数。 */
/**
 * 前端诊断日志 → 应用终端（`pnpm tauri dev` 的输出里带 `[ui]` 前缀）。
 *
 * 排查"引擎在推、界面没反应"这类问题时，这是唯一能从终端看到前端状态的手段。
 */
export function devLog(message: string): void {
  // 两条路：Tauri 应用日志（排查启动期问题）+ 界面日志抽屉（底部「日志」Tab 与引擎日志混排）
  pushUiLog('debug', 'ui', message);
  void invoke('dev_log', { message }).catch(() => undefined);
}

export async function onEngineMessage(
  handler: (method: string, params: Record<string, unknown>) => void,
): Promise<UnlistenFn> {
  return listen<{ method: string; params: Record<string, unknown> }>('engine://event', (event) => {
    handler(event.payload.method, event.payload.params);
  });
}
