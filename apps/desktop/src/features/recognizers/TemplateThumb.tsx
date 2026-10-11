/**
 * 模版缩略图：小图列表里看得清、鼠标一放就弹大图。
 *
 * 之前只有 22~26px，录制出来的模板根本看不清（用户反馈"太小了"）。现在：
 * - 小图放大到 40px 起步，并按"像素化"渲染：模板本身可能很小，放大后不该是糊的
 * - **悬停弹出大预览**（200px，固定定位，不会被面板裁切）：看清录的是什么
 * - 点一下仍然切黑白（模板匹配本来就是按灰度算的）
 */
import { type ReactNode, useEffect, useState } from 'react';

import { templateImage } from '@/lib/rpc';
import { cn } from '@/lib/utils';

export function TemplateThumb({ label, size = 26 }: { label: string; size?: number }): ReactNode {
  const [grayscale, setGrayscale] = useState(false);
  const [cache, setCache] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  const key = `${label}:${grayscale ? 'gray' : 'color'}`;

  useEffect(() => {
    if (cache[key]) {
      return;
    }
    let alive = true;
    void templateImage(label, grayscale)
      .then((data) => {
        // 引擎返回 { label, mode, width, height, png }：图片在 png 字段（data URL）
        const url = typeof data === 'string' ? data : String((data as { png?: string })?.png ?? '');
        if (alive && url) {
          setCache((current) => ({ ...current, [key]: url }));
        } else if (alive) {
          setFailed(true);
        }
      })
      .catch(() => {
        if (alive) {
          setFailed(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [cache, grayscale, key, label]);

  const src = cache[key];

  return (
    <>
      <button
        type="button"
        title={`${label}（点一下切黑白，悬停看大图）`}
        onMouseEnter={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setHover({ x: rect.right + 8, y: rect.top });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(event) => {
          event.stopPropagation();
          setGrayscale((value) => !value);
        }}
        style={{ width: size, height: size }}
        className={cn(
          'shrink-0 overflow-hidden rounded-sm border border-line bg-canvas',
          'hover:border-brand',
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
          <span className="flex size-full items-center justify-center text-badge text-faint">
            {failed ? '×' : '…'}
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
