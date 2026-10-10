import { type ReactNode } from 'react';

import { activeDevice, useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
import { useEventStore } from '@/stores/event.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';

/** 底栏 24px：运行指标。任一指标异常变红（DESIGN.md §4.2 E）。 */
export function StatusBar({ running }: { running: boolean }): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const graph = useGraphStore((state) => state.graphs[activeId]);
  const events = useEventStore((state) => state.events[activeId]);
  const engineStatus = useEngineStore((state) => state.status);
  const frame = useSessionStore((state) => state.frames[activeId]);
  const link = useSessionStore((state) => state.links[activeId]);

  const device = activeDevice(devices, activeId);
  const connected = device?.status === 'connected';
  const fps = frame ? frame.fps : connected ? (device?.fps ?? 0) : 0;
  const last = events?.[events.length - 1];

  const items: Array<{ key: string; value: string; bad?: boolean }> = [
    { key: 'node', value: frame?.node ?? graph?.activeNodeId ?? '-' },
    { key: 'tick', value: String(frame?.tick ?? 0) },
    { key: 'vote', value: running ? '2/2' : '-' },
    {
      key: 'link',
      value: link ? `${link.channel}${link.channel === 'scrcpy' ? '' : '（慢）'}` : '-',
      bad: Boolean(link && link.channel !== 'scrcpy'),
    },
    { key: 'fps', value: connected ? fps.toFixed(1) : '-', bad: connected && fps < 3 },
    {
      key: 'capture',
      value: frame ? `${frame.captureMs}ms` : '-',
      bad: Boolean(frame && frame.captureMs > 200),
    },
    { key: 'input', value: connected ? '48ms' : '-' },
    { key: 'run', value: running ? '运行中' : '停止' },
  ];

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-badge text-dim">
      {items.map((item) => (
        <span key={item.key} className="flex items-center gap-1">
          <span className="text-faint">{item.key}</span>
          <span className={item.bad ? 'text-failed' : undefined}>{item.value}</span>
        </span>
      ))}
      <div className="flex-1" />
      <span className="truncate">
        {engineStatus === 'ready'
          ? last
            ? `${last.type} · ${last.message}`
            : '引擎已就绪，暂无事件'
          : '骨架自检未运行'}
      </span>
    </footer>
  );
}
