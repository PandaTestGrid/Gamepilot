/**
 * 引擎状态图（graph.json 的 JSON 形态）→ 界面模型（GraphData）。
 *
 * 两边的差异只在两点，转换必须保持"引擎是唯一真源"：
 *   1. 引擎不存节点坐标（那是 UI 私有数据）→ 这里按网格自动布局；
 *   2. 引擎的边是扁平 dict → 这里收敛成强类型 GraphEdgeView。
 */
import type { GraphPayload } from '@/lib/rpc';
import type { EdgeKind, GraphData, GraphEdgeView, GraphNodeView, RecognizerView } from '@/types';

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
    ...layout(index),
    visits: 0,
    note: node.timeout_ms ? `timeout ${node.timeout_ms}ms` : undefined,
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
  }));

  const liveScores = new Map((live?.detections ?? []).map((item) => [item.label, item] as const));
  const recognizers: RecognizerView[] = Object.entries(payload.recognizers ?? {}).map(([label, spec]) => {
    const live1 = liveScores.get(label);
    const type = str(spec.type, 'template');
    const roi = Array.isArray(spec.roi) && spec.roi.length === 4 ? (spec.roi as number[]) : [0, 0, 0, 0];
    return {
      label,
      type: type === 'color' ? 'color' : type === 'ocr' ? 'ocr' : 'template',
      score: live1?.score ?? 0,
      threshold: num(spec.threshold, 0.82),
      roi: [roi[0] ?? 0, roi[1] ?? 0, roi[2] ?? 0, roi[3] ?? 0],
      samples: 1,
      state: (live1?.state as RecognizerView['state']) ?? 'idle',
    };
  });

  return {
    deviceId,
    nodes,
    edges,
    recognizers,
    activeNodeId: live?.node ?? null,
    pendingNodeId: live?.pending ?? null,
  };
}
