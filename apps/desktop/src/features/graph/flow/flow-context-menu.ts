/**
 * 步骤链画布右键：从模块目录插入（与左栏拖放等价，同样随设备平台过滤不支持的模块）。
 */
import { CircleDot, Play, Repeat, Scissors, Settings2, Trash2, Unplug } from 'lucide-react';
import { createElement } from 'react';

import type { MenuAnchor, MenuItem } from '@/features/graph/GraphContextMenu';
import { FlowStepIcon } from '@/features/graph/flow/flow-step-icons';
import { flowModuleGroupsForDevice, type PaletteModule } from '@/features/graph/flow/flow-step-meta';
import type { DeviceKind } from '@/types';

/** 右键菜单里简短的右侧提示说明，避免过长说明挤压主标题 */
function shortHintForModule(module: PaletteModule): string {
  switch (module.type) {
    case 'click':
      return '坐标 / 识别器';
    case 'swipe':
      return '点对点 / 连续';
    case 'key':
      return '返回 / 主页 / 任务';
    case 'text':
      return 'ADB 文本';
    case 'wait':
      return '识别器命中';
    case 'delay':
      return '毫秒延时';
    case 'cond':
      return '成立 / 不成立分流';
    case 'loop':
      return '最多 N 次，可跳出';
    case 'loopbreak':
      return '提前结束循环';
    case 'call':
      return '同工作区';
    case 'setvar':
      return '变量 = 值 / 表达式';
    default:
      return module.hint;
  }
}

function moduleMenuItem(
  module: PaletteModule,
  onPick: (module: PaletteModule) => void,
  divider = false,
): MenuItem {
  return {
    label: module.label,
    hint: shortHintForModule(module),
    icon: createElement(FlowStepIcon, {
      type: module.type,
      className: 'size-3.5 shrink-0',
      strokeWidth: 1.75,
    }),
    divider,
    onSelect: () => onPick(module),
  };
}

export function flowSelectionContextMenu(
  screen: { x: number; y: number },
  flow: { x: number; y: number },
  selectionCount: number,
  onWrapLoop: () => void,
  onDeleteSelection?: () => void,
): MenuAnchor {
  const items: MenuItem[] = [
    {
      label: '套循环',
      hint: `${selectionCount} 个模块 · 固定次数重复`,
      icon: createElement(Repeat, { className: 'size-3.5 shrink-0', strokeWidth: 1.75 }),
      onSelect: onWrapLoop,
    },
  ];
  if (onDeleteSelection) {
    items.push({
      label: '删除选中',
      icon: createElement(Trash2, { className: 'size-3.5 shrink-0', strokeWidth: 1.75 }),
      danger: true,
      divider: true,
      onSelect: onDeleteSelection,
    });
  }
  return {
    kind: 'pane',
    flow,
    screen,
    title: `已选 ${selectionCount} 个模块`,
    items,
  };
}

export function flowPaneContextMenu(
  screen: { x: number; y: number },
  flow: { x: number; y: number },
  onPick: (module: PaletteModule) => void,
  deviceKind?: DeviceKind | null,
): MenuAnchor {
  const items: MenuItem[] = flowModuleGroupsForDevice(deviceKind).flatMap((group, groupIndex) =>
    group.items.map((module, itemIndex) => moduleMenuItem(module, onPick, groupIndex > 0 && itemIndex === 0)),
  );
  return {
    kind: 'pane',
    flow,
    screen,
    title: '添加模块',
    items,
  };
}

export function flowNodeContextMenu(
  screen: { x: number; y: number },
  flow: { x: number; y: number },
  stepId: string,
  stepTitle: string,
  onInsertAfter: (module: PaletteModule) => void,
  onSelect: () => void,
  deviceKind?: DeviceKind | null,
  onRunFromStep?: () => void,
  onDeleteStep?: () => void,
  onDeleteKeepingGap?: () => void,
  hasBreakpoint?: boolean,
  onToggleBreakpoint?: () => void,
): MenuAnchor {
  const moduleItems: MenuItem[] = flowModuleGroupsForDevice(deviceKind).flatMap((group, groupIndex) =>
    group.items.map((module, itemIndex) =>
      moduleMenuItem(module, onInsertAfter, groupIndex === 0 && itemIndex === 0),
    ),
  );
  if (moduleItems.length > 0 && !moduleItems[0]?.divider) {
    moduleItems[0] = { ...moduleItems[0]!, divider: true };
  }

  const headItems: MenuItem[] = [
    ...(onRunFromStep
      ? [
          {
            label: '从本模块运行',
            icon: createElement(Play, { className: 'size-3.5 shrink-0 text-ok', strokeWidth: 1.75 }),
            onSelect: onRunFromStep,
          },
        ]
      : []),
    ...(onToggleBreakpoint
      ? [
          {
            label: hasBreakpoint ? '清除断点' : '在这里设断点',
            hint: hasBreakpoint ? '已设：运行到这一步会暂停' : '运行到这一步先暂停',
            icon: createElement(CircleDot, {
              className: hasBreakpoint ? 'size-3.5 shrink-0 text-err' : 'size-3.5 shrink-0',
              strokeWidth: 1.75,
            }),
            onSelect: onToggleBreakpoint,
          },
        ]
      : []),
    {
      label: '模块设置',
      icon: createElement(Settings2, { className: 'size-3.5 shrink-0', strokeWidth: 1.75 }),
      onSelect: onSelect,
    },
  ];

  const tailItems: MenuItem[] = [];
  if (onDeleteStep) {
    tailItems.push({
      label: '删除此模块',
      icon: createElement(Trash2, { className: 'size-3.5 shrink-0', strokeWidth: 1.75 }),
      danger: true,
      divider: true,
      onSelect: onDeleteStep,
    });
  }
  if (onDeleteKeepingGap) {
    tailItems.push({
      label: '删除并保留缺口',
      hint: '下游不自动接上',
      icon: createElement(Unplug, { className: 'size-3.5 shrink-0', strokeWidth: 1.75 }),
      danger: true,
      onSelect: onDeleteKeepingGap,
    });
  }

  return {
    kind: 'node',
    id: stepId,
    flow,
    screen,
    title: stepTitle,
    items: [...headItems, ...moduleItems, ...tailItems],
  };
}

/** 画布连线右键：断开这条线（只删这一条，下游就地变未接入，不会自动接回上游） */
export function flowEdgeContextMenu(
  screen: { x: number; y: number },
  flow: { x: number; y: number },
  edgeId: string,
  onDisconnect: () => void,
): MenuAnchor {
  return {
    kind: 'edge',
    id: edgeId,
    flow,
    screen,
    title: '连线',
    items: [
      {
        label: '断开这条线',
        hint: '下游变未接入',
        icon: createElement(Scissors, { className: 'size-3.5 shrink-0', strokeWidth: 1.75 }),
        danger: true,
        onSelect: onDisconnect,
      },
    ],
  };
}
