export type DeviceKind = 'android' | 'emulator' | 'windows' | 'mock' | 'remote';

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
  readonly action: string;
}

export type RecognizerType = 'template' | 'color' | 'ocr';

export interface RecognizerView {
  readonly label: string;
  readonly type: RecognizerType;
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
  readonly newNodeId: string;
}

export type RecordMode = 'off' | 'marquee' | 'pick';
