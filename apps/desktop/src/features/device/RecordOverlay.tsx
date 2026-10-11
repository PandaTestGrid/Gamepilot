/**
 * 录制草稿表单（DESIGN.md §4.4 第 ②~③ 步）。
 *
 * 框选松手后贴着选区弹出，**不遮画面中心**：一次交互内确定模板名、阈值、
 * 以及这次录制要注册成什么（状态判定 / 动作目标 / 归属哪个节点）。
 * 确定后由 ui.store 原子地写入「识别器 + 节点 + 边 + 事件」。
 */
import { type CSSProperties, type ReactNode, useEffect, useMemo } from 'react';

import { cn } from '@/lib/utils';
import { graphForDevice, useGraphStore } from '@/stores/graph.store';
import { useUiStore } from '@/stores/ui.store';

export function RecordOverlay({
  deviceId,
  anchor,
}: {
  deviceId: string;
  /** 选区的视口坐标矩形（弹框据此翻转，跟手） */
  anchor?: { left: number; top: number; width: number; height: number } | null;
}): ReactNode {
  const draft = useUiStore((state) => state.draft);
  const updateDraft = useUiStore((state) => state.updateDraft);
  const commitDraft = useUiStore((state) => state.commitDraft);
  const cancelDraft = useUiStore((state) => state.cancelDraft);
  const graph = useGraphStore((state) => graphForDevice(state, deviceId));

  const suggestion = useMemo(() => {
    const node = graph?.nodes.find((item) => item.id === graph.activeNodeId)?.id ?? 'main';
    const index = (graph?.recognizers.length ?? 0) + 1;
    return `${node}_region_${index}`;
  }, [graph]);

  // 打开即给一个可用的默认名（用户可以直接回车确认）
  useEffect(() => {
    if (draft && !draft.label) {
      updateDraft({ label: suggestion });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!draft) {
    return null;
  }

  // 选区在容器里的位置（取左上角），再夹进视口，保证弹框永远看得见
  const PANEL_W = 280;
  const PANEL_H = 300;
  const GAP = 8;
  const MARGIN = 8;

  /**
   * 弹框定位：**跟着选区**，只在放不下时才翻转/夹取（就像大多数工具的悬浮菜单）。
   *
   * 顺序：选区右侧 → 放不下翻到左侧 → 还不行就贴着选区水平夹取；
   * 垂直方向与选区顶对齐 → 下方放不下就改成底对齐（往上翻）。
   */
  const popoverStyle: CSSProperties = (() => {
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    if (!anchor) {
      // 拿不到选区位置（极端情况）：停在右上角，至少不挡手
      return { position: 'fixed', right: MARGIN, top: MARGIN };
    }
    let left = anchor.left + anchor.width + GAP;
    if (left + PANEL_W > viewportW - MARGIN) {
      left = anchor.left - PANEL_W - GAP; // 右侧放不下 → 翻到左侧
    }
    left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, viewportW - PANEL_W - MARGIN));

    let top = anchor.top;
    if (top + PANEL_H > viewportH - MARGIN) {
      top = anchor.top + anchor.height - PANEL_H; // 下方放不下 → 往上翻（底对齐）
    }
    top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, viewportH - PANEL_H - MARGIN));
    return { position: 'fixed', left, top, maxHeight: viewportH - 2 * MARGIN, overflowY: 'auto' };
  })();

  return (
    <div
      className={cn(
        'fixed z-50 w-[268px] rounded-sm border border-line bg-panel p-2 text-body shadow-lg',
        'border-l-2 border-l-brand',
      )}
      style={popoverStyle}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          cancelDraft();
        }
        if (event.key === 'Enter') {
          commitDraft();
        }
      }}
      role="presentation"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-panelhead font-medium">录制</span>
        <span className="text-badge text-faint">
          {draft.rect[2].toFixed(3)} × {draft.rect[3].toFixed(3)}
        </span>
        <div className="flex-1" />
        <button type="button" onClick={cancelDraft} className="text-dim hover:text-fg">
          ✕
        </button>
      </div>

      <Field label="模板名">
        <input
          autoFocus
          value={draft.label}
          onChange={(event) => updateDraft({ label: event.target.value })}
          className="h-6 w-full rounded-sm border border-line bg-canvas px-1.5 text-body focus:border-brand focus:outline-none"
        />
      </Field>

      <Field label={`阈值 ${draft.threshold.toFixed(2)}`}>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0.5}
            max={1}
            step={0.01}
            value={draft.threshold}
            onChange={(event) => updateDraft({ threshold: Number(event.target.value) })}
            className="h-1 flex-1 accent-[var(--brand)]"
          />
          <span
            className={cn('text-badge', draft.score >= draft.threshold ? 'text-confirmed' : 'text-pending')}
          >
            本帧 {draft.score.toFixed(2)}
          </span>
        </div>
      </Field>

      <Field label="注册为">
        <div className="flex gap-2">
          <Check
            checked={draft.asEnter}
            onChange={(checked) => updateDraft({ asEnter: checked })}
            label="状态判定 enter"
          />
          <Check
            checked={draft.asActionTarget}
            onChange={(checked) => updateDraft({ asActionTarget: checked })}
            label="动作目标"
          />
        </div>
      </Field>

      <Field label="归属节点">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Radio
              checked={draft.targetMode === 'new'}
              onChange={() => updateDraft({ targetMode: 'new' })}
              label="新建节点"
            />
            <input
              value={draft.newNodeName}
              onChange={(event) => updateDraft({ newNodeName: event.target.value })}
              disabled={draft.targetMode !== 'new'}
              className="h-6 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1.5 text-body disabled:opacity-40 focus:border-brand focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <Radio
              checked={draft.targetMode === 'existing'}
              onChange={() =>
                updateDraft({ targetMode: 'existing', targetNodeId: graph?.activeNodeId ?? null })
              }
              label="现有节点"
            />
            <select
              value={draft.targetNodeId ?? ''}
              onChange={(event) => updateDraft({ targetNodeId: event.target.value })}
              disabled={draft.targetMode !== 'existing'}
              className="h-6 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1 text-body disabled:opacity-40 focus:border-brand focus:outline-none"
            >
              <option value="">（选择）</option>
              {(graph?.nodes ?? []).map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name} ({node.id})
                </option>
              ))}
            </select>
          </div>
        </div>
      </Field>

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={commitDraft}
          className="h-6 flex-1 rounded-sm bg-brand text-body font-medium text-[#0b0d12] hover:opacity-90"
        >
          确定并写入状态图
        </button>
        <button
          type="button"
          onClick={cancelDraft}
          className="h-6 rounded-sm px-2 text-body text-dim hover:bg-raised"
        >
          取消
        </button>
      </div>
      <p className="mt-1 text-badge text-faint">Enter 确认 · Esc 取消 · ⌘Z 撤销整个录制</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="mb-1.5">
      <div className="mb-0.5 text-badge text-faint">{label}</div>
      {children}
    </div>
  );
}

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}): ReactNode {
  return (
    <label className="flex cursor-pointer items-center gap-1 text-badge text-dim">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-3 accent-[var(--brand)]"
      />
      {label}
    </label>
  );
}

function Radio({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}): ReactNode {
  return (
    <label className="flex w-16 cursor-pointer items-center gap-1 text-badge text-dim">
      <input type="radio" checked={checked} onChange={onChange} className="size-3 accent-[var(--brand)]" />
      {label}
    </label>
  );
}
