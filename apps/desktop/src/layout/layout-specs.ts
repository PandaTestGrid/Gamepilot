/**
 * 可拖拽布局的登记处：**"哪些区域能拖、拖完记在哪"只写在这里**。
 *
 * 界面里每个能拖的区域都是一个 `react-resizable-panels` 的 Group：
 *   - 主壳三栏（画面 / 状态图 / 右栏）→ 横向拖，改**宽度**
 *   - 栏内（画面·素材区、事件·识别器、画布·编辑器）→ 纵向拖，改**高度**
 * 两件事用的是同一套机制，所以"上下也能拖"是默认能力，不是某个面板的特例。
 *
 * 这里集中三件事，避免默认比例散落在各个组件里：
 *   1. 面板 id + 默认比例（`恢复默认布局` / 预设要用同一份数字）
 *   2. localStorage 记忆（`useDefaultLayout` 的 key 就是 `react-resizable-panels:<id>`）
 *   3. 预设与恢复默认：Group 的布局是库内部状态，只能走命令式 `setLayout`
 *
 * 注意：预设是"整组替换"，`setLayout` 会校验 key 数量与面板数一致，
 * 所以每组的面板 id 必须写全（少一个会抛错，多一个也会）。
 */
import type { Layout } from 'react-resizable-panels';

/** 一组面板的目标比例：panelId → 百分比（0~100，加起来 100）。 */
export type LayoutPanels = Readonly<Record<string, number>>;

export interface LayoutSpec {
  /** 同时是 localStorage key 与 Group 的 DOM id */
  readonly id: string;
  /** 面板 id 必须与组件里 <Panel id> 完全一致 */
  readonly panels: LayoutPanels;
}

/** 主壳三栏：画面 34 / 状态图 40 / 右栏 26（DESIGN.md §4.1） */
export const SHELL_LAYOUT: LayoutSpec = {
  id: 'gamepilot.layout.v1',
  panels: { screen: 34, graph: 40, right: 26 },
};

/** 画面栏：实时画面 70 / 素材区 30 */
export const SCREEN_LAYOUT: LayoutSpec = {
  id: 'gamepilot.layout.screen.v1',
  panels: { view: 70, materials: 30 },
};

/** 状态图栏：画布 80 / 编辑区 20（点节点展开；没选中时自动收起） */
export const GRAPH_LAYOUT: LayoutSpec = {
  id: 'gamepilot.layout.graph.v2',
  panels: { canvas: 80, editor: 20 },
};

/**
 * 工作流画布内：左侧模块栏 / 右侧画布区。
 *
 * 模块栏实际按像素宽（见 ModulePaletteRail），不随画面|画布分隔线按比例缩放。
 * 这里的百分比只给布局记忆/setLayout 当占位；v2 丢掉旧的 14%/86% 记忆，
 * 避免上次把模块栏拖得很宽之后，再拖画面宽度会把整栏撑满。
 */
export const GRAPH_PALETTE_LAYOUT: LayoutSpec = {
  id: 'gamepilot.layout.graph.palette.v2',
  panels: { palette: 14, workspace: 86 },
};

/** 工作流左右分屏（两个打开的标签并排） */
export const GRAPH_SPLIT_LAYOUT: LayoutSpec = {
  id: 'gamepilot.layout.graph.split.v1',
  panels: { primary: 50, secondary: 50 },
};

/**
 * 主区 / 底部调试抽屉：78 / 22。
 *
 * 右栏不再是纵向分组：它改成 Tab（脚本库 / 识别器，见 layout/RightColumn.tsx），
 * 事件流搬到了底部抽屉 —— 调试信息集中在下面一处，右栏留给"管理"。
 */
export const DOCK_LAYOUT: LayoutSpec = {
  id: 'gamepilot.layout.dock.v1',
  panels: { main: 78, dock: 22 },
};

export interface LayoutPreset {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  /** LayoutSpec.id → 该组的面板比例（必须写全该组的所有面板） */
  readonly groups: Readonly<Record<string, LayoutPanels>>;
}

