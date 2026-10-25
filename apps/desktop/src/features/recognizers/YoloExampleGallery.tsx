import { useEffect, useState, useSyncExternalStore } from 'react';

import { exampleThumbnailStyle } from '@/features/device/yolo-example-thumbnail';
import { getYoloExamplesRevision, subscribeYoloExamples } from '@/features/recognizers/yolo-example-revision';
import { recognizerDetail, type YoloExamplePayload } from '@/lib/rpc';

export interface YoloExampleGalleryProps {
  deviceId: string;
  label: string;
  examplesCount?: number;
  /** 编辑保存后递增；即使示例数量不变也会重新读取。不要传实时识别分数。 */
  revision?: number | string;
  /** 节点内最多显示三张，完整侧栏保持全部标记图片。 */
  compact?: boolean;
  /** 完整模式仅图片区滚动，不裁掉外部类别说明。 */
  maxHeight?: number;
  emptyHint?: string;
  /** 选择器磁贴内只渲染首张裁剪图/文字，不嵌套交互按钮或块元素。 */
  presentation?: 'gallery' | 'tile';
  tileSize?: number;
}

type GalleryState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; examples: readonly YoloExamplePayload[] }
  | { key: string; status: 'error' };

// 折叠会卸载素材行：保留少量成功结果，正在读取的行共享同一个请求。
// 仅缓存 examples，不保留 detail 中与此预览无关的参数；失败不缓存，以便重试。
const MAX_CACHED_GALLERIES = 32;
const examplesCache = new Map<string, readonly YoloExamplePayload[]>();
const inflight = new Map<string, Promise<readonly YoloExamplePayload[]>>();

function loadExamples(key: string, deviceId: string, label: string) {
  const cached = examplesCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = recognizerDetail(deviceId, label)
    .then(({ examples = [] }) => {
      examplesCache.set(key, examples);
      if (examplesCache.size > MAX_CACHED_GALLERIES) {
        const oldestKey = examplesCache.keys().next().value;
        if (oldestKey !== undefined) examplesCache.delete(oldestKey);
      }
      return examples;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

/** 素材区 AI 识别器的所有标记图片，仅展示标记范围，不展示整个参考帧。 */
export function YoloExampleGallery({
  deviceId,
  label,
  examplesCount,
  revision,
  compact = false,
  maxHeight,
  emptyHint = '暂无标记图片',
  presentation = 'gallery',
  tileSize = 40,
}: YoloExampleGalleryProps) {
  const sharedRevision = useSyncExternalStore(
    subscribeYoloExamples,
    () => getYoloExamplesRevision(label),
  );
  // 只依赖素材身份/版本：父组件每帧更新 score 不会重新读取。
  // 共享版本隔离旧 inflight；旧响应只会写入旧 key，不能污染新素材。
  const key = JSON.stringify([deviceId, label, examplesCount ?? null, revision ?? null, sharedRevision]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<GalleryState>({ key, status: 'loading' });

  useEffect(() => {
    let active = true;
    void loadExamples(key, deviceId, label).then(
      (examples) => {
        if (active) setState({ key, status: 'ready', examples });
      },
      () => {
        if (active) setState({ key, status: 'error' });
      },
    );
    return () => {
      active = false;
    };
  }, [key, deviceId, label, attempt]);

  // props 改变时旧 state 不能闪现到新的素材行；卸载后的旧请求也不能更新它。
  const cached = examplesCache.get(key);
  const current: GalleryState = cached
    ? { key, status: 'ready', examples: cached }
    : state.key === key
      ? state
      : { key, status: 'loading' };

  if (presentation === 'tile') {
    if (current.status !== 'ready' || current.examples.length === 0) {
      const message = current.status === 'loading' ? '加载图片…'
        : current.status === 'error' ? '图片加载失败' : emptyHint;
      return (
        <span
          role={current.status === 'loading' ? 'status' : undefined}
          className="px-1 text-center text-[10px] leading-tight text-dim"
          title={current.status === 'error' ? '关闭后重新打开选择器以重试' : undefined}
        >
          {message}
        </span>
      );
    }
    const first = current.examples[0]!;
    return (
      <span
        role="img"
        aria-label={`${label} · 标记图片 1`}
        className="block shrink-0"
        style={{
          width: tileSize,
          height: tileSize,
          ...exampleThumbnailStyle(first.image, first.rect, first.width, first.height, tileSize),
        }}
      />
    );
  }

  if (current.status === 'loading') {
    return <p role="status" className="py-1 text-[11px] text-dim">加载标记图片…</p>;
  }
  if (current.status === 'error') {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 py-1 text-[11px]">
        <span className="text-failed">标记图片加载失败</span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setState({ key, status: 'loading' });
            setAttempt((value) => value + 1);
          }}
          className="nodrag nopan rounded-sm px-1 text-brand underline underline-offset-2 hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          重试
        </button>
      </div>
    );
  }
  if (current.examples.length === 0) {
    return <p className="py-1 text-[11px] text-dim">{emptyHint}</p>;
  }

  const visibleExamples = compact ? current.examples.slice(0, 3) : current.examples;

  return (
    <div className="min-w-0 space-y-1">
      <ul
        aria-label={`${label} 的标记图片`}
        className="nodrag nopan nowheel flex min-w-0 flex-wrap gap-1.5 overflow-y-auto"
        style={!compact && maxHeight ? { maxHeight } : undefined}
      >
        {visibleExamples.map((example, index) => (
          <li
            key={index}
            className="shrink-0 overflow-hidden rounded-sm border-2 border-line bg-canvas"
            title={`${example.label || label} · 标记图片 ${index + 1}`}
          >
            <span
              role="img"
              aria-label={`${example.label || label} · 标记图片 ${index + 1}`}
              className="block size-10"
              style={exampleThumbnailStyle(example.image, example.rect, example.width, example.height)}
            />
          </li>
        ))}
      </ul>
      {compact && <p className="text-[10px] text-dim">共 {current.examples.length} 张标记图片</p>}
    </div>
  );
}
