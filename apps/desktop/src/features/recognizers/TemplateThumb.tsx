/**
 * 模板缩略图：把"录下来的模板"显示出来，并且能一键切黑白看匹配时用的样子。
 *
 * 模板匹配是按灰度算的（引擎 TemplateRecognizer 用 IMREAD_GRAYSCALE），
 * 所以"黑白版"就是它在屏幕上真正的样子；彩色版用来确认有没有框错地方。
 */
import { type ReactNode, useEffect, useState } from 'react';

import { templateImage } from '@/lib/rpc';
import { cn } from '@/lib/utils';

export function TemplateThumb({ label, size = 26 }: { label: string; size?: number }): ReactNode {
  const [grayscale, setGrayscale] = useState(false);
  const [cache, setCache] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);

  const key = `${label}:${grayscale ? 'gray' : 'color'}`;

  useEffect(() => {
    if (cache[key]) {
      return;
    }
    let alive = true;
    void templateImage(label, grayscale)
      .then((image) => {
        if (alive && image.png) {
          setCache((prev) => ({ ...prev, [key]: `data:image/png;base64,${image.png}` }));
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
  }, [label, grayscale, key, cache]);

  const src = cache[key];

  return (
    <button
      type="button"
      title={src ? '点击切换 黑白 / 彩色（黑白就是模板匹配真正用的样子）' : '这张模板取不到图'}
      onClick={() => setGrayscale((value) => !value)}
      className={cn(
        'relative shrink-0 overflow-hidden rounded-sm border bg-[#0b0d12]',
        failed ? 'border-failed/60' : 'border-line hover:border-brand',
      )}
      style={{ width: size, height: size }}
    >
      {src ? (
        <img src={src} alt={`${label} 模板`} className="h-full w-full object-cover" draggable={false} />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[9px] text-faint">
          {failed ? '×' : '…'}
        </span>
      )}
      {src && grayscale && (
        <span className="absolute right-0 bottom-0 bg-black/70 px-[2px] text-[8px] text-white/80">黑白</span>
      )}
    </button>
  );
}
