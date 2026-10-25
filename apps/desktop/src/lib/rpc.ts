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

import type { DeviceCapabilities, DeviceKind, TraceEventType } from '@/types';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { pushUiLog } from '@/lib/log-bus';

/** 与 engine/src/gamepilot/protocol.py 的 PROTOCOL_VERSION 必须一致。 */
export const PROTOCOL_VERSION = 2; // 2：删除不再走回收站（trashed → removed，去掉 trashRoot）

export interface EngineNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** 解析 JSON-RPC 错误信封，去掉异常类名前缀，供界面直接展示 message。 */
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
  const prefixMatch = /^(引擎返回错误:\s*)(.*)$/.exec(message);
  if (prefixMatch) {
    return `${prefixMatch[1]}${stripPythonPrefix(prefixMatch[2]!)}`.trim();
  }
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

/** 这台机器的运行环境快照（引擎 + adb 路径/版本、5037 占用、设备列表…）：跑不起来时先要它。 */
export function engineDiagnostics(): Promise<Record<string, unknown>> {
  return rpc<Record<string, unknown>>('engine.diagnostics', {});
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
  readonly capabilities?: DeviceCapabilities;
}

export interface DeviceScanError {
  readonly provider: string;
  readonly message: string;
}

export interface DeviceListResult {
  readonly devices: readonly DeviceInfoPayload[];
  readonly errors: readonly DeviceScanError[];
  /** 这些设备的首次多屏详情尚未就绪，不能把附屏缺席当作已关闭。 */
  readonly pendingAndroidSerials?: readonly string[];
}

/** `device.list.changed`：设备上下线、授权状态或后台详情变化，重新读取列表。 */
export interface DeviceListChangedPayload {
  readonly provider: 'android' | 'ios' | 'macos' | 'windows';
}

/** 扫描可用设备（adb 真机/模拟器 + iOS + Windows/macOS 本机窗口）。scan=false 时不扫描，直接返回空列表。 */
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
  readonly nodes: ReadonlyArray<{
    id: string;
    name?: string;
    /** 引擎里的节点备注（`graph.json` 的 `note`）；和限时等待的 `timeout_ms` 不是一回事 */
    note?: string;
    enter?: string[];
    timeout_ms?: number;
    at?: string;
  }>;
  readonly edges: ReadonlyArray<Record<string, unknown>>;
  /** 变量（"黑板"）：动作参数可以引用它们 */
  readonly variables?: Record<string, { type?: string; value?: number | string | boolean }>;
  /** 步骤链（Automa 式）：第一步必须是触发器，顺序即执行顺序 */
  readonly flow?: {
    readonly steps: ReadonlyArray<Record<string, unknown>>;
  };
}

export interface ConnectResult {
  readonly deviceId: string;
  readonly resolution: readonly [number, number];
  /** Android：scrcpy（H.264）| dvt（iOS）| quartz（macOS 窗口） */
  readonly channel: string;
  readonly linkNote: string;
  readonly graph: GraphPayload;
  /** 人类可读的名字（iOS 型号 / macOS 窗口标题）；界面用它显示设备条目 */
  readonly name?: string;
  /** 设备类型（ios / windows / …），界面用来选对图标与文案 */
  readonly kind?: DeviceKind;
  readonly capabilities?: DeviceCapabilities;
}

export interface RecordResult {
  readonly label: string;
  readonly mode: 'template' | 'color' | 'ocr';
  /** 实际生效的搜索范围（纯色区域降级成颜色识别器时永远是 region） */
  readonly search: 'region' | 'full';
  readonly template: string;
  readonly rect: readonly [number, number, number, number];
  /** 这次模板挂在哪个界面上：`allocateNodeId` 时是**引擎分配**的 id，不一定是传下去的那个 */
  readonly nodeId?: string | null;
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
  readonly activeStepIds?: readonly string[];
  readonly tick: number;
  readonly fps: number;
  readonly captureMs: number;
  /** 权威运行快照；旧引擎没有这些字段，不能把缺省当成停止。 */
  readonly workflowRoot?: string;
  readonly running?: boolean;
  readonly runningWorkflowRoots?: readonly string[];
  readonly runRevision?: number;
  readonly detections: ReadonlyArray<{
    label: string;
    rect: readonly [number, number, number, number];
    score: number;
    source: string;
    state: 'confirmed' | 'pending' | 'idle';
    /** 有多个同分且位置不同的候选（全屏搜索）：界面提示；步骤可配「多目标」策略 */
    ambiguous?: boolean;
    /** 同一识别器的全部不同命中（只有一个命中时引擎不发这个字段） */
    candidates?: ReadonlyArray<readonly [number, number, number, number]>;
  }>;
  /** 只有老引擎会塞在事件里；新引擎的帧走 `fetchFrame`（原始字节） */
  readonly jpeg?: string;
}

