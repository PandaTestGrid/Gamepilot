/**
 * 引擎状态图（graph.json 的 JSON 形态）→ 界面模型（GraphData）。
 *
 * 两边的差异只在两点，转换必须保持"引擎是唯一真源"：
 *   1. 引擎不存节点坐标（那是 UI 私有数据）→ 这里按网格自动布局；
 *   2. 引擎的边是扁平 dict → 这里收敛成强类型 GraphEdgeView。
 */
import type { GraphPayload } from '@/lib/rpc';
import type {
  EdgeAction,
  FlowStep,
  GraphVariable,
  EdgeCondition,
  EdgeKind,
  GraphData,
  GraphEdgeView,
  GraphNodeView,
  ParamValue,
  RecognizerView,
} from '@/types';

const COLUMNS = 3;

function layout(index: number): { x: number; y: number } {
  return { x: 60 + (index % COLUMNS) * 200, y: 40 + Math.floor(index / COLUMNS) * 150 };
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function toGraphData(
  deviceId: string,
  payload: GraphPayload,
  live?: {
    node?: string | null;
    pending?: string | null;
    detections?: ReadonlyArray<{ label: string; score: number; state: string }>;
  },
): GraphData {
  const nodes: GraphNodeView[] = (payload.nodes ?? []).map((node, index) => ({
    id: node.id,
    name: node.name ?? node.id,
    enter: node.enter ?? [],
    at: typeof node.at === 'string' && node.at ? node.at : undefined,
    ...layout(index),
    visits: 0,
    // `note` 是引擎里的真实备注字段；`timeout_ms` 是限时等待的阈值，不能顶替它
    note: typeof node.note === 'string' && node.note ? node.note : undefined,
  }));

  const edges: GraphEdgeView[] = (payload.edges ?? []).map((edge) => ({
    id: str(edge.id),
    from: typeof edge.from === 'string' ? edge.from : null,
    to: typeof edge.to === 'string' ? edge.to : null,
    when: str(edge.when),
    kind:
      str(edge.kind, 'normal') === 'recovery'
        ? ('recovery' satisfies EdgeKind)
        : ('normal' satisfies EdgeKind),
    priority: num(edge.priority, 0),
    minScore: num(edge.min_score, 0),
    cooldownMs: num(edge.cooldown_ms, 0),
    retries: num(edge.retries, 1),
    action: str((edge.action as Record<string, unknown> | undefined)?.type, 'click'),
    condition: toCondition(edge),
    actionSpec: toAction(edge.action, str(edge.when)),
  }));

  const liveScores = new Map((live?.detections ?? []).map((item) => [item.label, item] as const));
  const runtime =
    (live as { variables?: Record<string, number | string | boolean> } | undefined)?.variables ?? {};
  const variables: GraphVariable[] = Object.entries(payload.variables ?? {}).map(([name, spec]) => {
    const item = (spec ?? {}) as Record<string, unknown>;
    return {
      name,
      type: (['number', 'text', 'key'].includes(String(item.type))
        ? String(item.type)
        : 'number') as GraphVariable['type'],
      value: (item.value ?? 0) as number | string | boolean,
      runtimeValue: runtime[name],
    };
  });

  const recognizers: RecognizerView[] = Object.entries(payload.recognizers ?? {}).map(([label, spec]) => {
    const live1 = liveScores.get(label);
    const type = str(spec.type, 'template');
    // 没写 roi = 整帧（引擎的语义）；界面按 [0,0,1,1] 画全屏框，不能显示成 0×0
    const roi = Array.isArray(spec.roi) && spec.roi.length === 4 ? (spec.roi as number[]) : [0, 0, 1, 1];
    return {
      label,
      type: type === 'color' ? 'color' : type === 'ocr' ? 'ocr' : 'template',
      template: typeof spec.template === 'string' ? spec.template : undefined,
      text: typeof spec.text === 'string' ? spec.text : undefined,
      recordedSize:
        Array.isArray(spec.recorded_size) && spec.recorded_size.length === 2
          ? [Number(spec.recorded_size[0]) || 0, Number(spec.recorded_size[1]) || 0]
          : undefined,
      score: live1?.score ?? 0,
      threshold: num(spec.threshold, 0.82),
      roi: [roi[0] ?? 0, roi[1] ?? 0, roi[2] ?? 1, roi[3] ?? 1],
      search: spec.search === 'full' ? 'full' : 'region',
      samples: 1,
      state: (live1?.state as RecognizerView['state']) ?? 'idle',
    };
  });

  const flowSteps: FlowStep[] = (payload.flow?.steps ?? []).map((step) => {
    const item = step;
    return {
      id: str(item.id),
      type: str(item.type),
      params:
        typeof item.params === 'object' && item.params !== null
          ? (item.params as Record<string, unknown>)
          : {},
      disabled: item.disabled === true,
    };
  });

  return {
    deviceId,
    nodes,
    edges,
    recognizers,
    variables,
    activeNodeId: live?.node ?? null,
    pendingNodeId: live?.pending ?? null,
    flow: { steps: flowSteps },
  };
}

function labels(value: unknown): string[] {
  if (typeof value === 'string') {
    return value ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.filter((item: unknown): item is string => typeof item === 'string' && item.length > 0);
  }
  return [];
}

/** graph.json 的 condition → 界面模型（没写 condition 时等价于 all_of=[when]） */
function toCondition(edge: Record<string, unknown>): EdgeCondition {
  const spec = (edge.condition ?? {}) as Record<string, unknown>;
  const allOf = labels(spec.all_of);
  const anyOf = labels(spec.any_of);
  const noneOf = labels(spec.none_of);
  const when = str(edge.when);
  // 录制出来的"无条件"步骤：when 是哨兵，不能当成识别器标签
  const always = spec.always === true || when === 'always';
  return {
    allOf: always ? [] : allOf.length > 0 || anyOf.length > 0 || noneOf.length > 0 ? allOf : [when],
    anyOf,
    noneOf,
    minScore: num(spec.min_score, num(edge.min_score, 0)),
    withinMs: num(spec.within_ms, 0),
    always,
  };
}

/** graph.json 的 action → 界面模型 */
/** 引擎里的 {"$var": "点X"} ↔ 界面上写成 "$点X" */
export function toParamValue(value: unknown): ParamValue | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return value.startsWith('$') ? value : value;
  }
  if (value && typeof value === 'object' && '$var' in (value as Record<string, unknown>)) {
    return `$${String((value as Record<string, unknown>).$var)}`;
  }
  return undefined;
}

