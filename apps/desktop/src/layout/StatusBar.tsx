import { type ReactNode } from 'react';

import { activeDevice, useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
import { useEventStore } from '@/stores/event.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';

/**
 * 底栏状态行：运行指标 + 最后一条事件摘要。任一指标异常变红（DESIGN.md §4.2 E）。
 *
 * 不再自己画边框/背景：它是底部抽屉那条 28px 状态行的一部分（见 layout/BottomDock.tsx），
 * 所以也不需要外面传 `running` —— 直接从会话 store 读，少一层 prop 传递。
 */
export function StatusBar(): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const running = useSessionStore((state) => Boolean(state.running[activeId]));
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
    <div className="flex h-6 min-w-0 flex-1 items-center gap-3 text-badge text-dim">
      {items.map((item) => (
        <span key={item.key} className="flex items-center gap-1">
          <span className="text-faint">{item.key}</span>
          <span className={item.bad ? 'text-failed' : undefined}>{item.value}</span>
        </span>
      ))}
      <div className="min-w-2 flex-1" />
      <span className="max-w-[40%] truncate" title={last?.message}>
        {engineStatus === 'ready'
          ? last
            ? `${last.type} · ${last.message}`
            : '引擎已就绪，暂无事件'
          : '骨架自检未运行'}
      </span>
    </div>
  );
}