/** 引擎推送的状态机事件（engine.event 通知）。 */
export interface EngineEventPayload {
  readonly deviceId: string;
  readonly seq: number;
  readonly ts: number;
  readonly type: TraceEventType;
  readonly node: string | null;
  readonly edge: string | null;
  readonly message: string;
  readonly extra?: {
    readonly loops?: ReadonlyArray<{
      readonly stepId: string;
      readonly current: number;
      readonly total: number;
    }>;
    /** 其余是引擎上报的调试字段：index / kind / params / durationMs / score / matchedRect / retry … */
    readonly [key: string]: unknown;
  };
  /** 这份事件属于哪条工作流（多 Tab 同时跑时用来过滤高亮） */
  readonly workflowRoot?: string;
}

export interface DeviceNotificationPayload {
  readonly deviceId: string;
  readonly uri?: string;
  readonly name?: string;
  readonly kind?: DeviceKind;
  readonly capabilities?: DeviceCapabilities;
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
 * 帧走按需拉取；事件只带元数据，避免大体积 base64 挤满 IPC。
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
  return rpc('device.touch', { deviceId, phase, x, y });
}

/** 手动控制：归一化坐标轻触 */
export function deviceTap(deviceId: string, x: number, y: number): Promise<unknown> {
  return rpc('device.tap', { deviceId, x, y });
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
  return rpc('device.swipe', { deviceId, x1, y1, x2, y2, durationMs });
}

/** 手动控制：功能键（back / home / recents / power / volume_up / volume_down） */
export function deviceKey(deviceId: string, key: string): Promise<unknown> {
  return rpc('device.key', { deviceId, key });
}

export function setStreamFps(deviceId: string, fps: number): Promise<unknown> {
  return rpc('device.stream', { deviceId, fps });
}

export function connectDevice(uri: string): Promise<ConnectResult> {
  return rpc<ConnectResult>('device.connect', { uri });
}

export async function disconnectDevice(deviceId: string): Promise<void> {
  await rpc('device.disconnect', { deviceId });
}

/**
 * 读当前脚本的图。
 *
 * `deviceId` **可选**：传了 = 那台设备会话里的那份（带它的运行态）；
 * 不传 = 直接读项目里的 `graph.json` —— 没连设备也能看脚本
 * （状态图属于项目，设备只是"在哪台机器上跑"）。
 */
