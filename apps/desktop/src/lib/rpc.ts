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
