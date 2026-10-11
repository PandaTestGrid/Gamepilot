/**
 * 节点坐标：**界面私有**（引擎不存 x/y），所以坐标的"记忆"必须由界面自己负责。
 *
 * 真踩过的坑（用户反馈"拖动后节点会消失""右键建的新节点前面的节点也没了"）：
 *   拖动只改了界面 store 里的坐标，而任何一次引擎回包（连接/录制/改名/切脚本/建节点）
 *   都会重新走 `toGraphData` 的网格 `layout(index)` —— 拖过的位置被**覆盖**，节点弹回网格；
 *   新建节点时还会展开下方详情坞（画布变矮），弹回去的节点就掉出可视区，看起来就是"消失"。
 *
 * 这里的约定：
 *   1. `applyPositions` / `preservePositions`：把记住的坐标套回新回包的图上（按节点 id 匹配）；
 *   2. 坐标顺手写进 localStorage：重启应用后"我摆好的图"还在（`重新布局` 可显式丢弃记忆）；
 *   3. 键里带脚本目录，切换脚本不会串味。
 */
import type { GraphData } from '@/types';

export interface NodePosition {
  readonly x: number;
  readonly y: number;
}

const STORAGE_PREFIX = 'gamepilot.node-positions';
/** 当前脚本目录：让"同一台设备在不同脚本里"的坐标互不干扰 */
let scope = 'default';

export function setPositionScope(root: string): void {
  scope = root || 'default';
}

function storageKey(deviceId: string): string {
  return `${STORAGE_PREFIX}:${scope}:${deviceId}`;
}

/** 从图里抽出坐标表 */
export function positionsOf(graph: GraphData | undefined): Record<string, NodePosition> {
  const result: Record<string, NodePosition> = {};
  for (const node of graph?.nodes ?? []) {
    result[node.id] = { x: node.x, y: node.y };
  }
  return result;
}

/** 把坐标套回图里（只认还存在的节点 id；缺的保持原样） */
export function applyPositions(graph: GraphData, positions: Record<string, NodePosition>): GraphData {
  if (graph.nodes.length === 0) {
    return graph;
  }
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    const known = positions[node.id];
    if (!known || (known.x === node.x && known.y === node.y)) {
      return node;
    }
    changed = true;
    return { ...node, x: known.x, y: known.y };
  });
  return changed ? { ...graph, nodes } : graph;
}

/**
 * 引擎回包的新图 + 上一份界面图 → 保住用户摆过的坐标。
 * 新出现的节点用引擎给的网格坐标，删掉的节点自然丢弃。
 */
export function preservePositions(next: GraphData, previous: GraphData | undefined): GraphData {
  return previous ? applyPositions(next, positionsOf(previous)) : next;
}

export function loadStoredPositions(deviceId: string): Record<string, NodePosition> {
  try {
    const raw = window.localStorage.getItem(storageKey(deviceId));
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, NodePosition>;
    const result: Record<string, NodePosition> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value?.x === 'number' && typeof value?.y === 'number') {
        result[id] = { x: value.x, y: value.y };
      }
    }
    return result;
  } catch {
    return {}; // 存储坏了不该让画布挂掉
  }
}

export function storePositions(deviceId: string, graph: GraphData): void {
  try {
    window.localStorage.setItem(storageKey(deviceId), JSON.stringify(positionsOf(graph)));
  } catch {
    // 隐私模式/配额满：坐标记不住就算了，不能影响编辑
  }
}

export function clearStoredPositions(deviceId: string): void {
  try {
    window.localStorage.removeItem(storageKey(deviceId));
  } catch {
    // 同上
  }
}
