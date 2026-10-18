export type DeviceKind = 'android' | 'ios' | 'emulator' | 'windows' | 'remote';

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
  /** 事件计划时刻 HH:mm（工作流节点，非界面 enter） */
  readonly at?: string;
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
  readonly type: 'click' | 'double_click' | 'long_press' | 'swipe' | 'wait' | 'key' | 'text' | 'set' | 'call';
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
  /** OCR 识别器要认的文字（type === 'ocr' 才有） */
  readonly text?: string;
  /** 录制时的帧像素尺寸（template 才有）：引擎按它和当前帧的比例自动缩放模板 */
  readonly recordedSize?: readonly [number, number];
  readonly score: number;
  readonly threshold: number;
  /** 归一化 ROI [x, y, w, h]；`search === 'full'` 时它只是录制时的原区域 */
  readonly roi: readonly [number, number, number, number];
  /** 搜索范围：region = 只在 roi 里找；full = 整帧找（目标可能出现在任意位置） */
  readonly search: 'region' | 'full';
  readonly samples: number;
  /** 已确认（投票通过）/ 待确认（单帧命中）/ 未命中 */
  readonly state: 'confirmed' | 'pending' | 'idle';
}

/** 工作流步骤链中的一步（`graph.json` → `flow.steps[]`，与引擎 flow_model 对齐） */
export interface FlowStep {
  readonly id: string;
  readonly type: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly disabled?: boolean;
}

export interface GraphData {
  readonly deviceId: string;
  readonly nodes: readonly GraphNodeView[];
  readonly edges: readonly GraphEdgeView[];
  readonly recognizers: readonly RecognizerView[];
  readonly variables: readonly GraphVariable[];
  readonly activeNodeId: string | null;
  readonly pendingNodeId: string | null;
  /** 有该字段 = 走步骤链编辑器（Automa 逻辑）；`steps` 可为空数组 */
  readonly flow?: { readonly steps: readonly FlowStep[] };
}

/**
 * `engine.event` 通知里的 `type`：与引擎的 `_emit(...)` 调用一一对应
 * （`engine/src/gamepilot/core/flow_engine.py` + `core/state_machine.py`），
 * 后半段是前端自己合成的事件（引擎不发，见 `stores/session.store.ts` 的 `append(...)`）。
 */
export type TraceEventType =
  // 老状态机（v3 图）
  | 'node_entered'
  | 'edge_matched'
  | 'edge_timeout'
  | 'recovery_matched'
  | 'recovery_done'
  | 'transition_failed'
  // 流程引擎（v4 步骤链）
  | 'flow_started'
  | 'flow_finished'
  | 'breakpoint_hit'
  | 'action_executed'
  | 'action_failed'
  | 'action_manual'
  | 'cond_true_done'
  | 'cond_false'
  | 'loop_break'
  | 'loop_repeat'
  | 'step_started'
  | 'step_finished'
  | 'step_skipped'
  | 'step_failed'
  | 'step_retry'
  | 'step_error_continue'
  | 'step_error_fallback'
  | 'step_error_insert'
  | 'subflow_waiting'
  | 'subflow_resumed'
  // 前端合成（引擎不发）
  | 'device_lost'
  | 'device_reconnected'
  | 'recognizer_added'
  | 'recognizer_renamed'
  | 'recognizer_removed'
  | 'error';

export interface TraceEventView {
  readonly seq: number;
  readonly ts: number;
  readonly type: TraceEventType;
  readonly deviceId: string;
  readonly node: string | null;
  readonly edge: string | null;
  readonly message: string;
  /** 引擎上报的调试字段（步骤序号 / 参数 / 耗时 / 识别分数…）；界面自己造的事件没有 */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** 录制中：一次框选/点选产生的待确认草稿（DESIGN.md §4.4） */
export interface RecordDraft {
  /**
   * 这一笔录制属于哪台设备（`beginDraft` 时按下哪一格就记哪一台）。
   *
   * 确认时按草稿里的 deviceId 落盘，避免多设备网格里 activeId 与录制设备不一致。
   */
  readonly deviceId?: string;
  /** 录制来源：框选（marquee）或点选（pick） */
  readonly mode?: 'marquee' | 'pick';
  /** 点选时的落点中心归一化坐标 [x, y]（调整点选范围时围绕该中心重算 rect） */
  readonly pickCenter?: readonly [number, number];
  /** 点选草稿对应的设备像素分辨率：用它把「点选 120px」换算成归一化 w/h（保持像素正方形） */
  readonly resolution?: readonly [number, number];
  /** 归一化选区 [x, y, w, h] */
  readonly rect: readonly [number, number, number, number];
  readonly label: string;
  readonly threshold: number;
  /** 当前帧该模板的匹配分数（阈值滑块要实时对照它） */
  readonly score: number;
  readonly asEnter: boolean;
  readonly asActionTarget: boolean;
  /** 搜索范围：默认 region（只认框选区域）；full = 目标可能出现在屏幕任意位置 */
  readonly search: 'region' | 'full';
  /**
   * 这类识别器怎么认：`template`（图像匹配，默认）/ `ocr`（框选区域里读文字）。
   * OCR 不需要模板图，但要填 `text`（要认的字）—— 见 `record.ocr`。
   */
  readonly kind?: 'template' | 'ocr';
  /** kind=ocr 时要识别的文字 */
  readonly text?: string;
  /** kind=ocr 的匹配方式：包含 / 完全相等（正则留给脚本手改） */
  readonly ocrMode?: 'contains' | 'equals';
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

/** 右栏 Tab（现仅工作区；`identifiers` 保留给类型兼容） */
export type RightTab = 'library' | 'identifiers';

/** 底部调试抽屉的 Tab：事件流 / 日志 / 控制台 / 时间轴 */
export type DockTab = 'events' | 'logs' | 'console' | 'timeline';