function toAction(value: unknown, fallbackTarget: string): EdgeAction {
  const spec = (value ?? {}) as Record<string, unknown>;
  const type = str(spec.type, 'click');
  // 必须和引擎 `core/actions.py` 的 ACTION_TYPES 对齐：漏一个就会把用户录的动作静默改写成 click
  const known = ['click', 'double_click', 'long_press', 'swipe', 'wait', 'key', 'text', 'set', 'call'];
  return {
    type: (known.includes(type) ? type : 'click') as EdgeAction['type'],
    target:
      typeof spec.target === 'string'
        ? spec.target
        : spec.x !== undefined && spec.y !== undefined
          ? undefined
          : fallbackTarget,
    toTarget: typeof spec.to_target === 'string' ? spec.to_target : undefined,
    x: toParamValue(spec.x),
    y: toParamValue(spec.y),
    toX: toParamValue(spec.to_x),
    toY: toParamValue(spec.to_y),
    durationMs: toParamValue(spec.duration_ms) ?? 300,
    seconds: toParamValue(spec.seconds) ?? 0.5,
    name: typeof spec.name === 'string' ? spec.name : undefined,
    script: typeof spec.script === 'string' ? spec.script : undefined,
    assign: toParamValue(spec.value) !== undefined ? String(toParamValue(spec.value)) : undefined,
    value: typeof spec.value === 'string' ? spec.value : '',
  };
}