/** 一键预设：调布局不用一根一根线去拖。点一下立刻生效并记住。 */
export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
  {
    id: 'balanced',
    name: '均衡（默认）',
    note: '三栏 34/40/26 · 画面与素材区 70/30',
    groups: {
      [SHELL_LAYOUT.id]: SHELL_LAYOUT.panels,
      [SCREEN_LAYOUT.id]: SCREEN_LAYOUT.panels,
      [GRAPH_LAYOUT.id]: GRAPH_LAYOUT.panels,
      [DOCK_LAYOUT.id]: DOCK_LAYOUT.panels,
    },
  },
  {
    id: 'screen',
    name: '画面优先',
    note: '画面栏最宽、画面最高（素材区压到最下面）',
    groups: {
      [SHELL_LAYOUT.id]: { screen: 52, graph: 28, right: 20 },
      [SCREEN_LAYOUT.id]: { view: 84, materials: 16 },
      [DOCK_LAYOUT.id]: { main: 90, dock: 10 },
    },
  },
  {
    id: 'graph',
    name: '状态图优先',
    note: '画布最大，事件与识别器让位',
    groups: {
      [SHELL_LAYOUT.id]: { screen: 26, graph: 52, right: 22 },
      [GRAPH_LAYOUT.id]: { canvas: 78, editor: 22 },
      [SCREEN_LAYOUT.id]: { view: 62, materials: 38 },
      [DOCK_LAYOUT.id]: { main: 86, dock: 14 },
    },
  },
  {
    id: 'debug',
    name: '调试优先（抽屉最大）',
    note: '底部抽屉拉开一半：事件流 / 日志 / 控制台一起盯',
    groups: {
      [SHELL_LAYOUT.id]: { screen: 32, graph: 42, right: 26 },
      [DOCK_LAYOUT.id]: { main: 52, dock: 48 },
      [SCREEN_LAYOUT.id]: { view: 60, materials: 40 },
    },
  },
];

/** 布局记忆的 localStorage key（与库内部实现一致：无 panelIds 时就是 `<id>` 一段） */
export function layoutStorageKey(id: string): string {
  return `react-resizable-panels:${id}`;
}

/** 取某组某个面板的默认比例（`Record` 在 noUncheckedIndexedAccess 下索引是 number|undefined） */
export function defaultPanelShare(spec: LayoutSpec, panelId: string): number {
  return spec.panels[panelId] ?? 0;
}

type LayoutApplier = (panels: LayoutPanels) => Layout | undefined;

/**
 * 已挂载的 Group：id → 命令式应用布局的函数。
 * 同一 id 出现两次（例如同一栏既开在主窗口又开在独立窗口）时后挂载的生效。
 */
const appliers = new Map<string, LayoutApplier>();

/** 由 useLayoutGroup 在挂载时登记；返回注销函数（给 useEffect 当清理用）。 */
export function registerLayoutGroup(id: string, apply: LayoutApplier): () => void {
  appliers.set(id, apply);
  return () => {
    if (appliers.get(id) === apply) {
      appliers.delete(id);
    }
  };
}

/** 记忆一次布局：用户拖过的比例下次启动还在。写失败（隐私模式/配额满）不影响界面。 */
export function rememberLayout(id: string, layout: Layout): void {
  try {
    localStorage.setItem(layoutStorageKey(id), JSON.stringify(layout));
  } catch {
    // 布局记忆是锦上添花，写不进去就算了
  }
}

/** 把一组比例应用到已挂载的 Group，并记住（预设走这条路，所以要落盘）。 */
export function applyLayoutPanels(id: string, panels: LayoutPanels): void {
  const applied = appliers.get(id)?.({ ...panels });
  // 只在真的算出了比例时才记忆：空布局写进 localStorage 会让下次启动读到 {}，
  // 而 setLayout 校验"key 数必须等于面板数"，那就成了启动即崩
  if (applied && Object.keys(applied).length > 0) {
    rememberLayout(id, applied);
  }
}

/** 应用一个预设：只改它列出的组，其余保持用户当前的样子。 */
export function applyLayoutPreset(preset: LayoutPreset): void {
  for (const [id, panels] of Object.entries(preset.groups)) {
    applyLayoutPanels(id, panels);
  }
}

/** 恢复默认布局（= 应用第一个预设，并把默认比例写回记忆）。 */
export function resetLayouts(): void {
  const [fallback] = LAYOUT_PRESETS;
  if (fallback) {
    applyLayoutPreset(fallback);
  }
}
