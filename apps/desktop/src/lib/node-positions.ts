/**
 * 节点坐标：**界面私有**（引擎不存 x/y），所以坐标的"记忆"必须由界面自己负责。
 *
 * 引擎不存坐标；`applyPositions` / `preservePositions` 按节点 id 合并，键为脚本目录 + localStorage。
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

function storageKey(): string {
  return `${STORAGE_PREFIX}:${scope}`;
}

/** 旧版本按设备分开记的键前缀（`<前缀>:<设备 id>`）—— 只在迁移时读，不再写 */
function legacyPrefix(): string {
  return `${STORAGE_PREFIX}:${scope}:`;
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

/** 读一份记忆（坏数据当没有：存储坏了不该让画布挂掉） */
function readStored(key: string): Record<string, NodePosition> {
  try {
    const raw = window.localStorage.getItem(key);
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

/**
 * 读取"这份脚本"的坐标。
 *
 * 兼容旧版本按设备分开记的键：项目级的键还没有时，把它们**合并**成一份
 * （后写的那台设备赢，localStorage 的键顺序就是写入顺序）——
 * 否则老用户升级后摆位全丢，节点会突然弹回网格。
 */
export function loadStoredPositions(): Record<string, NodePosition> {
  const current = readStored(storageKey());
  if (Object.keys(current).length > 0) {
    return current;
  }
  const prefix = legacyPrefix();
  const merged: Record<string, NodePosition> = {};
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) {
        Object.assign(merged, readStored(key));
      }
    }
  } catch {
    return merged;
  }
  return merged;
}

export function storePositions(graph: GraphData): void {
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(positionsOf(graph)));
  } catch {
    // 隐私模式/配额满：坐标记不住就算了，不能影响编辑
  }
}

/** 步骤链画布：节点 id = step id，坐标仍按工作流目录记忆 */
export function storeStepPositions(positions: Record<string, NodePosition>): void {
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(positions));
  } catch {
    // 同上
  }
}

/** 「重新布局」用：把这份脚本的记忆清掉（含旧版本按设备存的那几份，否则会被重新捡回来） */
export function clearStoredPositions(): void {
  clearStoredPositionsForRoot(scope);
}

function normalizePathKey(value: string): string {
  return value
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function matchesRootKey(storageKeyName: string, targetRoot: string): boolean {
  if (!storageKeyName.startsWith(`${STORAGE_PREFIX}:`)) {
    return false;
  }
  const rest = storageKeyName.slice(STORAGE_PREFIX.length + 1);
  const normRest = normalizePathKey(rest);
  const normTarget = normalizePathKey(targetRoot);
  return normRest === normTarget || normRest.startsWith(`${normTarget}:`);
}

function loadPositionsForRoot(root: string): Record<string, NodePosition> {
  if (!root) {
    return {};
  }
  const direct = readStored(`${STORAGE_PREFIX}:${root}`);
  if (Object.keys(direct).length > 0) {
    return direct;
  }
  const merged: Record<string, NodePosition> = {};
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && matchesRootKey(key, root)) {
        Object.assign(merged, readStored(key));
      }
    }
  } catch {
    return merged;
  }
  return merged;
}

/** 删除工作流时清掉该工作流的坐标缓存（防止新建同名工作流时串用旧坐标） */
export function clearStoredPositionsForRoot(root: string): void {
  if (!root) {
    return;
  }
  const toRemove: string[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && matchesRootKey(key, root)) {
        toRemove.push(key);
      }
    }
    window.localStorage.removeItem(`${STORAGE_PREFIX}:${root}`);
    for (const key of toRemove) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // 同上
  }
}

/** 删除工作区时清掉该工作区下所有工作流的坐标缓存 */
export function clearStoredPositionsUnder(baseDir: string): void {
  if (!baseDir) {
    return;
  }
  const normBase = normalizePathKey(baseDir);
  if (!normBase) {
    return;
  }
  const toRemove: string[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(`${STORAGE_PREFIX}:`)) {
        continue;
      }
      const rest = normalizePathKey(key.slice(STORAGE_PREFIX.length + 1));
      if (rest === normBase || rest.startsWith(`${normBase}/`)) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // 同上
  }
}

/** 复制工作流时把原工作流的节点摆位一并复制过去 */
export function copyStoredPositions(fromRoot: string, toRoot: string): void {
  if (!fromRoot || !toRoot) {
    return;
  }
  const existing = loadPositionsForRoot(fromRoot);
  if (Object.keys(existing).length === 0) {
    return;
  }
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}:${toRoot}`, JSON.stringify(existing));
  } catch {
    // 同上
  }
}

/** 工作流改名时把坐标缓存迁移到新目录，并清掉旧目录键 */
export function migrateStoredPositions(fromRoot: string, toRoot: string): void {
  if (!fromRoot || !toRoot || normalizePathKey(fromRoot) === normalizePathKey(toRoot)) {
    return;
  }
  copyStoredPositions(fromRoot, toRoot);
  clearStoredPositionsForRoot(fromRoot);
  if (normalizePathKey(scope) === normalizePathKey(fromRoot)) {
    scope = toRoot;
  }
}
