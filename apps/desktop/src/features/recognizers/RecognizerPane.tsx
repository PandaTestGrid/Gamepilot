/**
 * 识别器面板：缩略图位 + 实时分数 + 阈值现场调参（DESIGN.md §4.2 D）。
 *
 * 阈值滑块直接写回本地图（M2 起同时通过 RPC 让引擎按新阈值重算当帧分数，
 * 画面上的框会跟着变）——这就是「现场调参」的体感来源。
 */
import { type ReactNode } from 'react';

import { PanelShell, StatusDot } from '@/layout/PanelShell';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import type { RecognizerType } from '@/types';

export function RecognizerPane(): ReactNode {
  const activeId = useDeviceStore((state) => state.activeId);
  const graph = useGraphStore((state) => state.graphs[activeId]);
  const updateThreshold = useGraphStore((state) => state.updateRecognizerThreshold);
  const pushThreshold = useSessionStore((state) => state.setThreshold);
  const sessionReady = useSessionStore((state) => Boolean(state.ready[activeId]));
  const recognizers = graph?.recognizers ?? [];

  return (
    <PanelShell
      title="识别器"
      className="h-[220px] shrink-0"
      actions={<span className="text-badge text-faint">{recognizers.length} 个</span>}
    >
      <div className="h-full overflow-auto">
        {recognizers.map((item) => {
          const pass = item.score >= item.threshold;
          return (
            <div key={item.label} className="border-b border-line/60 px-2 py-1 hover:bg-raised">
              <div className="flex h-[22px] items-center gap-2">
                <StatusDot
                  tone={
                    item.state === 'confirmed' ? 'confirmed' : item.state === 'pending' ? 'pending' : 'idle'
                  }
                />
                <span className="min-w-0 flex-1 truncate text-body">{item.label}</span>
                <span className={cn('text-body', pass ? 'text-confirmed' : 'text-dim')}>
                  {item.score.toFixed(2)}
                </span>
                <span className="text-badge text-faint">{typeLabel(item.type)}</span>
              </div>
              <div className="flex h-4 items-center gap-2">
                <span className="text-badge text-faint">阈值</span>
                <input
                  type="range"
                  min={0.5}
                  max={1}
                  step={0.01}
                  value={item.threshold}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    updateThreshold(activeId, item.label, value); // 本地立即反馈
                    if (sessionReady) {
                      void pushThreshold(activeId, item.label, value); // 写回引擎
                    }
                  }}
                  className="h-1 flex-1 accent-[var(--brand)]"
                  title="拖动即时重算当前帧匹配分数"
                />
                <span className="w-8 text-right text-badge text-dim">{item.threshold.toFixed(2)}</span>
              </div>
            </div>
          );
        })}
        {recognizers.length === 0 && (
          <div className="px-3 py-6 text-center text-badge text-faint">
            还没有识别器 · 用「录制」框选画面元素
          </div>
        )}
      </div>
    </PanelShell>
  );
}

function typeLabel(type: RecognizerType): string {
  switch (type) {
    case 'template':
      return '模板';
    case 'color':
      return '颜色';
    default:
      return 'OCR';
  }
}
