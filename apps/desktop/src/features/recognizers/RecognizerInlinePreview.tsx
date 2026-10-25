/**
 * 节点/表单内嵌的识别器模板预览（走 template.store 缓存，不抢画布拖动手势）。
 */
import { type ReactNode, useEffect } from 'react';

import { YoloExampleGallery } from '@/features/recognizers/YoloExampleGallery';
import { cn } from '@/lib/utils';
import { useTemplateStore } from '@/stores/template.store';

export function RecognizerInlinePreview({
  label,
  maxHeight = 96,
  className,
  onRetryClick,
  emptyHint = '选择图像模板后在此预览',
  ocrText,
  yoloClasses,
  deviceId,
  yoloExamplesCount,
  yoloRevision,
  compact = true,
}: {
  label: string;
  maxHeight?: number;
  className?: string;
  /** 为 true 时失败态可点击重试（需包在 nodrag 容器里） */
  onRetryClick?: () => void;
  emptyHint?: string;
  /**
   * OCR 识别器要认的文字（`type === 'ocr'` 才传）。
   * 传了它就按"读这段字"渲染：没截图也能说清这个识别器在认什么，
   * 不用去学模板卡片的样子显示一个没有意义的「…」占位。
   */
  ocrText?: string;
  /** YOLO 类别，仅在此类型传入；优先预览真实标记图片，不读取模板。 */
  yoloClasses?: readonly string[];
  deviceId?: string;
  yoloExamplesCount?: number;
  /** 保存后递增，与素材区使用相同版本以共享请求/缓存。 */
  yoloRevision?: number | string;
  /** 节点精简模式最多三张；侧栏传 false 展示全部图片。 */
  compact?: boolean;
}): ReactNode {
  const key = `${label}:color`;
  const entry = useTemplateStore((state) => state.entries[key]);
  const load = useTemplateStore((state) => state.load);
  const retry = useTemplateStore((state) => state.retry);

  const isYolo = yoloClasses !== undefined;
  useEffect(() => {
    if (label.trim() && !isYolo) {
      load(label, false);
    }
  }, [label, load, isYolo]);

  if (!label.trim()) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-sm border border-dashed border-line bg-canvas/80 text-[10px] text-faint',
          className,
        )}
        style={{ minHeight: Math.min(56, maxHeight), maxHeight }}
      >
        {emptyHint}
      </div>
    );
  }

  if (isYolo) {
    const classes = [...new Set(yoloClasses.map((value) => value.trim()).filter(Boolean))];
    // 内部素材标签不是类别说明，不在预览中再复述一次 ai_12。
    const namedClasses = classes.filter((value) => value !== label);
    const visibleClasses = compact ? namedClasses.slice(0, 3) : namedClasses;
    const classesCaption = visibleClasses.join(' / ')
      + (compact && namedClasses.length > 3 ? ` 等 ${namedClasses.length} 类` : '');
    const classOnlyHint = classes.length ? '暂无标记图片 · 按类别名称识别' : '暂无标记图片 · 尚未设置类别';
    return (
      <div className={cn('min-w-0 space-y-1.5', className)}>
        {deviceId?.trim() ? (
          <YoloExampleGallery
            deviceId={deviceId}
            label={label}
            examplesCount={yoloExamplesCount}
            revision={yoloRevision}
            compact={compact}
            maxHeight={maxHeight}
            emptyHint={classOnlyHint}
          />
        ) : (
          <p className="text-[11px] text-dim">未连接设备 · 无法加载标记图片</p>
        )}
        {classesCaption && (
          <p className="break-words text-[11px] text-dim" title={namedClasses.join(' / ')}>
            {compact ? '类别：' : '识别类别：'}{classesCaption}
          </p>
        )}
      </div>
    );
  }

  const src = entry?.url;
  const failed = Boolean(entry?.error) && !src;
  const loading = entry?.loading && !src;
  const isOcr = ocrText !== undefined;
  const caption = isOcr
    ? ocrText
      ? `读「${ocrText}」`
      : '还没填要识别的文字'
    : label;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-sm border bg-canvas',
        failed ? 'border-failed/50' : 'border-line',
        isOcr && 'border-brand/30',
        className,
      )}
      style={{ maxHeight }}
    >
      {src ? (
        <img
          src={src}
          alt={label}
          style={{ imageRendering: 'pixelated', maxHeight, width: '100%' }}
          className="mx-auto block object-contain"
        />
      ) : isOcr ? (
        // 没有证据截图（老图 / 刚建还没刷新）也能看懂：直接亮出要认的字
        <div
          style={{ minHeight: Math.min(56, maxHeight), maxHeight }}
          className="flex w-full flex-col items-center justify-center gap-0.5 px-2 text-center"
        >
          <span className="line-clamp-2 text-[11px] leading-snug text-fg">
            {ocrText ? `「${ocrText}」` : '（未填）'}
          </span>
          <span className="text-[9px] text-faint">文字识别</span>
        </div>
      ) : (
        <button
          type="button"
          disabled={!failed && loading}
          onClick={(event) => {
            event.stopPropagation();
            if (failed) {
              retry(label, false);
              onRetryClick?.();
            }
          }}
          style={{ minHeight: Math.min(56, maxHeight), maxHeight }}
          className={cn(
            'nodrag nopan flex w-full flex-col items-center justify-center gap-0.5 px-2 text-[10px]',
            failed ? 'cursor-pointer text-failed hover:bg-raised/50' : 'cursor-default text-faint',
          )}
        >
          <span>{failed ? '加载失败 · 点击重试' : loading ? '加载模板…' : '…'}</span>
          <span className="truncate text-dim">{label}</span>
        </button>
      )}
      {src || isOcr ? (
        <div
          className={cn(
            'truncate border-t border-line px-1 py-0.5 text-center text-[9px]',
            isOcr ? 'text-brand' : 'text-faint',
          )}
          title={caption}
        >
          {caption}
        </div>
      ) : null}
    </div>
  );
}
