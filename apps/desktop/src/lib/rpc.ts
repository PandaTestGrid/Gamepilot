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
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** 与 engine/src/gamepilot/protocol.py 的 PROTOCOL_VERSION 必须一致。 */
export const PROTOCOL_VERSION = 1;

export interface EngineNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** 发一个 JSON-RPC 请求并等待响应；错误由 Rust 侧转成 rejected promise。 */
export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>('engine_rpc', { method, params });
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

export interface GraphPayload {
  readonly version: number;
  readonly defaults: Record<string, unknown>;
  readonly recognizers: Record<string, Record<string, unknown>>;
  readonly nodes: ReadonlyArray<{ id: string; name?: string; enter?: string[]; timeout_ms?: number }>;
  readonly edges: ReadonlyArray<Record<string, unknown>>;
}

export interface ConnectResult {
  readonly deviceId: string;
  readonly resolution: readonly [number, number];
  /** scrcpy（H.264，流畅）| screencap（adb 截图，约 1.8fps） */
  readonly channel: string;
  readonly linkNote: string;
  readonly graph: GraphPayload;
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
  const data = await invoke<ArrayBuffer | Uint8Array | number[]>('engine_frame', { deviceId });
  if (data instanceof ArrayBuffer) {
    return data.byteLength > 0 ? data : null;
  }
  if (data instanceof Uint8Array) {
    return data.byteLength > 0 ? data.slice().buffer : null;
  }
  return null;
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
export async function onEngineMessage(
  handler: (method: string, params: Record<string, unknown>) => void,
): Promise<UnlistenFn> {
  return listen<{ method: string; params: Record<string, unknown> }>('engine://event', (event) => {
    handler(event.payload.method, event.payload.params);
  });
}
