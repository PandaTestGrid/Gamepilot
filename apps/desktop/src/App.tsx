import { type ReactNode, useEffect, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';

import { DevicePopover } from '@/features/device/DevicePopover';
import { ScreenPane } from '@/features/device/ScreenPane';
import { EventPane } from '@/features/events/EventPane';
import { GraphPane } from '@/features/graph/GraphPane';
import { RecognizerPane } from '@/features/recognizers/RecognizerPane';
import { DeviceTabs } from '@/layout/DeviceTabs';
import { StatusBar } from '@/layout/StatusBar';
import { Toolbar } from '@/layout/Toolbar';
import { readPaneQuery, type PaneKind } from '@/lib/windows';
import { useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
import { useEventStore } from '@/stores/event.store';
import { useGraphStore } from '@/stores/graph.store';

/**
 * 主壳。
 *
 * 两个入口：
 *   - 主窗口：工具栏 + 设备标签条 + 三栏（可拖拽、布局记忆）+ 底栏 + 设备弹层
 *   - 独立窗口：`?pane=screen&device=dev-a` 只渲染那一栏（DESIGN.md §4.6）
 */
export function App(): ReactNode {
  const { pane, deviceId } = readPaneQuery();
  const [running, setRunning] = useState(false);
  const init = useEngineStore((state) => state.init);
  // 布局记忆：拖过的栏宽会存进 localStorage，下次启动恢复
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: 'gamepilot.layout.v1' });

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void init().then((unlisten) => {
      dispose = unlisten;
    });
    return () => {
      dispose?.();
    };
  }, [init]);

  // 每台设备首次出现时补齐它的状态图与事件桶（M1 换成从引擎拉取）
  const devices = useDeviceStore((state) => state.devices);
  const ensureGraph = useGraphStore((state) => state.ensure);
  const ensureEvents = useEventStore((state) => state.ensure);
  useEffect(() => {
    for (const device of devices) {
      ensureGraph(device.id);
      ensureEvents(device.id);
    }
  }, [devices, ensureGraph, ensureEvents]);

  if (pane) {
    return <StandalonePane pane={pane} deviceId={deviceId} />;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <Toolbar running={running} onToggleRun={() => setRunning((value) => !value)} />
      <DeviceTabs />

      <main className="min-h-0 flex-1">
        {/* 三栏可拖拽 + 布局记忆（DESIGN.md 决策 P3） */}
        <Group
          id="gamepilot.layout.v1"
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
          className="h-full"
        >
          <Panel id="screen" defaultSize="34%" minSize="22%">
            <ScreenPane />
          </Panel>
          <Separator className="w-px bg-line transition-colors hover:bg-brand" />
          <Panel id="graph" defaultSize="40%" minSize="24%">
            <GraphPane />
          </Panel>
          <Separator className="w-px bg-line transition-colors hover:bg-brand" />
          <Panel id="right" defaultSize="26%" minSize="18%">
            <div className="flex h-full flex-col">
              <EventPane />
              <RecognizerPane />
            </div>
          </Panel>
        </Group>
      </main>

      <StatusBar running={running} />
      <DevicePopover />
    </div>
  );
}

/** 独立窗口：只渲染一栏，给第二块屏用（画面丢过去，主窗口留状态图与事件）。 */
function StandalonePane({ pane, deviceId }: { pane: PaneKind; deviceId: string | null }): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const setActive = useDeviceStore((state) => state.setActive);
  const device = devices.find((item) => item.id === deviceId) ?? null;

  useEffect(() => {
    if (device) {
      setActive(device.id);
    }
  }, [device, setActive]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        <span className="text-panel font-medium">
          {pane === 'screen' ? '画面' : pane === 'graph' ? '状态图' : '事件'}
        </span>
        <span className="text-badge text-faint">{device?.name ?? '未指定设备'}</span>
        <div className="flex-1" />
        <span className="text-badge text-faint">独立窗口 · 关闭不影响运行</span>
      </header>
      <div className="min-h-0 flex-1">
        {pane === 'screen' && <ScreenPane />}
        {pane === 'graph' && <GraphPane />}
        {pane === 'events' && <EventPane />}
      </div>
    </div>
  );
}
