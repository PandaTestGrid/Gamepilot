/**
 * 识别器面板：缩略图位 + 实时分数 + 阈值现场调参（DESIGN.md §4.2 D）。
 *
 * 阈值滑块直接写回本地图（M2 起同时通过 RPC 让引擎按新阈值重算当帧分数，
 * 画面上的框会跟着变）——这就是「现场调参」的体感来源。
 */
import { type ReactNode, useRef } from 'react';

import { TemplateThumb } from '@/features/recognizers/TemplateThumb';
import { StatusDot } from '@/layout/PanelShell';
import { collectRecognizerUsage, describeRecognizerUsage } from '@/lib/recognizer-usage';
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
  const removeRecognizer = useSessionStore((state) => state.removeRecognizer);
  const sessionReady = useSessionStore((state) => Boolean(state.ready[activeId]));
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const recognizers = graph?.recognizers ?? [];

  return (
    // 右栏 Tab 的**内容**（Tab 头在 layout/RightColumn.tsx）：这里不再套 PanelShell，
    // 否则会出现"Tab 头 + 面板头"两层标题
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-6 shrink-0 items-center gap-2 border-b border-line px-2 text-badge text-faint">
        <span>阈值拖动即时重算当前帧分数</span>
        <span className="flex-1" />
        <span>{recognizers.length} 个</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {recognizers.map((item) => {
          const pass = item.score >= item.threshold;
          // 谁在用它：被引用着就删不掉（引擎会拒绝），所以按钮先置灰并写清原因，
          // 而不是让用户点一下再吃一个错误
          const usage = collectRecognizerUsage(graph, item.label);
          const blocked = usage.total > 0;
          const usageText = describeRecognizerUsage(usage);
          return (
            <div key={item.label} className="border-b border-line/60 px-2 py-1 hover:bg-raised">
              <div className="flex h-[30px] items-center gap-2">
                {item.type === 'template' && item.template ? (
                  <TemplateThumb label={item.label} />
                ) : (
                  <span
                    className="size-[26px] shrink-0 rounded-sm border border-line bg-raised"
                    title={item.type === 'color' ? '颜色识别器（纯色区域自动降级）' : 'OCR 识别器'}
                  />
                )}
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
                {/* 删除放在这里而不是画面上的读数列表：那一列是**实时监控**（分数每帧在跳），
                    销毁性操作摆在跳动的东西旁边，误点的代价太大。这里能同时看到缩略图、
                    阈值和"被谁引用"，是"看清代价再删"的地方 */}
                <button
                  type="button"
                  data-testid="recognizer-remove"
                  disabled={blocked}
                  aria-label={`删除 ${item.label}`}
                  title={
                    blocked
                      ? `删不掉：${usageText}。先到状态图里把这些引用去掉（节点的进入条件 / 边的判断条件 / 动作目标）`
                      : `删除 ${item.label}（模板文件一起删）`
                  }
                  onClick={() => {
                    void removeRecognizer(activeId, item.label);
                  }}
                  className={cn(
                    'h-5 shrink-0 rounded-sm border px-1 text-badge',
                    blocked
                      ? 'cursor-not-allowed border-line text-faint opacity-50'
                      : 'border-line text-failed hover:bg-raised',
                  )}
                >
                  删
                </button>
              </div>
              <div
                className={cn('mb-1 text-badge', blocked ? 'text-pending' : 'text-faint')}
                title={usageText}
              >
                {usageText}
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
                      // 拖动时防抖：松手 300ms 后才写回引擎，避免刷爆 RPC
                      const existing = timers.current.get(item.label);
                      if (existing) {
                        clearTimeout(existing);
                      }
                      timers.current.set(
                        item.label,
                        setTimeout(() => void pushThreshold(activeId, item.label, value), 300),
                      );
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
    </div>
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
