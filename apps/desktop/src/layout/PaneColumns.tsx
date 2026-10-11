/**
 * 三栏主区（画面 / 状态图 / 右栏）：横向可拖，布局记忆在 layout-specs.ts。
 *
 * 从 App.tsx 拆出来是为了让主壳只负责"装壳"：栏怎么排、栏里放什么，各自一个文件。
 */
import { type ReactNode } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';

import { ScreenPane } from '@/features/device/ScreenPane';
import { GraphPane } from '@/features/graph/GraphPane';
import { RightColumn } from '@/layout/RightColumn';
import { SHELL_LAYOUT } from '@/layout/layout-specs';
import { useLayoutGroup } from '@/layout/useLayoutGroup';

export function PaneColumns(): ReactNode {
  const shell = useLayoutGroup(SHELL_LAYOUT);

  return (
    <Group
      id={SHELL_LAYOUT.id}
      orientation="horizontal"
      defaultLayout={shell.defaultLayout}
      onLayoutChanged={shell.onLayoutChanged}
      groupRef={shell.groupRef}
      className="h-full"
    >
      <Panel id="screen" defaultSize="34%" minSize="22%">
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
      <Panel id="right" defaultSize="26%" minSize="18%">
        <RightColumn />
      </Panel>
    </Group>
  );
}
