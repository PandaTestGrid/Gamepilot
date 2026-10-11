/**
 * 时间轴：最近 60s 的帧序列 + 拖动看历史帧。
 *
 * ⚠️ 现在是**占位实现**（M4 接入真实环形缓冲：拖动时画面栏切到历史帧，只读，不驱动设备）。
 * 之所以先放进底部抽屉的 Tab 里，是因为它属于"调试时偶尔看一眼"的信息，
 * 不该在右栏常驻占位置（DESIGN.md §4.2 D/E）。
 */
import { type ReactNode } from 'react';

import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';

export function TimelinePane(): ReactNode {
  const activeId = useDeviceStore((state) => state.activeId);
  const frame = useSessionStore((state) => state.frames[activeId]);

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2 text-badge text-faint">
      <div className="flex items-center gap-2">
        <span className="text-dim">时间轴</span>
        <div className="relative h-1 flex-1 bg-raised">
          <span className="absolute top-[-3px] left-[38%] size-2 rounded-full bg-brand" />
          <span className="absolute inset-y-0 left-0 w-[38%] bg-brand/40" />
        </div>
        <span>最近 60s</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span>
          当前帧 <span className="text-dim">#{frame?.index ?? '-'}</span>
        </span>
        <span>
          tick <span className="text-dim">{frame?.tick ?? '-'}</span>
        </span>
        <span>
          节点 <span className="text-dim">{frame?.node ?? '-'}</span>
        </span>
        <span>
          fps <span className="text-dim">{frame ? frame.fps.toFixed(1) : '-'}</span>
        </span>
        <span>
          截图耗时 <span className="text-dim">{frame ? `${frame.captureMs}ms` : '-'}</span>
        </span>
      </div>
      <div>
        还没接真实的帧环形缓冲（M4）：接上后这里是可拖的帧序列，拖动时画面栏切到历史帧（只读，不驱动设备）。
      </div>
    </div>
  );
}
