/**
 * 识别器选择：节点内只展示当前图 + 按钮；点开后浮层网格看图点选（Automa 式磁贴）。
 * 详情配置区（`showThreshold` / `previewSide`）在「更换 / 录制」下方提供该图像模板的匹配阈值配置。
 * 搜索范围只在步骤上配置（StepSearchScope）；录制时不再设模板默认值。
 */
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImageIcon, Pencil, ScanLine, ScanText } from 'lucide-react';

import { YoloRecognizerDialog } from '@/features/device/YoloRecognizerDialog';

import { RecognizerInlinePreview } from '@/features/recognizers/RecognizerInlinePreview';
import { YoloExampleGallery } from '@/features/recognizers/YoloExampleGallery';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { graphForDevice, SCRIPT_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useTemplateStore } from '@/stores/template.store';
import { useUiStore } from '@/stores/ui.store';

function TemplateGridTile({
  label,
  selected,
  imageHeight,
  onPick,
  kind,
  deviceId,
  examplesCount,
  revision,
  hasWorkflow,
}: {
  label: string;
  selected: boolean;
  imageHeight: number;
  onPick: () => void;
  /** AI 使用标记范围裁剪图，其他类型保留模板预览。 */
  kind?: 'template' | 'color' | 'ocr' | 'yolo';
  deviceId: string;
  examplesCount?: number;
  revision: string;
  hasWorkflow: boolean;
}): ReactNode {
  const key = `${label}:color`;
  const entry = useTemplateStore((state) => state.entries[key]);
  const load = useTemplateStore((state) => state.load);

  const isYolo = kind === 'yolo';
  useEffect(() => {
    if (!isYolo) {
      load(label, false);
    }
  }, [label, load, isYolo]);

  return (
    <button
      type="button"
      aria-label={`选择 ${label}`}
      aria-pressed={selected}
      onClick={(event) => {
        event.stopPropagation();
        onPick();
      }}
      className={cn(
        'nodrag nopan flex flex-col overflow-hidden rounded-sm border bg-canvas text-left transition-colors hover:border-brand/60 hover:bg-raised',
        selected ? 'border-brand ring-1 ring-brand/50' : 'border-line',
      )}
    >
      <span
        className="flex w-full items-center justify-center border-b border-line bg-panel/80 p-1"
        style={{ height: imageHeight }}
      >
        {isYolo ? (
          deviceId || hasWorkflow ? (
            <YoloExampleGallery
              deviceId={deviceId}
              label={label}
              examplesCount={examplesCount}
              revision={revision}
              presentation="tile"
              tileSize={imageHeight - 8}
              emptyHint="暂无标记图片"
            />
          ) : <span className="text-[10px] text-dim">未连接设备</span>
        ) : entry?.url ? (
          <img
            src={entry.url}
            alt={label}
            style={{ imageRendering: 'pixelated', maxHeight: imageHeight - 8, maxWidth: '100%' }}
            className="object-contain"
          />
        ) : (
          <span className="text-[10px] text-faint">{entry?.error ? '加载失败' : '…'}</span>
        )}
      </span>
      <span className="truncate px-1 py-0.5 text-center text-[10px] text-dim">{label}</span>
    </button>
  );
}

