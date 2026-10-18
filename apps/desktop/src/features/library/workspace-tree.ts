/**
 * 工作区树的**纯函数**：把引擎返回的数据收窄成能渲染的形状 + 路径/时间/搜索选择。
 *
 * 为什么要单独一层：引擎返回的东西一律当**外部数据**——测试里 mock 的 `invoke` 就返回 `{}`，
 * 引擎也可能少字段（比如老版本没有 `templates`、没有 `modified`）。界面绝不能崩在一句 `.length` 上，
 * 所以收窄只在这里做一次，组件与 store 都吃"已经干净"的数据（和 `toItems()` 那套防御风格一致）。
 *
 * 两层的名字（契约 v4 §0）：**工作区（= 项目，同一个东西；用户选的文件夹）› 工作流 = 一张流程图**。
 */
import type {
  WorkspaceListResult,
  WorkspaceSummary,
  WorkspaceTreePayload,
  WorkflowSummary,
  WorkflowTrigger,
} from '@/lib/rpc';

/** 取对象上的一个键（不是对象就当没有）。 */
function read(source: unknown, key: string): unknown {
  return typeof source === 'object' && source !== null ? (source as Record<string, unknown>)[key] : undefined;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** `Array.isArray` 收窄出来的是 `any[]`，这里换成 `unknown[]` 再往下走（项目禁 any）。 */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? Array.from<unknown>(value) : [];
}

/**
 * `modified`（epoch 秒，整数）：缺失/非法一律归 0 = 「不知道」。
 * 不用 `Date.now()` 兜底：那会让每个工作流都显示「刚刚」，比不显示更误导。
 */
export function toModified(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 触发条件：只认 `{type, params}`；缺失/类型不对就是 null（调用节点不显示）。 */
function toTrigger(value: unknown): WorkflowTrigger | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const type = str(read(value, 'type'));
  if (!type) {
    return null;
  }
  const params = read(value, 'params');
  return {
    type,
    params: typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {},
  };
}

/** 工作流摘要：字段缺失/类型不对一律降级（缺 nodes 就当 0，而不是显示 undefined）。 */
export function toWorkflow(value: unknown): WorkflowSummary | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return {
    name: str(read(value, 'name')),
    root: str(read(value, 'root')),
    nodes: num(read(value, 'nodes')),
    edges: num(read(value, 'edges')),
    recognizers: num(read(value, 'recognizers')),
    templates: num(read(value, 'templates')),
    modified: toModified(read(value, 'modified')),
    trigger: toTrigger(read(value, 'trigger')),
  };
}

/** 工作流数组：非数组/混进 null 都过滤掉。 */
export function toWorkflows(value: unknown): WorkflowSummary[] {
  const workflows: WorkflowSummary[] = [];
  for (const item of list(value)) {
    const workflow = toWorkflow(item);
    if (workflow) {
      workflows.push(workflow);
    }
  }
  return workflows;
}

/** `workspace.tree` 的返回（`{ root, workflows }`）。 */
export function toTree(result: unknown): WorkspaceTreePayload {
  return { root: str(read(result, 'root')), workflows: toWorkflows(read(result, 'workflows')) };
}

/** `workspace.add` / `workspace.remove` 的返回（整棵树在 `tree` 里嵌套一层）。 */
export function toMutationTree(result: unknown): WorkspaceTreePayload {
  return toTree(read(result, 'tree'));
}

/** `workflow.*` 的返回（`{ items }`，每项是一个工作流）。 */
export function toWorkflowItems(result: unknown): WorkflowSummary[] {
  return toWorkflows(read(result, 'items'));
}

/* ---------------- 工作区层（v4：可以有多个；右栏那个区域用） ---------------- */

/** 工作区列表里的一项；`exists` 缺字段时当"存在"（老引擎不报这个字段）。 */
export function toWorkspace(value: unknown): WorkspaceSummary | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const root = str(read(value, 'root'));
  return {
    name: str(read(value, 'name')) || baseName(root),
    root,
    active: read(value, 'active') === true,
    exists: read(value, 'exists') !== false,
  };
}

/**
 * `workspace.list` / `add` / `remove` 的 `items`：**三个方法同形状**（契约 v4 §2.1），
 * 所以一套收窄吃三个返回，不用回退补调。
 */
export function toWorkspaces(result: unknown): WorkspaceSummary[] {
  const workspaces: WorkspaceSummary[] = [];
  for (const item of list(read(result, 'items'))) {
    const workspace = toWorkspace(item);
    if (workspace) {
      workspaces.push(workspace);
    }
  }
  return workspaces;
}

/** `workspace.list` 的返回（`{ active, recommended, items }`）。 */
export function toWorkspaceList(result: unknown): WorkspaceListResult {
  const active = read(result, 'active');
  return {
    active: typeof active === 'string' && active ? active : null,
    recommended: str(read(result, 'recommended')),
    items: toWorkspaces(result),
  };
}

/* ---------------- 路径、时间与搜索 ---------------- */

/** 路径的父目录（同时认 `/` 与 `\`；没有父目录时给空串）。 */
export function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index > 0 ? trimmed.slice(0, index) : '';
}

/** 路径的最后一段（标题行「工作区 my-game-bot」里的名字兜底、加工作区时预填的名字）。 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/**
 * 用户输的路径能不能当工作区：只接受绝对路径或 `~` 开头（契约 v4 §2.1）。
 * 前端先拦一道，给即时反馈；引擎那边还有同一套校验（相对路径报「必须是绝对路径」）。
 */
export function isAbsolutePath(path: string): boolean {
  const text = path.trim();
  if (text.startsWith('~')) {
    return true;
  }
  // POSIX 绝对路径 / Windows 盘符路径
  return text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text);
}

/**
 * 相对时间（面板里工作流那一列）：「刚刚 / 10 分钟 / 2 小时 / 15 天 / 1 个月」。
 *
 * 粒度（照参照图）：< 1 分钟「刚刚」→ < 60 分钟「N 分钟」→ < 24 小时「N 小时」→
 * < 30 天「N 天」→ 其余「N 个月」。**不显示年**：工作流的"老"到这个程度，月就够了。
 *
 * `modified` 是 epoch 秒；0 或未来时间 → 空串（不知道就不显示，不瞎猜）。
 * `now` 可注入，方便单测。
 */
export function relativeTime(modifiedSeconds: number, now: number = Date.now()): string {
  if (!Number.isFinite(modifiedSeconds) || modifiedSeconds <= 0) {
    return '';
  }
  const seconds = Math.floor(now / 1000) - Math.floor(modifiedSeconds);
  if (seconds < 60) {
    return '刚刚';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} 天`;
  }
  return `${Math.floor(days / 30)} 个月`;
}

/** 名字是否命中搜索词（空搜索词 = 全命中；大小写不敏感）。 */
export function matchesQuery(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || name.toLowerCase().includes(needle);
}

/** 本地过滤工作区（面板搜索框）。 */
export function searchWorkspaces(workspaces: readonly WorkspaceSummary[], query: string): WorkspaceSummary[] {
  return workspaces.filter((workspace) => matchesQuery(workspace.name, query));
}

/** 本地过滤当前工作区里的工作流（面板搜索框）。 */
export function searchWorkflows(workflows: readonly WorkflowSummary[], query: string): WorkflowSummary[] {
  return workflows.filter((workflow) => matchesQuery(workflow.name, query));
}

/** 当前工作区有没有工作流（欢迎卡片的显示条件）。 */
export function hasAnyWorkflow(workflows: readonly WorkflowSummary[]): boolean {
  return workflows.length > 0;
}
