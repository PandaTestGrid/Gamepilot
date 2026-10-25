/**
 * 录制草稿表单（DESIGN.md §4.4 第 ②~③ 步）：**图像模板**。
 *
 * 步骤链工作流：只注册识别器 + 素材（供点击/等待模块选用 `rec`）。
 * 旧状态图：仍可挂 enter / 动作目标 / 归属节点。
 *
 * 「文字识别」是另一种识别器，表单在 `OcrRecognizerDialog`（入口在素材区和录制工具栏），
 * 这里只保留图像匹配需要的字段，避免同一个浮层同时讲两套语义。
 */
import { Loader2, MousePointerSquareDashed, ScanLine, ScanText } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import {
  Check,
  DraftOverlayShell,
  type DraftAnchor,
  Field,
  Radio,
} from '@/features/device/DraftOverlayShell';
import { cn } from '@/lib/utils';
import { graphForDevice, useGraphStore } from '@/stores/graph.store';
import { useOcrStore } from '@/stores/ocr.store';
import { useUiStore } from '@/stores/ui.store';

function isFlowWorkflow(graph: ReturnType<typeof graphForDevice>): boolean {
  return (graph?.flow?.steps?.length ?? 0) > 0;
}

const PICK_SIZE_PRESETS = [
  { label: '64', value: 64 },
  { label: '96', value: 96 },
  { label: '120', value: 120 },
  { label: '160', value: 160 },
  { label: '200', value: 200 },
] as const;

