/**
 * 三栏主区（画面 / 工作流 / 右栏）：横向可拖，布局记忆在 layout-specs.ts。
 *
 * 中间那一栏展示**当前工作流**（IDE 编辑器风格：标签 + 左托盘 + 画布 + 下方详情坞）。
 *
 * 从 App.tsx 拆出来是为了让主壳只负责"装壳"：栏怎么排、栏里放什么，各自一个文件。
 */
import { type ReactNode, useEffect } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

import { ScreenPane } from '@/features/device/ScreenPane';
import { GraphPane } from '@/features/graph/GraphPane';
import { RightColumn } from '@/layout/RightColumn';
import { SHELL_LAYOUT } from '@/layout/layout-specs';
import { useLayoutGroup } from '@/layout/useLayoutGroup';
import { useUiStore } from '@/stores/ui.store';

export function PaneColumns(): ReactNode {
  const shell = useLayoutGroup(SHELL_LAYOUT);
  const screenRef = usePanelRef();
  const rightRef = usePanelRef();
  const leftPaneOpen = useUiStore((state) => state.leftPaneOpen);
  const rightPaneOpen = useUiStore((state) => state.rightPaneOpen);
  const setLeftPaneOpen = useUiStore((state) => state.setLeftPaneOpen);
  const setRightPaneOpen = useUiStore((state) => state.setRightPaneOpen);

  useEffect(() => {
    const panel = screenRef.current;
    if (!panel) {
      return;
    }
    if (leftPaneOpen) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [leftPaneOpen, screenRef]);

  useEffect(() => {
    const panel = rightRef.current;
    if (!panel) {
      return;
    }
    if (rightPaneOpen) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [rightPaneOpen, rightRef]);

  return (
    <Group
      id={SHELL_LAYOUT.id}
      orientation="horizontal"
      defaultLayout={shell.defaultLayout}
      onLayoutChanged={shell.onLayoutChanged}
      groupRef={shell.groupRef}
      className="h-full"
    >
      <Panel
        id="screen"
        defaultSize="34%"
        minSize="18%"
        collapsible
        collapsedSize="0px"
        panelRef={screenRef}
        onResize={() => {
          const collapsed = screenRef.current?.isCollapsed() ?? false;
          if (leftPaneOpen === collapsed) {
            setLeftPaneOpen(!collapsed);
          }
        }}
        style={{ overflow: 'hidden' }}
      >
        <ScreenPane />
      </Panel>
      <Separator
        className="w-px bg-line transition-colors hover:bg-brand"
        title="拖动改宽度 · 双击恢复默认"
      />
      <Panel id="graph" defaultSize="40%" minSize="24%">
        <GraphPane />
      </Panel>
      <Separator
        className="w-px bg-line transition-colors hover:bg-brand"
        title="拖动改宽度 · 双击恢复默认"
      />
      <Panel
        id="right"
        defaultSize="26%"
        minSize="12%"
        collapsible
        collapsedSize="0px"
        panelRef={rightRef}
        onResize={() => {
          const collapsed = rightRef.current?.isCollapsed() ?? false;
          if (rightPaneOpen === collapsed) {
            setRightPaneOpen(!collapsed);
          }
        }}
        style={{ overflow: 'hidden' }}
      >
        <RightColumn />
      </Panel>
    </Group>
  );
}
