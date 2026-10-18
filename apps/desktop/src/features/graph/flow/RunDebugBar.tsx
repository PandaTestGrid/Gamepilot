/**
 * 断点暂停横幅：停在哪一步 + 继续 / 单步 / 停止。
 *
 * 只在**当前设备确实被断点挡住**时出现（`session.paused[deviceId]` 由引擎的
 * `breakpoint_hit` 事件驱动）。暂停时引擎不再 tick 步骤链，所以这里必须给出
 * 继续的入口 —— 否则界面看起来就是"卡住了"。
 */
import { Pause, Play, SkipForward, Square } from 'lucide-react';
import { type ReactNode } from 'react';

import { flowStepTitle } from '@/features/graph/flow/flow-step-meta';
import { activeDevice, useDeviceStore } from '@/stores/device.store';
import { graphForDevice, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';

export function RunDebugBar({ readOnly = false }: { readOnly?: boolean }): ReactNode {
  const activeId = useDeviceStore((state) => state.activeId);
  const devices = useDeviceStore((state) => state.devices);
  const pausedAt = useSessionStore((state) => (activeId ? (state.paused[activeId] ?? null) : null));
  const graph = useGraphStore((state) => graphForDevice(state, activeId));
  const resumeRun = useSessionStore((state) => state.resumeRun);
  const stepRun = useSessionStore((state) => state.stepRun);
  const stopRun = useSessionStore((state) => state.stopRun);

  const device = activeDevice(devices, activeId);
  if (readOnly || !activeId || !pausedAt || !device) {
    return null;
  }

  const steps = graph?.flow?.steps ?? [];
  const index = steps.findIndex((step) => step.id === pausedAt);
  const step = index >= 0 ? steps[index] : null;
  const label = step ? flowStepTitle(step) : pausedAt;

  const buttonClass =
    'inline-flex items-center gap-1 rounded-sm border border-line bg-canvas px-1.5 py-0.5 text-xs text-dim hover:border-brand hover:text-brand';

  return (
    <div
      data-testid="flow-debug-bar"
      className="absolute bottom-8 left-2 z-10 flex max-w-[90%] items-center gap-2 rounded-sm border border-warn/60 bg-panel/95 px-2 py-1 text-badge shadow-md"
    >
      <Pause className="size-3.5 shrink-0 text-warn" strokeWidth={2} />
      <span className="min-w-0 truncate text-warn">
        已暂停{index >= 0 ? ` · 第 ${index + 1} 步` : ''} · {label}
      </span>
      <button
        type="button"
        data-testid="flow-debug-resume"
        className={buttonClass}
        title="继续跑（Ctrl+F8）"
        onClick={() => void resumeRun(activeId)}
      >
        <Play className="size-3" strokeWidth={2} />
        继续
      </button>
      <button
        type="button"
        data-testid="flow-debug-step"
        className={buttonClass}
        title="单步：执行完这一步，进入下一步前再停"
        onClick={() => void stepRun(activeId)}
      >
        <SkipForward className="size-3" strokeWidth={2} />
        单步
      </button>
      <button
        type="button"
        data-testid="flow-debug-stop"
        className="inline-flex items-center gap-1 rounded-sm border border-line bg-canvas px-1.5 py-0.5 text-xs text-dim hover:border-failed hover:text-failed"
        title="停止运行"
        onClick={() => void stopRun(activeId)}
      >
        <Square className="size-3 fill-current" strokeWidth={2} />
        停止
      </button>
    </div>
  );
}
