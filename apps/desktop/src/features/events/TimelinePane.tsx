/**
 * 运行记录（时间轴 Tab）：最近一次运行的**每一步**——开始时的截图、实际参数、识别分数、耗时。
 *
 * 为什么不等"帧环形缓冲"：排查失败时真正要看的是"那一步看到了什么、传了什么参数"，
 * 帧序列只是中间过程。引擎每次运行都会把证据落到 `<工作流>/.runs/<时间戳>/`（见
 * `engine/src/gamepilot/core/evidence.py`），这里只是把它读出来。
 *
 * 截图按需取（点哪条取哪条）：一次运行几十步，全量拉 base64 会把界面拖慢。
 */
import { type ReactNode, useEffect, useState } from 'react';

import { GhostButton } from '@/layout/PanelShell';
import { evidenceImage, runEvidence, type RunEvidenceBundle, type RunEvidenceStep } from '@/lib/rpc';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';

function paramsText(step: RunEvidenceStep): string {
  if (!step.params || Object.keys(step.params).length === 0) {
    return '（这一步没有参数）';
  }
  return JSON.stringify(step.params, null, 2);
}

export function TimelinePane(): ReactNode {
  const activeId = useDeviceStore((state) => state.activeId);
  // 跑完自动刷新一次：`running` 是按设备存的（多开时各跑各的）
  const running = useSessionStore((state) => (activeId ? Boolean(state.running[activeId]) : false));
  const [bundle, setBundle] = useState<RunEvidenceBundle | null>(null);
  const [selected, setSelected] = useState<RunEvidenceStep | null>(null);
  const [shot, setShot] = useState<{ name: string; src: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // 拉证据：`running` 进依赖 = 跑完自动刷一次（运行中截图还在写，取到的会缺最后几步）
  useEffect(() => {
    if (!activeId) {
      return;
    }
    let cancelled = false;
    void runEvidence(activeId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setBundle(result.evidence);
        setError(null);
        setSelected((current) => {
          if (current && result.evidence?.steps.some((step) => step.ts === current.ts)) {
            return current;
          }
          return result.evidence?.steps.at(-1) ?? null;
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(String(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, running, reloadKey]);

  // 截图只在异步回调里落 state（effect 里同步 setState 会触发连锁渲染，lint 也拦）
  useEffect(() => {
    const name = selected?.screenshot;
    if (!activeId || !name) {
      return;
    }
    let cancelled = false;
    void evidenceImage(activeId, name)
      .then((result) => {
        if (!cancelled) {
          setShot({ name, src: `data:image/jpeg;base64,${result.jpeg}` });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeId, selected]);

  const shotSrc = shot && shot.name === selected?.screenshot ? shot.src : null;

  if (!bundle || bundle.steps.length === 0) {
    return (
      <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2 text-badge text-faint">
        <div className="flex items-center gap-2">
          <span className="text-dim">运行记录</span>
          <span className="flex-1" />
          <GhostButton onClick={() => setReloadKey((key) => key + 1)}>刷新</GhostButton>
        </div>
        <div>{error ?? '还没有运行记录：跑一次工作流，每一步的截图和参数会出现在这里。'}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-6 shrink-0 items-center gap-2 border-b border-line px-2 text-badge">
        <span className="text-dim">运行记录</span>
        <span className="truncate text-faint">{bundle.dir}</span>
        <span className="flex-1" />
        <span className="text-faint">{bundle.steps.length} 步</span>
        <GhostButton onClick={() => setReloadKey((key) => key + 1)}>刷新</GhostButton>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-64 shrink-0 overflow-auto border-r border-line">
          {bundle.steps.map((step) => (
            <button
              key={`${step.ts}-${step.stepId}`}
              type="button"
              data-testid="run-record-row"
              className={cn(
                'flex w-full items-baseline gap-1.5 px-2 py-1 text-left text-badge hover:bg-raised',
                selected?.ts === step.ts && 'bg-raised',
              )}
              onClick={() => setSelected(step)}
            >
              <span className="w-6 shrink-0 text-right text-faint">{step.index}</span>
              <span className="shrink-0 text-dim">{step.kind}</span>
              <span className="truncate">{step.message || step.result || step.stepId}</span>
              {typeof step.durationMs === 'number' && (
                <span className="ml-auto shrink-0 text-faint">{step.durationMs}ms</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-auto px-3 py-2 text-badge">
          {selected && (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-faint">
                <span>
                  第 <span className="text-dim">{selected.index}</span> 步 · {selected.kind}
                </span>
                <span>stepId {selected.stepId}</span>
                {typeof selected.score === 'number' && (
                  <span>
                    识别分数 <span className="text-dim">{selected.score.toFixed(3)}</span>
                  </span>
                )}
                {typeof selected.durationMs === 'number' && <span>耗时 {selected.durationMs}ms</span>}
              </div>
              {shotSrc && (
                <img
                  src={shotSrc}
                  alt={`第 ${selected.index} 步截图`}
                  className="mt-2 max-h-48 w-auto self-start border border-line"
                />
              )}
              {selected.message && <div className="mt-2 text-warn">{selected.message}</div>}
              <div className="mt-2 text-faint">参数</div>
              <pre className="mt-1 max-h-40 overflow-auto bg-raised px-2 py-1 text-badge text-dim">
                {paramsText(selected)}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