function PickerPopover({
  anchor,
  labels,
  value,
  compact,
  revision,
  onPick,
  onClose,
}: {
  anchor: DOMRect;
  labels: readonly string[];
  value: string;
  compact: boolean;
  revision: string;
  onPick: (label: string) => void;
  onClose: () => void;
}): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: anchor.bottom + 6, left: anchor.left, width: compact ? 248 : 300 });

  const load = useTemplateStore((state) => state.load);
  const activeId = useDeviceStore((state) => state.activeId);
  const workflowRoot = useSessionStore((state) => state.currentWorkflow?.root ?? '');
  const graph = useGraphStore((state) => graphForDevice(state, activeId));
  const recognizerOf = (label: string) => graph?.recognizers.find((item) => item.label === label);

  useEffect(() => {
    for (const label of labels) {
      if (recognizerOf(label)?.type !== 'yolo') {
        load(label, false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, load]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const margin = 8;
    const width = compact ? 248 : 300;
    let left = anchor.left;
    let top = anchor.bottom + 6;
    const maxHeight = Math.min(360, window.innerHeight * 0.55);
    if (left + width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - width - margin);
    }
    if (top + maxHeight > window.innerHeight - margin) {
      top = Math.max(margin, anchor.top - maxHeight - 6);
    }
    setPos({ top, left, width });
  }, [anchor, compact]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const imageHeight = compact ? 52 : 64;
  const cols = compact ? 2 : 3;

  return createPortal(
    <>
      <button
        type="button"
        aria-label="关闭"
        className="fixed inset-0 z-[9998] cursor-default bg-canvas/40"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="选择图像模板"
        className="fixed z-[9999] flex max-h-[min(360px,55vh)] flex-col overflow-hidden rounded-sm border border-line bg-panel shadow-lg"
        style={{ top: pos.top, left: pos.left, width: pos.width }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-line px-2 py-1 text-[11px] text-dim">点选识别器 · Esc 关闭</div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {labels.map((label) => (
              <TemplateGridTile
                key={label}
                label={label}
                selected={value === label}
                imageHeight={imageHeight}
                kind={recognizerOf(label)?.type}
                deviceId={activeId}
                examplesCount={recognizerOf(label)?.examplesCount}
                revision={revision}
                hasWorkflow={Boolean(workflowRoot)}
                onPick={() => onPick(label)}
              />
            ))}
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

export function RecognizerPicker({
  value,
  labels,
  onChange,
  flowStepId,
  flowRecSlot,
  compact = false,
  previewMaxHeight,
  previewSide = false,
  showThreshold = previewSide,
  className,
}: {
  value: string;
  labels: readonly string[];
  onChange: (label: string) => void;
  /** 传入则显示「录制」并在录完后自动写入该步骤 */
  flowStepId?: string;
  /** 条件判断多条件时指定录制写入哪一组哪一行 */
  flowRecSlot?: { readonly groupIndex: number; readonly rowIndex: number };
  compact?: boolean;
  /** 覆盖内嵌预览高度（像素） */
  previewMaxHeight?: number;
  /** 详情栏：图像配置模式（预览 + 更换/录制 + 阈值调节） */
  previewSide?: boolean;
  /** 是否在更换/录制按钮下方显示匹配阈值滑块（详情栏默认开启） */
  showThreshold?: boolean;
  className?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [editingAi, setEditingAi] = useState(false);
  const [galleryRevision, setGalleryRevision] = useState(0);
  const workflowRoot = useSessionStore((state) => state.currentWorkflow?.root ?? '');
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recordMode = useUiStore((state) => state.recordMode);
  const pendingStepId = useUiStore((state) => state.pendingFlowRecStepId);
  const pendingSlot = useUiStore((state) => state.pendingFlowRecSlot);
  const beginRecord = useUiStore((state) => state.beginRecordRecognizerForFlowStep);
  const beginOcr = useUiStore((state) => state.beginOcrRecognizerCapture);
  const recordKind = useUiStore((state) => state.recordKind);
  const slotMatches =
    !flowRecSlot ||
    (pendingSlot?.groupIndex === flowRecSlot.groupIndex && pendingSlot?.rowIndex === flowRecSlot.rowIndex);
  const recordingThisStep = Boolean(
    flowStepId && pendingStepId === flowStepId && slotMatches && recordMode !== 'off',
  );
  const recordingTemplate = recordingThisStep && recordKind !== 'ocr';
  const recordingOcr = recordingThisStep && recordKind === 'ocr';

  const activeId = useDeviceStore((state) => state.activeId);
  const graph = useGraphStore((state) => graphForDevice(state, activeId));
  const updateThreshold = useGraphStore((state) => state.updateRecognizerThreshold);
  const pushThreshold = useSessionStore((state) => state.setThreshold);
  const recognizer = graph?.recognizers.find((item) => item.label === value);
  const isColor = recognizer?.type === 'color';
  const isYolo = recognizer?.type === 'yolo';
  const threshold = recognizer?.threshold ?? (isYolo ? 0.3 : 0.82);
  // OCR 识别器没有"模板长什么样"这回事，预览要改成"读哪段字"（见 RecognizerInlinePreview）
  const ocrText = recognizer?.type === 'ocr' ? (recognizer.text ?? '') : undefined;
  const yoloClasses = isYolo ? (recognizer.classes ?? []) : undefined;

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const handleThresholdChange = (nextRaw: number): void => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    const clamped = Math.min(1, Math.max(isYolo ? 0.05 : 0.5, Number(nextRaw.toFixed(2))));
    updateThreshold(activeId, trimmed, clamped);
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      void pushThreshold(activeId, trimmed, clamped);
    }, 250);
  };

  const openPicker = useCallback(() => {
    if (labels.length === 0) {
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchorRect(rect);
      setOpen(true);
    }
  }, [labels.length]);

  const closePicker = useCallback(() => {
    setOpen(false);
    setAnchorRect(null);
  }, []);

  const handlePick = useCallback(
    (label: string) => {
      onChange(label);
      closePicker();
    },
    [closePicker, onChange],
  );

  const previewHeight = previewMaxHeight ?? (previewSide ? 120 : compact ? 80 : 112);

  const preview = (
    <RecognizerInlinePreview
      label={value}
      maxHeight={previewHeight}
      className="w-full"
      emptyHint="点下方按钮选择识别器"
      ocrText={ocrText}
      yoloClasses={yoloClasses}
      deviceId={activeId ?? SCRIPT_SCOPE}
      yoloExamplesCount={recognizer?.examplesCount}
      yoloRevision={`${workflowRoot}:${galleryRevision}`}
      compact={compact}
    />
  );

  const controls = (
    <>
      <div className="flex gap-1">
        <button
          ref={triggerRef}
          type="button"
          disabled={labels.length === 0}
          title={
            labels.length === 0
              ? '当前工作流还没有已录制的模板，请先点右侧「录制」在画面中框选'
              : '从当前工作流的识别器中选择（图像、AI 或文字）'
          }
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            openPicker();
          }}
          className={cn(
            'nodrag nopan flex min-w-0 flex-1 items-center justify-center gap-1 rounded-sm border border-line bg-canvas text-dim hover:border-brand/50 hover:bg-raised hover:text-fg disabled:opacity-40',
            compact ? 'px-1 py-0.5 text-[10px]' : 'px-1.5 py-1 text-badge',
          )}
        >
          <ImageIcon className="size-3 shrink-0" strokeWidth={1.75} />
          {value ? (isYolo && !compact ? '更换识别器' : '更换') : '选择'}
        </button>
        {isYolo ? (
          <button
            type="button"
            disabled={!activeId}
            data-testid="recognizer-edit-ai"
            title="编辑此 AI 识别器的标记图片、置信度与推理参数"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              closePicker();
              setEditingAi(true);
            }}
            className={cn(
              'nodrag nopan flex min-w-0 flex-1 items-center justify-center gap-1 rounded-sm border border-line bg-canvas text-brand hover:border-brand/50 hover:bg-raised focus-visible:outline-2 focus-visible:outline-brand',
              compact ? 'px-1 py-0.5 text-[10px]' : 'px-1.5 py-1 text-badge',
            )}
          >
            <Pencil className="size-3 shrink-0" strokeWidth={1.75} />
            {compact ? '编辑 AI' : '编辑 AI 识别器'}
          </button>
        ) : flowStepId ? (
          <>
            <button
              type="button"
              data-capture-keep
              title="在画面栏框选新模板，确认后自动填入本条件槽位"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                closePicker();
                beginRecord(flowStepId, flowRecSlot);
              }}
              className={cn(
                'nodrag nopan flex shrink-0 items-center justify-center gap-0.5 rounded-sm border hover:bg-raised',
                recordingTemplate
                  ? 'border-brand bg-active text-brand'
                  : 'border-line bg-canvas text-dim hover:border-brand/50 hover:text-fg',
                compact ? 'px-1 py-0.5 text-[10px]' : 'px-1.5 py-1 text-badge',
              )}
            >
              <ScanLine className="size-3 shrink-0" strokeWidth={1.75} />
              录制
            </button>
            {/* 同一个槽位也能录「文字识别」：OCR 是独立识别器，但填进条件的规则一样 */}
            <button
              type="button"
              data-capture-keep
              data-testid="recognizer-record-ocr"
              title="在画面栏框出要读字的区域，保存后自动填入本条件槽位"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                closePicker();
                beginOcr({ stepId: flowStepId, slot: flowRecSlot });
              }}
              className={cn(
                'nodrag nopan flex shrink-0 items-center justify-center gap-0.5 rounded-sm border hover:bg-raised',
                recordingOcr
                  ? 'border-brand bg-active text-brand'
                  : 'border-line bg-canvas text-dim hover:border-brand/50 hover:text-fg',
                compact ? 'px-1 py-0.5 text-[10px]' : 'px-1.5 py-1 text-badge',
              )}
            >
              <ScanText className="size-3 shrink-0" strokeWidth={1.75} />
              读字
            </button>
          </>
        ) : null}
      </div>

      {showThreshold && value.trim() ? (
        <div
          className={cn('flex items-center gap-2 pt-0.5', compact ? 'text-[10px]' : 'text-badge')}
          data-testid="recognizer-threshold-control"
        >
          <span className="shrink-0 text-dim">{isYolo ? 'AI 置信度' : '阈值'}</span>
          <input
            type="range"
            min={isYolo ? 0.05 : 0.5}
            max={1}
            step={0.01}
            value={threshold}
            aria-label={`${value} 阈值`}
            data-testid="recognizer-threshold-slider"
            onChange={(event) => handleThresholdChange(Number(event.target.value))}
            className="nodrag nopan h-1 flex-1 accent-[var(--brand)]"
            title={isYolo
              ? 'AI 置信度（0.05 ~ 1.00），越高越严格；当前工作流内引用此识别器的步骤共用'
              : '调整该图像模板的匹配阈值（0.50 ~ 1.00，越高越严格）'}
          />
          <input
            type="number"
            min={isYolo ? 0.05 : 0.5}
            max={1}
            step={0.01}
            value={Number(threshold.toFixed(2))}
            aria-label={`${value} 阈值数值`}
            data-testid="recognizer-threshold-input"
            onChange={(event) => {
              const num = Number(event.target.value);
              if (Number.isFinite(num)) {
                handleThresholdChange(num);
              }
            }}
            className="nodrag nopan h-5 w-14 rounded-sm border border-line bg-canvas px-1 text-right font-mono text-badge text-fg focus:border-brand focus:outline-none"
          />
        </div>
      ) : null}

      {isYolo && showThreshold ? (
        <p className="text-[10px] leading-snug text-dim">
          越高越严格；当前工作流内引用此识别器的步骤共用。
        </p>
      ) : null}

      {recognizer?.recordedSize && !isColor && !isYolo ? (
        <p className="text-[10px] leading-snug text-faint">
          换分辨率会自动缩放（录制于 {recognizer.recordedSize[0]}×{recognizer.recordedSize[1]}）
        </p>
      ) : null}

      {recordingThisStep ? (
        <p className="text-[10px] leading-snug text-brand">请在画面栏拖框选区域，确认后写入本模块</p>
      ) : null}

      {labels.length === 0 ? (
        <p className="text-[10px] text-faint">
          {flowStepId ? '暂无模板，请点「录制」在画面栏框选。' : '暂无识别器，请先在画面栏录制模板。'}
        </p>
      ) : null}
    </>
  );

  return (
    <div className={cn('nodrag nopan space-y-1', className)} data-testid="recognizer-picker">
      {isYolo && !compact ? (
        <div className="flex min-w-0 items-center justify-between gap-2 pb-1 text-badge">
          <span className="truncate font-medium text-fg" title={value}>{value}</span>
          <span className="shrink-0 text-dim">{recognizer?.examplesCount ?? 0} 张标记图片</span>
        </div>
      ) : null}
      {preview}
      {controls}

      {editingAi && activeId && isYolo ? createPortal(
        <div className="nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
          <YoloRecognizerDialog
            deviceId={activeId}
            open
            editLabel={value}
            onClose={() => {
              setEditingAi(false);
              setGalleryRevision((revision) => revision + 1);
            }}
          />
        </div>,
        document.body,
      ) : null}

      {open && anchorRect ? (
        <PickerPopover
          anchor={anchorRect}
          labels={labels}
          value={value}
          compact={compact}
          revision={`${workflowRoot}:${galleryRevision}`}
          onPick={handlePick}
          onClose={closePicker}
        />
      ) : null}
    </div>
  );
}
