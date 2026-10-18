/**
 * 文字识别（OCR）识别器的录制草稿。
 *
 * 它和「图像模板」是同一层的东西 —— 都是**识别器**，都能被步骤/条件/点击目标引用，
 * 只是"怎么认"不同：模板认这张图，OCR 认框里的字。所以入口放在素材区/工具栏的
 * 「文字识别」，不再塞进图像模板的录制浮层里（同一个浮层两种语义，表单会越来越长）。
 *
 * 框选交互仍由画面栏负责（`DraftSelectionBox`）；这里只填识别本身的参数。
 */
import { ScanText } from 'lucide-react';
import { type ReactNode, useEffect, useMemo } from 'react';

import {
  Check,
  DraftOverlayShell,
  type DraftAnchor,
  Field,
  Radio,
} from '@/features/device/DraftOverlayShell';
import { graphForDevice, useGraphStore } from '@/stores/graph.store';
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

export function OcrRecognizerDialog({
  deviceId,
  anchor,
}: {
  deviceId: string;
  anchor?: DraftAnchor | null;
}): ReactNode {
  const draft = useUiStore((state) => state.draft);
  const pickSize = useUiStore((state) => state.pickSize);
  const setPickSize = useUiStore((state) => state.setPickSize);
  const updateDraft = useUiStore((state) => state.updateDraft);
  const commitDraft = useUiStore((state) => state.commitDraft);
  const cancelDraft = useUiStore((state) => state.cancelDraft);
  const graph = useGraphStore((state) => graphForDevice(state, deviceId));
  const flowMode = isFlowWorkflow(graph);

  const isPick = draft?.mode === 'pick';

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

  const text = draft.text ?? '';
  const canSave = text.trim().length > 0;
  // OCR 比模板多一行「要识别的文字」、少一行「识别方式」；点选时多一行范围
  const panelH = isPick ? (flowMode ? 260 : 360) : flowMode ? 210 : 310;

  return (
    <DraftOverlayShell
      testId="ocr-recognizer-dialog"
      anchor={anchor}
      panelH={panelH}
      icon={<ScanText className="size-3.5" />}
      title="文字识别"
      sizeText={
        isPick
          ? `${draftPickPx}×${draftPickPx} px`
          : `${draft.rect[2].toFixed(2)}×${draft.rect[3].toFixed(2)}`
      }
      onCancel={cancelDraft}
      onSubmit={() => {
        if (canSave) {
          commitDraft();
        }
      }}
    >
      <Field label="名称">
        <input
          value={draft.label}
          placeholder="给这个识别器起个名字"
          onChange={(event) => updateDraft({ label: event.target.value })}
          className="h-6 w-full rounded-sm border border-line bg-canvas px-1.5 text-body focus:border-brand focus:outline-none"
        />
        <p className="mt-1 text-[10px] leading-snug text-faint">
          名称只用于素材区和步骤里指代它；真正要认的字填在下面。
        </p>
      </Field>

      <Field label="要识别的文字">
        <div className="flex items-center gap-1">
          <input
            data-testid="draft-ocr-text"
            autoFocus
            value={text}
            placeholder="例如：领取奖励"
            onChange={(event) => updateDraft({ text: event.target.value })}
            className="h-6 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1.5 text-body focus:border-brand focus:outline-none"
          />
          <select
            data-testid="draft-ocr-mode"
            value={draft.ocrMode ?? 'contains'}
            onChange={(event) =>
              updateDraft({ ocrMode: event.target.value === 'equals' ? 'equals' : 'contains' })
            }
            title="包含：识别到的文字里有关键字就算命中；相等：整段文字完全一致"
            className="h-6 shrink-0 rounded-sm border border-line bg-canvas px-1 text-badge text-fg focus:border-brand focus:outline-none"
          >
            <option value="contains">包含</option>
            <option value="equals">相等</option>
          </select>
        </div>
        {!canSave ? (
          <div className="mt-1 text-[10px] text-pending">填了要识别的文字才能保存</div>
        ) : (
          <p className="mt-1 text-[10px] leading-snug text-faint">
            框住文字出现的位置；整段文案会变时用「包含」只认关键词。
          </p>
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
                      className={
                        active
                          ? 'rounded-sm bg-brand/20 px-1 py-0.5 text-[10px] leading-none font-medium text-brand'
                          : 'rounded-sm px-1 py-0.5 text-[10px] leading-none text-dim hover:bg-raised hover:text-fg'
                      }
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
            <span>置信度阈值 {draft.threshold.toFixed(2)}</span>
            <span
              className={
                draft.score >= draft.threshold
                  ? 'font-mono text-badge text-confirmed'
                  : 'font-mono text-badge text-pending'
              }
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
        <p className="mt-1 text-[10px] leading-snug text-faint">
          文字识别的分数整体偏低，0.6 左右通常够用；调高只认更确定的文字。
        </p>
      </Field>

      <Field
        label={
          <div className="flex items-center justify-between gap-2">
            <span className="shrink-0">搜索范围</span>
            <span className="shrink-0 text-[10px] text-faint">
              {draft.search === 'full' ? '整帧搜索' : '只在框选区'}
            </span>
          </div>
        }
      >
        <div className="space-y-1" data-testid="draft-search-control">
          <Check
            checked={draft.search === 'full'}
            onChange={(checked) => updateDraft({ search: checked ? 'full' : 'region' })}
            label="全屏"
          />
          <p className="text-[10px] leading-snug text-faint">
            框得越小越准；整帧搜索更慢，也容易撞到别处的同一句话。
          </p>
        </div>
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
          disabled={!canSave}
          title={canSave ? undefined : '先填写要识别的文字'}
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
