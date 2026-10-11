export type DeviceKind = 'android' | 'ios' | 'emulator' | 'windows' | 'mock' | 'remote';

export type DeviceStatus = 'idle' | 'discovered' | 'connecting' | 'connected' | 'failed';

export interface DeviceRuntime {
  readonly id: string;
  readonly name: string;
  readonly uri: string;
  readonly kind: DeviceKind;
  readonly status: DeviceStatus;
  /** 未连接或查询失败时为 null（真实设备要先连上才能读到分辨率） */
  readonly resolution: readonly [number, number] | null;
  readonly fps: number;
  readonly model?: string;
  readonly error?: string;
  readonly suggestedFix?: string;
  /** 是否已在多开网格 / 独立窗口中打开 */
  readonly windowed?: boolean;
}

export interface GraphNodeView {
  readonly id: string;
  readonly name: string;
  readonly enter: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly visits: number;
  readonly note?: string;
}

export type EdgeKind = 'normal' | 'recovery';

/** 判断条件（和引擎 core/conditions.py 一一对应） */
export interface EdgeCondition {
  readonly allOf: readonly string[];
  readonly anyOf: readonly string[];
  readonly noneOf: readonly string[];
  readonly minScore: number;
  /** 限时等待：进入源节点后最多等这么久，超时这条边就不走了 */
  readonly withinMs: number;
  /** 无条件：录出来的一步（进节点就做），不依赖任何识别器 */
  readonly always?: boolean;
}

/** 基础操作（和引擎 core/actions.py 一一对应） */
/** 变量（"黑板"）：动作参数可以写成 "$变量名" 引用它 */
export interface GraphVariable {
  readonly name: string;
  readonly type: 'number' | 'text' | 'key';
  readonly value: number | string | boolean;
  /** 运行时当前值（引擎回传，跑起来后会被"赋值"动作改） */
  readonly runtimeValue?: number | string | boolean;
}

/** 参数值：字面量，或 "$变量名" 形式的引用 */
export type ParamValue = number | string;

export interface EdgeAction {
  readonly type: 'click' | 'long_press' | 'swipe' | 'wait' | 'key' | 'text' | 'set' | 'call';
  readonly target?: string;
  readonly toTarget?: string;
  /** 数字或 "$变量名"（引用变量） */
  readonly x?: ParamValue;
  readonly y?: ParamValue;
  readonly toX?: ParamValue;
  readonly toY?: ParamValue;
  readonly durationMs?: ParamValue;
  readonly seconds?: ParamValue;
  readonly value?: string;
  /** 赋值动作（type=set）：把哪个变量设成什么 */
  readonly name?: string;
  /** 运行子脚本（type=call）：脚本名 */
  readonly script?: string;
  readonly assign?: string;
}

export interface GraphEdgeView {
  readonly id: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly when: string;
  readonly kind: EdgeKind;
  readonly priority: number;
  readonly minScore: number;
  readonly cooldownMs: number;
  readonly retries: number;
  /** 显示用的一行摘要，例如 "点击 start" */
  readonly action: string;
  readonly condition: EdgeCondition;
  readonly actionSpec: EdgeAction;
}

export type RecognizerType = 'template' | 'color' | 'ocr';

export interface RecognizerView {
  readonly label: string;
  readonly type: RecognizerType;
  /** 模板文件名（template 识别器才有），界面用它去取模板截图 */
  readonly template?: string;
  readonly score: number;
  readonly threshold: number;
  /** 归一化 ROI [x, y, w, h] */
  readonly roi: readonly [number, number, number, number];
  readonly samples: number;
  /** 已确认（投票通过）/ 待确认（单帧命中）/ 未命中 */
  readonly state: 'confirmed' | 'pending' | 'idle';
}

export interface GraphData {
  readonly deviceId: string;
  readonly nodes: readonly GraphNodeView[];
  readonly edges: readonly GraphEdgeView[];
  readonly recognizers: readonly RecognizerView[];
  readonly variables: readonly GraphVariable[];
  readonly activeNodeId: string | null;
  readonly pendingNodeId: string | null;
}

export type TraceEventType =
  | 'node_entered'
  | 'edge_matched'
  | 'action_executed'
  | 'recovery_matched'
  | 'recovery_done'
  | 'transition_failed'
  | 'device_lost'
  | 'device_reconnected'
  | 'device_scan'
  | 'recognizer_added'
  | 'recognizer_renamed'
  | 'recognizer_removed'
  | 'node_added'
  | 'edge_added'
  | 'error';

export interface TraceEventView {
  readonly seq: number;
  readonly ts: number;
  readonly type: TraceEventType;
  readonly deviceId: string;
  readonly node: string | null;
  readonly edge: string | null;
  readonly message: string;
}

/** 录制中：一次框选/点选产生的待确认草稿（DESIGN.md §4.4） */
export interface RecordDraft {
  /**
   * 这一笔录制属于哪台设备（`beginDraft` 时按下哪一格就记哪一台）。
   *
   * 为什么必须记：确认时如果现取 `activeId`，多开网格里"在 A 上框完、又点了 B 那格看
   * 一眼、再点确定"就会把 A 的选区写进 B 的状态图（真踩过）。草稿跟着设备走，
   * 界面切到哪台都不影响它落盘到哪张图。
   */
  readonly deviceId?: string;
  /** 归一化选区 [x, y, w, h] */
  readonly rect: readonly [number, number, number, number];
  readonly label: string;
  readonly threshold: number;
  /** 当前帧该模板的匹配分数（阈值滑块要实时对照它） */
  readonly score: number;
  readonly asEnter: boolean;
  readonly asActionTarget: boolean;
  readonly targetMode: 'existing' | 'new';
  readonly targetNodeId: string | null;
  readonly newNodeName: string;
  /**
   * 「新建界面」时界面侧给的一个**占位** id（`node_${序号}`），不是最终 id：
   * 序号每次开会话从 1 重数，落库时会撞上老界面，所以真实 id 由引擎分配
   * （`record.template` 的 `allocateNodeId`，见 stores/session.store.ts）。
   */
  readonly newNodeId: string;
}

export type RecordMode = 'off' | 'marquee' | 'pick';

/** 右栏 Tab：脚本库（多张状态图）/ 识别器（阈值现场调参） */
export type RightTab = 'library' | 'identifiers';

/** 底部调试抽屉的 Tab：事件流 / 日志 / 控制台 / 时间轴 */
export type DockTab = 'events' | 'logs' | 'console' | 'timeline';