export function graphGet(deviceId?: string): Promise<GraphPayload> {
  return rpc<GraphPayload>('graph.get', deviceId ? { deviceId } : {});
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

/** 单步：执行完当前这一步，进入下一步之前再暂停 */
export function runStep(deviceId: string): Promise<{ ok: boolean; paused: boolean }> {
  return rpc<{ ok: boolean; paused: boolean }>('run.step', { deviceId });
}

/** 调试：只执行一个动作（"单独跑这一步"），不影响状态机位置 */
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

/**
 * `window.list` 返回的一个本机窗口（跨平台统一模型）。
 *
 * Windows 的 `handle` 就是 `EnumWindows` 给的 `HWND`，macOS 的 `handle` 是
 * `kCGWindowNumber`。每项都带 `uri` / `deviceId`：界面点一行直接
 * `device.connect { uri }`，不需要自己拼。
 */
export interface WindowInfo {
  readonly handle: number;
  /** Windows 的 HWND；macOS 没有这个字段 */
  readonly hwnd?: number;
  readonly pid: number;
  /** Windows 进程名（`Game.exe`）；macOS 没有这个字段 */
  readonly process?: string;
  readonly app: string;
  readonly title: string;
  /** Windows 窗口类名（`UnityWndClass` / `UnrealWindow`） */
  readonly class?: string;
  readonly className?: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly clientWidth?: number;
  readonly clientHeight?: number;
  /** 最小化窗口可能抓到黑屏 */
  readonly minimized?: boolean;
  /** 目标可能以管理员权限运行（普通权限的输入会被 UIPI 拦下） */
  readonly protected?: boolean;
  /** 直接可连的 URI（`Windows:///?hwnd=<十进制>` / `Mac:///?window=<句柄>`） */
  readonly uri: string;
  /** 已连接集合用的设备 id（`windows:6698742` / `macos:89`） */
  readonly deviceId: string;
}

export interface WindowListResult {
  /** `win32` / `darwin` / 其它（非 Windows/macOS 平台） */
  readonly platform: string;
  readonly allowed: boolean;
  readonly note: string;
  readonly windows: readonly WindowInfo[];
}

/**
 * 本机窗口列表（Windows / macOS 统一入口，界面「本机窗口」Tab 用它）。
 *
 * `includeOwn` 默认 false：不列 GamePilot 自己的窗口，避免用户把自己的画面接成设备。
 */
export function windowList(includeOwn = false): Promise<WindowListResult> {
  return rpc<WindowListResult>('window.list', { includeOwn });
}

/** 把一步手动操作录成脚本里的一条边（画面栏开着「录操作」时调） */
export function recordAction(
  deviceId: string,
  action: Record<string, unknown>,
  to?: string,
): Promise<{ edgeId: string; stepId?: string; graph: GraphPayload }> {
  return rpc<{ edgeId: string; stepId?: string; graph: GraphPayload }>('record.action', {
    deviceId,
    action,
    to,
  });
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

/** 当前工作流：在哪、图里有什么（`project.get` / `project.set` 的返回，语义不变）。 */
export interface ProjectInfo {
  readonly root: string;
  readonly graphPath: string;
  readonly nodes: number;
  readonly edges: number;
  readonly recognizers: number;
  readonly templates: number;
}

/* ------------------------------------------------------------------ *
 * 工作区（= 项目，同一个东西）› 工作流（契约：docs/WORKSPACE-CONTRACT.md **v4**）
 *
 * 层级只有两层（v4 §0）：
 *   工作区 = 用户选的一个文件夹（可以有多个，列表按最近使用排序）
 *   └── 工作流 = 一张流程图 = `graph.json` + `templates/`（可以有多个）
 *
 * 「项目」那一层已经取消：项目层的四个写方法（list/create/rename/delete）全部下线，
 * 只剩 `project.get` / `project.set`（当前工作流的读取/切换）。
 * 「脚本」也不当层级名，统一叫**工作流**（内部类型名 `Workflow*`）。
 * ------------------------------------------------------------------ */

/** 工作区列表里的一项：`name` = 用户起的名字（默认是目录名），`exists` = 目录还在不在。 */
export interface WorkspaceSummary {
  readonly name: string;
  readonly root: string;
  readonly active: boolean;
  readonly exists: boolean;
}

/** 工作流第一步的触发条件（调用节点用它显示“目标工作流什么时候触发”）。 */
export interface WorkflowTrigger {
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** 工作流摘要（树、面板、「跳到工作流」都用它）。 */
export interface WorkflowSummary {
  readonly name: string;
  readonly root: string;
  readonly nodes: number;
  readonly edges: number;
  readonly recognizers: number;
  readonly templates: number;
  /** 最新一次改动时间（epoch 秒，0 = 不知道）—— 面板里显示「10 分钟」用它 */
  readonly modified: number;
  /** 第一步的触发条件；老引擎没有这个字段，读不回来的图是 null。 */
  readonly trigger?: WorkflowTrigger | null;
  /**
   * 这份工作流的 graph.json 读不回来时的原因（有值 = 计数都是 0）。
   * 引擎不会因为一份坏图就不给列表了，界面要把它标出来，别静默当空图。
   */
  readonly error?: string;
}

/** 整棵树：工作区根（标题行显示它的 basename）+ 这个工作区里的所有工作流。 */
export interface WorkspaceTreePayload {
  readonly root: string;
  readonly workflows: readonly WorkflowSummary[];
}

/** 工作流写操作（workflow.*）的统一返回：刷新后的工作流列表 + 当前工作流 root。 */
export interface WorkflowLibrary {
  readonly items: WorkflowSummary[];
  readonly current: string;
}

export function projectGet(): Promise<ProjectInfo> {
  return rpc<ProjectInfo>('project.get', {});
}

export function projectSet(dir: string, create = false): Promise<ProjectInfo> {
  return rpc<ProjectInfo>('project.set', { dir, create });
}

/* ---------------------- 工作区层：workspace.* ---------------------- */

/** `workspace.list`：当前工作区 + 最近使用过的列表 + 系统推荐目录。 */
export interface WorkspaceListResult {
  /** 当前工作区 root；`null` = 还没选过任何一个 */
  readonly active: string | null;
  /** 系统推荐目录（面板底部「默认工作区」用它） */
  readonly recommended: string;
  readonly items: readonly WorkspaceSummary[];
}

/** 前端只靠这一个方法就能画出整棵树（`workflows[]` 就是每一行要的数）。 */
export function workspaceTree(): Promise<WorkspaceTreePayload> {
  return rpc<WorkspaceTreePayload>('workspace.tree', {});
}

/** 最近用过的工作区列表（面板那个浮层用它；树用 `workspace.tree`）。 */
export function workspaceList(): Promise<WorkspaceListResult> {
  return rpc<WorkspaceListResult>('workspace.list', {});
}

/** 工作区写操作（add/remove）的统一返回：列表 + 当前工作区的整棵树 + 当前工作流 root。 */
export interface WorkspaceMutation {
  readonly items: readonly WorkspaceSummary[];
  readonly tree: WorkspaceTreePayload;
  readonly current: string;
}

export interface WorkspaceAdded extends WorkspaceMutation {
  readonly root: string;
  /** 登记后列表里显示的名字（用户输的，或退回的目录名） */
  readonly name: string;
}

export interface WorkspaceRemoved extends WorkspaceMutation {
  /** 移掉的是当前工作区时这里是新的当前工作区；列表空了就是 null */
  readonly active: string | null;
  /** 真删的情况下 = 被删掉的目录路径（`deleteFiles:false` 时为空串） */
  readonly removed: string;
}

/**
 * 登记一个工作区并切过去。
 *
 * - `name`：用户输的名字（界面第二步输的，默认预填目录名）；省略/空白 → 引擎退回 `basename(dir)`。
 * - `create` 默认 true（目录不存在就建）；false 且不存在 → 引擎报「工作区目录不存在」。
 * - 同一个 `dir` 再加一次是**幂等**的：提到最前、设为当前，**名字更新成这次传的**。
 * - **不建任何目录内容**（v4 §2.1：空文件夹保持空着，连一个默认子目录都不建）。
 */
export function workspaceAdd(dir: string, name?: string, create = true): Promise<WorkspaceAdded> {
  return rpc<WorkspaceAdded>('workspace.add', {
    dir,
    ...(name && name.trim() ? { name: name.trim() } : {}),
    create,
  });
}

/**
 * 移除一个工作区。
 *
 * `deleteFiles: true`（默认）= 把整个目录**真删除**（`shutil.rmtree`，不可恢复，
 * 所以界面必须先二次确认）；`deleteFiles: false` = 只从列表移除，磁盘一个字节不动。
 */
export function workspaceRemove(dir: string, deleteFiles: boolean): Promise<WorkspaceRemoved> {
  return rpc<WorkspaceRemoved>('workspace.remove', { dir, deleteFiles });
}

/* ---------------------- 工作流层：workflow.* ---------------------- */

/**
 * 新建工作流并切过去。**`name` 必填**（v4 §2.2）：界面会弹输入框，省略时引擎报「缺少参数 name」。
 * 建在**当前工作区根**下；没有当前工作区 → 引擎报「请先选择工作区」。
 */
/** 新建工作流并切过去（`name` 必填：界面弹输入框让你起名，引擎不会替你起） */
export function workflowCreate(name: string): Promise<WorkflowLibrary & { created: string }> {
  return rpc<WorkflowLibrary & { created: string }>('workflow.create', { name });
}

export function workflowRename(dir: string, name: string): Promise<WorkflowLibrary & { root: string }> {
  return rpc<WorkflowLibrary & { root: string }>('workflow.rename', { dir, name });
}

/** 复制一个已有工作流（graph.json + templates/）到新名字并切过去；`name` 省略 = 引擎自动「<原名>-副本」。 */
export function workflowDuplicate(
  dir: string,
  name?: string,
): Promise<WorkflowLibrary & { created: string }> {
  return rpc<WorkflowLibrary & { created: string }>('workflow.duplicate', {
    dir,
    ...(name && name.trim() ? { name: name.trim() } : {}),
  });
}

/** **真删除**一个工作流目录（不可恢复：界面必须先二次确认）。 */
export function workflowDelete(dir: string): Promise<WorkflowLibrary & { removed: string }> {
  return rpc<WorkflowLibrary & { removed: string }>('workflow.delete', { dir });
}

/** 保存当前脚本的图；不带 deviceId = 直接落项目里的 `graph.json`（引擎会让所有会话热重载）。 */
export function graphSave(graph: GraphPayload, deviceId?: string): Promise<GraphPayload> {
  return rpc<GraphPayload>('graph.save', deviceId ? { deviceId, graph } : { graph });
}

export function recordTemplate(params: {
  deviceId: string;
  rect: readonly [number, number, number, number];
  label: string;
  threshold: number;
  nodeId?: string;
  nodeName?: string;
  /** 「录一个新界面」→ 让引擎分配 id：界面上的 `node_N` 是本地序号，重启会重号（会撞上老界面） */
  allocateNodeId?: boolean;
  asEnter?: boolean;
  asActionTarget?: boolean;
  /** 搜索范围：region（默认，只在框选区域找）/ full（整帧找，目标位置不固定时用） */
  search?: 'region' | 'full';
}): Promise<RecordResult> {
  return rpc<RecordResult>('record.template', { ...params });
}

/** 框一块区域 + 填要认的字 → 注册 OCR 识别器（不需要模板图，但会留一张截图做证据）。 */
export function recordOcr(params: {
  deviceId: string;
  rect: readonly [number, number, number, number];
  label: string;
  text: string;
  mode?: 'contains' | 'equals';
  threshold?: number;
  nodeId?: string;
  nodeName?: string;
  allocateNodeId?: boolean;
  asEnter?: boolean;
  asActionTarget?: boolean;
  search?: 'region' | 'full';
}): Promise<RecordResult> {
  return rpc<RecordResult>('record.ocr', { ...params });
}

/** 读取 AI 识别器的参数与示例（素材区编辑用）。 */
export interface YoloExamplePayload {
  readonly rect: readonly [number, number, number, number];
  readonly label: string;
  readonly image: string;
  readonly width: number;
  readonly height: number;
}

export interface YoloRecognizerDetail {
  readonly label: string;
  readonly threshold: number;
  readonly search: 'region' | 'full';
  readonly roi?: readonly [number, number, number, number] | null;
  readonly imgsz: number;
  readonly tile: boolean;
  readonly tileSize: number;
  readonly tileOverlap: number;
  readonly examples: YoloExamplePayload[];
}

export function recognizerDetail(deviceId: string, label: string): Promise<YoloRecognizerDetail> {
  return rpc<YoloRecognizerDetail>('recognizer.detail', { deviceId, label });
}

/** 更新已有 AI 识别器，可同时原子改名。 */
export function updateYoloRecognizer(
  deviceId: string,
  label: string,
  spec: Readonly<Record<string, unknown>>,
  newLabel?: string,
): Promise<{ label: string; graph: GraphPayload }> {
  return rpc<{ label: string; graph: GraphPayload }>('recognizer.update', {
    deviceId,
    label,
    spec,
    ...(newLabel !== undefined ? { newLabel } : {}),
  });
}

/** 给已有 AI 识别器追加一个示例框（参考帧 = 当前画面）。 */
export function addYoloExample(
  deviceId: string,
  label: string,
  rect: readonly [number, number, number, number],
): Promise<{ label: string; examples: number; graph: GraphPayload }> {
  return rpc<{ label: string; examples: number; graph: GraphPayload }>('recognizer.example', {
    deviceId,
    label,
    rect,
  });
}

/** 最近的帧（AI 标注弹窗前后翻帧挑参考）。 */
/** 帧缓冲元信息（引擎最多保留 1000 帧，前端按帧号懒加载）。 */
export interface FrameMetaPayload {
  readonly count: number;
  readonly firstIndex: number;
  readonly lastIndex: number;
  readonly width: number;
  readonly height: number;
  /** 真实帧号列表（可能跳号），进度条位置按它映射 */
  readonly indices: number[];
}

export function frameMeta(deviceId: string): Promise<FrameMetaPayload> {
  return rpc<FrameMetaPayload>('recognizer.frames.meta', { deviceId });
}

/** 按帧序号取单帧（回放/拖进度条用）。 */
export interface FrameAtPayload {
  readonly index: number;
  /** 调用方请求的帧号（nearest=true 且请求帧已被滚出缓冲时，index 会和它不同） */
  readonly requestedIndex?: number;
  readonly jpeg: string;
  readonly width: number;
  readonly height: number;
  readonly ts: number;
}

/**
 * 按帧序号取单帧。
 *
 * `nearest`：请求的帧已经被环形缓冲挤掉时，返回**帧号最接近**的一帧而不是报错。
 * 回放/预取都该传 true —— 画面帧一直在滚，严格匹配必然会随机失败。
 */
export function frameAt(
  deviceId: string,
  index: number,
  options: { nearest?: boolean } = {},
): Promise<FrameAtPayload> {
  return rpc<FrameAtPayload>('recognizer.frame', {
    deviceId,
    index,
    ...(options.nearest ? { nearest: true } : {}),
  });
}

export interface RecordingMetaPayload {
  readonly recordingId: string;
  readonly active: boolean;
  readonly count: number;
  readonly firstIndex: number;
  readonly lastIndex: number;
  readonly indices?: number[];
  readonly nextAfterIndex?: number | null;
  readonly hasMore?: boolean;
}

export function recordingStart(deviceId: string): Promise<RecordingMetaPayload> {
  return rpc<RecordingMetaPayload>('recording.start', { deviceId });
}

export function recordingStop(deviceId: string, recordingId: string): Promise<RecordingMetaPayload> {
  return rpc<RecordingMetaPayload>('recording.stop', { deviceId, recordingId });
}

export function recordingMeta(
  deviceId: string,
  recordingId: string,
  afterIndex?: number,
): Promise<RecordingMetaPayload> {
  return rpc<RecordingMetaPayload>('recording.meta', {
    deviceId,
    recordingId,
    limit: 500,
    ...(afterIndex === undefined ? {} : { afterIndex }),
  });
}

export function recordingFrameAt(
  deviceId: string,
  recordingId: string,
  index: number,
): Promise<FrameAtPayload> {
  return rpc<FrameAtPayload>('recording.frameAt', { deviceId, recordingId, index });
}

export function recordingDelete(deviceId: string, recordingId: string): Promise<{ ok: boolean }> {
  return rpc<{ ok: boolean }>('recording.delete', { deviceId, recordingId });
}

export interface FrameHistoryItem {
  readonly index: number;
  readonly jpeg: string;
  readonly width: number;
  readonly height: number;
  readonly ts: number;
}

export function frameHistory(deviceId: string, count = 20): Promise<{ frames: FrameHistoryItem[] }> {
  return rpc<{ frames: FrameHistoryItem[] }>('recognizer.frames', { deviceId, count });
}

/** 组件/开发态模型目录里的 .pt 列表。 */
export interface YoloModelsPayload {
  readonly models: readonly string[];
  readonly model: string;
  readonly dir: string;
  /** worker 上报的推理设备：cuda / cpu / 空（未启动） */
  readonly device?: string;
}

export function yoloModels(): Promise<YoloModelsPayload> {
  return rpc<YoloModelsPayload>('yolo.models');
}

/** 切换默认权重（会重启 worker，下次推理时加载）。 */
export function yoloSetModel(
  model: string,
): Promise<YoloModelsPayload & { reloading: boolean; workerReady: boolean }> {
  return rpc('yolo.model.set', { model });
}

/** 把本机 .pt 复制进模型目录（不传大文件，只传路径）。 */
export function yoloAddModel(path: string): Promise<{ added: string[]; models: string[] }> {
  return rpc<{ added: string[]; models: string[] }>('yolo.model.add', { path });
}

/** 弹窗「实时检测」预览：用示例框 + 调参在当前画面上跑一次。 */
export interface YoloPreviewDet {
  readonly class: string;
  readonly conf: number;
  readonly bbox: readonly [number, number, number, number];
}

export interface YoloPreviewPayload {
  readonly previewId: string;
  readonly examples: ReadonlyArray<{
    readonly rect: readonly [number, number, number, number];
    readonly label: string;
    /** 示例自己的冻结帧（data URL）；只在参数/示例变化时带一次 */
    readonly image?: string;
  }>;
  readonly conf: number;
  readonly iou: number;
  readonly imgsz: number;
  readonly tile: boolean;
  readonly tileSize: number;
  readonly tileOverlap?: number;
  readonly roi?: readonly [number, number, number, number] | null;
  /** true（默认）= 同一 previewId 只取一次帧，标注/检测期间画面不动 */
  readonly freeze?: boolean;
}

export function previewYolo(
  deviceId: string,
  payload: YoloPreviewPayload,
): Promise<{
  dets: YoloPreviewDet[];
  ms: number;
  inferMs: number;
  queueMs: number;
  /** worker 的推理设备：cuda / cpu（界面用来提示快慢） */
  device: string;
  width: number;
  height: number;
}> {
  return rpc('recognizer.preview', { deviceId, ...payload });
}

/** 不录模板，直接注册一个识别器（AI 识别器用）。 */
export function createRecognizer(
  deviceId: string,
  label: string,
  spec: Readonly<Record<string, unknown>>,
): Promise<{ label: string; graph: GraphPayload }> {
  return rpc<{ label: string; graph: GraphPayload }>('recognizer.create', { deviceId, label, spec });
}

// --------------------------------------------------------------------------
// AI（YOLO）识别组件：可选下载的独立 worker（torch + 模型），装到用户目录
// --------------------------------------------------------------------------

export interface YoloComponentStatus {
  readonly installed: boolean;
  readonly version: string | null;
  readonly path: string;
  readonly sizeMb: number;
  readonly manifest: Readonly<Record<string, unknown>>;
}

export interface YoloStatusPayload {
  readonly component: YoloComponentStatus;
  readonly runtime: Readonly<Record<string, unknown>>;
}

export interface YoloProgressPayload {
  readonly state: 'downloading' | 'extracting' | 'verifying' | 'done' | 'error';
  readonly progress?: number;
  readonly stage?: string;
  readonly error?: string;
  readonly status?: YoloComponentStatus;
}

/** 组件与 worker 状态（未安装时 component.installed=false）。 */
/** 后台预热 worker（加载模型，不跑推理）；返回同 status。 */
export function yoloWarmup(): Promise<YoloStatusPayload> {
  return rpc<YoloStatusPayload>('yolo.warmup', {});
}

export function yoloStatus(): Promise<YoloStatusPayload> {
  return rpc<YoloStatusPayload>('yolo.status');
}

/** 安装组件：source 省略时由引擎读 GAMEPILOT_YOLO_COMPONENT_URL；进度走 `yolo.progress`。 */
export function yoloInstall(source?: string): Promise<{ accepted: boolean }> {
  return rpc<{ accepted: boolean }>('yolo.install', source ? { source } : {});
}

export function yoloRemove(): Promise<YoloComponentStatus> {
  return rpc<YoloComponentStatus>('yolo.remove');
}

export function setRecognizerEnabled(
  deviceId: string | undefined,
  label: string,
  enabled: boolean,
  workflowRoot?: string,
): Promise<{ label: string; enabled: boolean; graph?: GraphPayload }> {
  return rpc('recognizer.enabled', {
    ...(deviceId ? { deviceId } : {}),
    label,
    enabled,
    ...(workflowRoot ? { workflowRoot } : {}),
  });
}

export function setRecognizerThreshold(deviceId: string, label: string, threshold: number): Promise<void> {
  return rpc<void>('recognizer.threshold', { deviceId, label, threshold });
}

export function setRecognizerSearch(
  deviceId: string,
  label: string,
  search: 'region' | 'full',
): Promise<{ label: string; search: 'region' | 'full' }> {
  return rpc<{ label: string; search: 'region' | 'full' }>('recognizer.search', {
    deviceId,
    label,
    search,
  });
}

export function runStart(
  deviceId: string,
  stepId?: string,
  workflowRoot?: string,
): Promise<{ running: boolean }> {
  return rpc<{ running: boolean }>('run.start', {
    deviceId,
    ...(stepId ? { stepId } : {}),
    ...(workflowRoot ? { workflowRoot } : {}),
  });
}

export interface RunStatusPayload {
  readonly deviceId: string;
  readonly running: boolean;
  readonly runningWorkflowRoots: readonly string[];
  readonly runRevision?: number;
}

export function subscribeEngineEvents(): Promise<{ ok: boolean }> {
  return rpc<{ ok: boolean }>('engine.events.subscribe', {});
}

export function runStatus(deviceId: string): Promise<RunStatusPayload> {
  return rpc<RunStatusPayload>('run.status', { deviceId });
}

export function runStop(deviceId: string, workflowRoot?: string): Promise<{ running: boolean }> {
  return rpc<{ running: boolean }>('run.stop', {
    deviceId,
    ...(workflowRoot ? { workflowRoot } : {}),
  });
}

export function timelineGet<T = { frames: unknown[]; events: unknown[]; evidence: RunEvidenceBundle | null }>(
  deviceId: string,
  limit = 60,
): Promise<T> {
  return rpc<T>('timeline.get', { deviceId, limit });
}

/** 一次运行里的一步：截图文件名 + 当时的参数（排查"它看到了什么"） */
export interface RunEvidenceStep {
  readonly index: number;
  readonly stepId: string;
  readonly kind: string;
  readonly ts: number;
  /** 截图文件名（相对证据目录）；没有图时是空串 */
  readonly screenshot: string;
  /** 失败原因 / 这一步的说明 */
  readonly message: string;
  /** 这一步的实际入参（变量已求值） */
  readonly params?: Record<string, unknown> | null;
  /** 动作执行结果的描述（如「点击 · 0.50, 0.50」） */
  readonly result?: string;
  /** 按识别器定位的动作：当帧识别分数 */
  readonly score?: number | null;
  /** 按识别器定位的动作：命中框（归一化 x/y/w/h） */
  readonly matchedRect?: readonly number[] | null;
  readonly durationMs?: number | null;
}

export interface RunEvidenceBundle {
  /** 相对工作流根目录：`.runs/20261018-201233` */
  readonly dir: string;
  readonly steps: readonly RunEvidenceStep[];
}

/** 最近一次运行的证据（跑完才有；没跑过 / 关掉了证据 → null） */
export function runEvidence(
  deviceId: string,
  workflowRoot?: string,
): Promise<{ evidence: RunEvidenceBundle | null }> {
  return rpc<{ evidence: RunEvidenceBundle | null }>('run.evidence', { deviceId, workflowRoot });
}

/** 按文件名取一张证据截图（base64 JPEG） */
export function evidenceImage(
  deviceId: string,
  name: string,
  workflowRoot?: string,
): Promise<{ jpeg: string }> {
  return rpc<{ jpeg: string }>('evidence.image', { deviceId, name, workflowRoot });
}

export interface OcrStatusPayload {
  readonly modelId: string;
  readonly modelName: string;
  readonly sizeMb: number;
  readonly state: 'not_downloaded' | 'downloading' | 'downloaded' | 'ready' | 'error';
  readonly downloaded: boolean;
  readonly loaded: boolean;
  readonly progress: number;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly stage: string;
  readonly error: string | null;
}

export interface OcrBoxItem {
  readonly text: string;
  readonly score: number;
  readonly rect: readonly [number, number, number, number];
}

export interface OcrRecognizeResult {
  readonly text: string;
  readonly score: number;
  readonly items: readonly OcrBoxItem[];
  readonly cancelled?: boolean;
  readonly error?: string;
  readonly deviceId?: string;
}

export interface OcrRecognizeAccepted {
  readonly accepted: boolean;
  readonly reason?: string;
}

export function ocrStatus(): Promise<OcrStatusPayload> {
  return rpc<OcrStatusPayload>('ocr.status');
}

export function ocrLoad(): Promise<OcrStatusPayload> {
  return rpc<OcrStatusPayload>('ocr.load');
}

export function ocrRecognize(
  deviceId: string,
  rect?: readonly [number, number, number, number],
): Promise<OcrRecognizeAccepted> {
  return rpc<OcrRecognizeAccepted>('ocr.recognize', rect ? { deviceId, rect } : { deviceId });
}

export function ocrCancel(): Promise<{ readonly cancelled: boolean }> {
  return rpc<{ cancelled: boolean }>('ocr.cancel');
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
