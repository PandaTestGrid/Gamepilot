/**
 * 模版缩略图：小图列表里看得清、鼠标一放就弹大图。
 *
 * 数据来自 `stores/template.store.ts` 的**进程级缓存**（一张模板只取一次）：
 * 以前每个缩略图各自取图，组件一重挂就重新请求 —— 引擎保存重载的那一瞬间失败，
 * 所有缩略图会同时变成"×"，也就是用户说的"拖动后模板突然都没了"。
 * 现在：取到过的图不会再消失；只有从没成功过才算失败，而且**点一下可以重试**。
 *
 * 交互：
 * - 小图按"像素化"渲染（模板本身可能很小，放大后不该是糊的）
 * - 悬停弹出 200px 大预览（固定定位，不会被面板裁切）
 * - 点一下切黑白（模板匹配本来就是按灰度算的）
 */
import { type ReactNode, useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import { useTemplateStore } from '@/stores/template.store';

export function TemplateThumb({ label, size = 26 }: { label: string; size?: number }): ReactNode {
  const [grayscale, setGrayscale] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  const key = `${label}:${grayscale ? 'gray' : 'color'}`;
  const entry = useTemplateStore((state) => state.entries[key]);
  const load = useTemplateStore((state) => state.load);
  const retry = useTemplateStore((state) => state.retry);

  useEffect(() => {
    load(label, grayscale);
  }, [label, grayscale, load]);

  const src = entry?.url;
  const failed = Boolean(entry?.error) && !src;

  return (
    <>
      <button
        type="button"
        title={failed ? `${label}：取图失败 —— 点一下重试` : `${label}（点一下切黑白，悬停看大图）`}
        onMouseEnter={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setHover({ x: rect.right + 8, y: rect.top });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(event) => {
          event.stopPropagation();
          if (failed) {
            retry(label, grayscale); // 失败态下点击 = 重试（不再"一次失败就永远 ×"）
            return;
          }
          setGrayscale((value) => !value);
        }}
        style={{ width: size, height: size }}
        className={cn(
          'shrink-0 overflow-hidden rounded-sm border bg-canvas',
          failed ? 'border-failed/60' : 'border-line hover:border-brand',
        )}
      >
        {src ? (
          <img
            src={src}
            alt={label}
            style={{ imageRendering: 'pixelated' }}
            className="size-full object-contain"
          />
        ) : (
          <span
            className={cn(
              'flex size-full items-center justify-center text-badge',
              failed ? 'text-failed' : 'text-faint',
            )}
          >
            {failed ? '↻' : '…'}
          </span>
        )}
      </button>

      {/* 大预览：固定定位，不会被滚动容器裁切 */}
      {hover && src && (
        <span
          className="pointer-events-none fixed z-50 flex flex-col gap-1 rounded-sm border border-line bg-panel p-2 shadow-lg"
          style={{ left: hover.x, top: hover.y }}
        >
          <img
            src={src}
            alt={label}
            style={{ imageRendering: 'pixelated', maxWidth: 240, maxHeight: 240 }}
            className="object-contain"
          />
          <span className="text-badge text-dim">
            {label} · {grayscale ? '黑白' : '彩色'} · 悬停看大图
          </span>
        </span>
      )}
    </>
  );
}

/**
 * 画布/引脚上用的极简版本：只画图，不带外框与交互
 * （画布上的鼠标要留给拖动节点，缩略图不能抢事件）。
 */
export function TemplateMini({ label, size = 22 }: { label: string; size?: number }): ReactNode {
  const entry = useTemplateStore((state) => state.entries[`${label}:color`]);
  const load = useTemplateStore((state) => state.load);

  useEffect(() => {
    load(label, false);
  }, [label, load]);

  return (
    <span
      title={`模板 ${label}`}
      style={{ width: size, height: size }}
      className="pointer-events-none inline-flex shrink-0 items-center justify-center overflow-hidden rounded-sm border border-line bg-canvas"
    >
      {entry?.url ? (
        <img
          src={entry.url}
          alt={label}
          style={{ imageRendering: 'pixelated' }}
          className="size-full object-contain"
        />
      ) : (
        <span className="text-[9px] text-faint">{entry?.error ? '·' : '…'}</span>
      )}
    </span>
  );
}