export function RecordOverlay({
  deviceId,
  anchor,
}: {
  deviceId: string;
  anchor?: DraftAnchor | null;
}): ReactNode {
  const draft = useUiStore((state) => state.draft);
  const recordMode = useUiStore((state) => state.recordMode);
  const pickSize = useUiStore((state) => state.pickSize);
  const setPickSize = useUiStore((state) => state.setPickSize);
  const updateDraft = useUiStore((state) => state.updateDraft);
  const commitDraft = useUiStore((state) => state.commitDraft);
  const cancelDraft = useUiStore((state) => state.cancelDraft);
  const graph = useGraphStore((state) => graphForDevice(state, deviceId));
  const flowMode = isFlowWorkflow(graph);
  const ocrStatus = useOcrStore((state) => state.status);
  const recognizing = useOcrStore((state) => state.recognizing);
  const recognizeRegion = useOcrStore((state) => state.recognizeRegion);
  const cancelRecognize = useOcrStore((state) => state.cancelRecognize);
  const [ocrHint, setOcrHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isPick = (draft?.mode ?? (recordMode === 'pick' ? 'pick' : 'marquee')) === 'pick';

  const suggestion = useMemo(() => {
    const index = (graph?.recognizers.length ?? 0) + 1;
    return flowMode ? `region_${index}` : `${graph?.activeNodeId ?? 'main'}_region_${index}`;
  }, [graph, flowMode]);

  useEffect(() => {
    if (draft && !draft.label) {
      updateDraft({ label: suggestion });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!draft) {
    return null;
  }

  // 去掉「识别方式 / 要识别的文字」两行后的估算高度（只影响浮层往哪边翻）
  const PANEL_H = isPick ? (flowMode ? 240 : 330) : flowMode ? 185 : 275;

  const ModeIcon = isPick ? ScanLine : MousePointerSquareDashed;
  const modeTitle = isPick ? '点选素材' : '框选素材';
  // 以草稿实际 rect 为准：拖四角缩放后滑块/标题要跟着走，不能只看全局 pickSize。
  const draftPickPx =
    isPick && draft.resolution
      ? Math.max(
          32,
          Math.min(
            320,
            Math.round((draft.rect[2] * draft.resolution[0] + draft.rect[3] * draft.resolution[1]) / 2),
          ),
        )
      : pickSize;

  return (
    <DraftOverlayShell
      testId="record-overlay"
      anchor={anchor}
      panelH={PANEL_H}
      icon={<ModeIcon className="size-3.5" />}
      title={modeTitle}
      sizeText={
        isPick
          ? `${draftPickPx}×${draftPickPx} px`
          : `${draft.rect[2].toFixed(2)}×${draft.rect[3].toFixed(2)}`
      }
      onCancel={cancelDraft}
      onSubmit={commitDraft}
    >
      <Field label="名称">
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            autoFocus
            value={draft.label}
            placeholder="输入名称或点右侧 OCR"
            onChange={(event) => {
              setOcrHint(null);
              updateDraft({ label: event.target.value });
            }}
            className="h-6 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1.5 text-body focus:border-brand focus:outline-none"
          />
          <button
            type="button"
            data-testid="draft-ocr-btn"
            disabled={ocrStatus.state === 'downloading'}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (recognizing) {
                void cancelRecognize();
                return;
              }
              setOcrHint(null);
              void recognizeRegion(deviceId, draft.rect).then((text) => {
                if (text) {
                  updateDraft({ label: text, newNodeName: text });
                  inputRef.current?.focus();
                  inputRef.current?.select();
                } else {
                  setOcrHint(useOcrStore.getState().lastError ?? '选区内未识别到文字');
                }
              });
            }}
            title={
              ocrStatus.state === 'ready'
                ? 'OCR 识别选区文字并自动填入名称'
                : '首次使用将加载内置 PP-OCRv4 模型，随后识别选区文字填入名称'
            }
            className={cn(
              'flex h-6 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-badge whitespace-nowrap transition-colors',
              recognizing || ocrStatus.state === 'downloading'
                ? 'cursor-wait border-brand/50 bg-brand/15 text-brand'
                : 'border-line bg-raised text-fg hover:border-brand hover:bg-brand/20 hover:text-brand',
            )}
          >
            {recognizing || ocrStatus.state === 'downloading' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ScanText className="size-3" />
            )}
            {recognizing ? '停止' : 'OCR'}
          </button>
        </div>
        {ocrStatus.state === 'downloading' && (
          <div
            className="mt-1.5 rounded-sm border border-line bg-canvas p-1.5"
            data-testid="draft-ocr-progress"
          >
            <div className="mb-1 flex items-center justify-between text-[10px] text-dim">
              <span className="truncate">{ocrStatus.stage || '正在加载 OCR 模型…'}</span>
              <span className="ml-1 shrink-0 font-mono text-brand">{Math.round(ocrStatus.progress)}%</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-raised">
              <div
                className="h-full bg-brand transition-all duration-150"
                style={{ width: `${Math.max(4, Math.min(100, ocrStatus.progress))}%` }}
              />
            </div>
          </div>
        )}
        {ocrHint && ocrStatus.state !== 'downloading' && (
          <div className="mt-1 text-[10px] text-pending">{ocrHint}</div>
        )}
      </Field>

      {isPick && (
        <Field
          label={
            <div className="flex items-center justify-between">
              <span>点选范围 {draftPickPx}px</span>
              <div className="flex items-center gap-0.5">
                {PICK_SIZE_PRESETS.map((preset) => {
                  const active = Math.abs(draftPickPx - preset.value) < 1;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      title={`${preset.value}×${preset.value} px`}
                      data-testid={`pick-size-${preset.value}`}
                      onClick={() => setPickSize(preset.value)}
                      className={cn(
                        'rounded-sm px-1 py-0.5 text-[10px] leading-none',
                        active
                          ? 'bg-brand/20 font-medium text-brand'
                          : 'text-dim hover:bg-raised hover:text-fg',
                      )}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>
          }
        >
          <input
            type="range"
            aria-label="点选范围"
            min={32}
            max={320}
            step={8}
            value={draftPickPx}
            onChange={(event) => setPickSize(Number(event.target.value))}
            className="h-1 w-full accent-[var(--brand)]"
          />
          <p className="mt-1 text-[10px] leading-snug text-faint">
            方形 {draftPickPx}×{draftPickPx} px；要自由宽高用「框选」
          </p>
        </Field>
      )}

      <Field
        label={
          <div className="flex items-center justify-between">
            <span>匹配阈值 {draft.threshold.toFixed(2)}</span>
            <span
              className={cn(
                'font-mono text-badge',
                draft.score >= draft.threshold ? 'text-confirmed' : 'text-pending',
              )}
            >
              当前 {draft.score.toFixed(2)}
            </span>
          </div>
        }
      >
        <input
          type="range"
          min={0.5}
          max={1}
          step={0.01}
          value={draft.threshold}
          onChange={(event) => updateDraft({ threshold: Number(event.target.value) })}
          className="h-1 w-full accent-[var(--brand)]"
        />
      </Field>

      {!flowMode && (
        <>
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
        </>
      )}

      <div className="mt-2.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={commitDraft}
          className="h-6 flex-1 rounded-sm bg-brand text-body font-medium text-[#0b0d12] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          保存
        </button>
        <button
          type="button"
          onClick={cancelDraft}
          className="h-6 rounded-sm border border-line px-2.5 text-body text-dim hover:bg-raised hover:text-fg"
        >
          取消
        </button>
      </div>
    </DraftOverlayShell>
  );
}
