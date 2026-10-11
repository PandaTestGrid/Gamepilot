/**
 * 边的**实时状态**：现在这一刻，这条边走不走得通。
 *
 * 调试脚本时最需要回答的就是"为什么它不动"——引擎每帧都会回识别结果（label + score + state），
 * 这里拿它和边上的判断条件对一遍，就能在图上直接标出：
 *
 * - `matched`  条件成立、而且没被更高优先级的边挡着 → 会走这条
 * - `waiting`  还差点：缺哪个识别器、分数不够、限时还没到
 * - `blocked`  被 `none_of` 挡着（比如"有弹窗时不走"）
 *
 * 纯函数、可单测；界面只负责上色。
 */
import type { EdgeCondition, GraphEdgeView } from '@/types';

export interface DetectionLike {
  readonly label: string;
  readonly score: number;
  readonly state: string;
}

export type EdgeStatusKind = 'matched' | 'waiting' | 'blocked';

export interface EdgeStatus {
  readonly kind: EdgeStatusKind;
  /** 一句话说明为什么（图上 tooltip 直接显示） */
  readonly reason: string;
}

/** 识别器当前算不算"命中"：引擎给 confirmed 才算（pending 是投票中）。 */
function hit(label: string, detections: Map<string, DetectionLike>): number | null {
  const found = detections.get(label);
  if (!found || found.state !== 'confirmed') {
    return null;
  }
  return found.score;
}

export function evaluateEdge(
  edge: GraphEdgeView,
  detections: ReadonlyArray<DetectionLike>,
  activeNodeId: string | null,
): EdgeStatus {
  const condition: EdgeCondition = edge.condition;
  const scores = new Map(detections.map((item) => [item.label, item] as const));

  // 不在当前界面的出口上 → 现在肯定不会走
  if (edge.from && activeNodeId && edge.from !== activeNodeId) {
    return { kind: 'waiting', reason: `当前在『${activeNodeId}』，这条边属于『${edge.from}』` };
  }

  if (condition.always) {
    return { kind: 'matched', reason: '无条件：轮到这个界面就会执行' };
  }

  const blocked = condition.noneOf.filter((label) => hit(label, scores) !== null);
  if (blocked.length > 0) {
    return { kind: 'blocked', reason: `『${blocked.join('、')}』正在出现，这条边被排除条件挡住` };
  }

  // 和引擎一致：三个组都空时才把 when 当 all_of（显式写了 any_of/none_of 就不兜底）
  const explicit = condition.allOf.length > 0 || condition.anyOf.length > 0 || condition.noneOf.length > 0;
  const allOf =
    condition.allOf.length > 0
      ? condition.allOf
      : !explicit && edge.when && edge.when !== 'always'
        ? [edge.when]
        : [];
  const missing: string[] = [];
  const low: string[] = [];
  for (const label of allOf) {
    const score = hit(label, scores);
    if (score === null) {
      missing.push(label);
    } else if (condition.minScore > 0 && score < condition.minScore) {
      low.push(`${label}=${score.toFixed(2)}`);
    }
  }
  if (missing.length > 0) {
    return { kind: 'waiting', reason: `还差：『${missing.join('、')}』没命中` };
  }
  if (low.length > 0) {
    return {
      kind: 'waiting',
      reason: `分数不够（要求 ≥ ${condition.minScore.toFixed(2)}）：${low.join('、')}`,
    };
  }

  if (condition.anyOf.length > 0 && allOf.length === 0) {
    const anyHit = condition.anyOf.some((label) => hit(label, scores) !== null);
    if (!anyHit) {
      return { kind: 'waiting', reason: `『${condition.anyOf.join('、')}』都没出现` };
    }
  }

  return { kind: 'matched', reason: '条件成立，轮到它就执行' };
}

/** 同一界面的多条边里，只有优先级最高的那条会真的执行。 */
export function markShadowed(
  edges: ReadonlyArray<GraphEdgeView>,
  statuses: ReadonlyMap<string, EdgeStatus>,
): Map<string, EdgeStatus> {
  const out = new Map(statuses);
  const bySource = new Map<string, GraphEdgeView[]>();
  for (const edge of edges) {
    const key = edge.from ?? '';
    bySource.set(key, [...(bySource.get(key) ?? []), edge]);
  }
  for (const group of bySource.values()) {
    const matched = group
      .filter((edge) => statuses.get(edge.id)?.kind === 'matched')
      .sort((a, b) => b.priority - a.priority);
    const first = matched[0];
    for (const edge of matched.slice(1)) {
      if (first && edge.priority < first.priority) {
        out.set(edge.id, {
          kind: 'waiting',
          reason: `优先级比『${first.id}』低，这一轮不会走它`,
        });
      }
    }
  }
  return out;
}
