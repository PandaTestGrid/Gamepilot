/**
 * 独立窗口：`?pane=screen|graph|events&device=dev-a` 只渲染那一栏（DESIGN.md §4.6）。
 * 典型用法：把画面丢到第二块屏，主窗口留状态图与脚本库。
 */
import { type ReactNode, useEffect } from 'react';

import { ScreenPane } from '@/features/device/ScreenPane';
import { EventFeed } from '@/features/events/EventFeed';
import { GraphPane } from '@/features/graph/GraphPane';
import { useDeviceStore } from '@/stores/device.store';
import type { PaneKind } from '@/lib/windows';

export function StandalonePane({ pane, deviceId }: { pane: PaneKind; deviceId: string | null }): ReactNode {
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
        <span className="text-panelhead font-medium">
          {pane === 'screen' ? '画面' : pane === 'graph' ? '状态图' : '事件流'}
        </span>
        <span className="text-badge text-faint">{device?.name ?? '未指定设备'}</span>
        <div className="flex-1" />
        <span className="text-badge text-faint">独立窗口 · 关闭不影响运行</span>
      </header>
      <div className="min-h-0 flex-1">
        {pane === 'screen' && <ScreenPane />}
        {pane === 'graph' && <GraphPane />}
        {pane === 'events' && <EventFeed />}
      </div>
    </div>
  );
}
