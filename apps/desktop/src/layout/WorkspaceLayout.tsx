/**
 * 工作区：**主区（三栏） + 底部调试抽屉** 的纵向可拖结构。
 *
 *     ┌───────────────────────────────┐
 *     │  主区：画面 | 状态图 | 右栏     │  ← 横向三栏（PaneColumns）
 *     ├───────────────────────────────┤  ⋮ 拖动改高度（DOCK_LAYOUT 记忆）
 *     │  底栏状态行 + 调试抽屉          │  ← 收起 28px / 展开可拖
 *     └───────────────────────────────┘
 *
 * 抽屉那格是 `collapsible`：收起时高度 = 状态行高度（DOCK_COLLAPSED_PX），
 * **不能收到 0** —— 0 的话分隔线会压在窗口底边，鼠标抓不到（见 CONVENTIONS §12.6-6）。
 */
import { type ReactNode } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

import { BottomDock, DOCK_COLLAPSED_PX, DOCK_MIN_PX } from '@/layout/BottomDock';
import { DOCK_LAYOUT } from '@/layout/layout-specs';
import { PaneColumns } from '@/layout/PaneColumns';
import { useLayoutGroup } from '@/layout/useLayoutGroup';

export function WorkspaceLayout(): ReactNode {
  const layout = useLayoutGroup(DOCK_LAYOUT);
  const dockRef = usePanelRef();

  return (
    <Group
      id={DOCK_LAYOUT.id}
      orientation="vertical"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      groupRef={layout.groupRef}
      className="h-full"
    >
      <Panel id="main" defaultSize="78%" minSize="30%" style={{ overflow: 'hidden' }}>
        <PaneColumns />
      </Panel>

      <Separator
        className="h-px bg-line transition-colors hover:bg-brand"
        title="拖动改高度 · 双击恢复默认"
      />

      <Panel
        id="dock"
        defaultSize="22%"
        minSize={`${DOCK_MIN_PX}px`}
        collapsible
        collapsedSize={`${DOCK_COLLAPSED_PX}px`}
        panelRef={dockRef}
        style={{ overflow: 'hidden' }}
      >
        <BottomDock panelRef={dockRef} />
      </Panel>
    </Group>
  );
}
