/**
 * 模板截图缓存：**一张模板只取一次，取到就一直留着**。
 *
 * 为什么需要它（真踩过 + 用户反馈"拖动后模板突然都没了"）：
 *   1. 以前每个 `TemplateThumb` 各自 `useState` + 各自发 `template.image`：
 *      组件一被重新挂载（切节点、坞收起再展开、面板重挂）就重新取图 ——
 *      期间是"…"，失败就是"×"，而且**失败会一直锁死**（没有重试路径）。
 *   2. 引擎每次保存 `graph.json` 都要重载状态图，这一瞬间的取图 RPC 可能失败；
 *      所有缩略图会同时变成"×" —— 看起来就是"模板全消失了"。
 *
 * 现在的约定：缓存是**进程级**的（模块 Map + zustand 只用来通知刷新），
 * 命中就同步拿到图；失败只在**从没成功过**时才算失败，并且可以被点一下重试。
 * 画布上要同时显示很多张缩略图，这个缓存也是前提（不能每张各发一次 RPC）。
 */
import { create } from 'zustand';

import { devLog, templateImage } from '@/lib/rpc';

export interface TemplateEntry {
  /** data URL；undefined 表示还没取到 */
  readonly url?: string;
  readonly loading: boolean;
  readonly error?: string;
}

interface TemplateState {
  readonly entries: Readonly<Record<string, TemplateEntry>>;
  readonly load: (label: string, grayscale?: boolean) => void;
  readonly retry: (label: string, grayscale?: boolean) => void;
}

/** 进程级缓存：组件卸载/重挂不影响它（zustand 只负责通知"哪张取到了"） */
const cache = new Map<string, string>();
/** 每个 key 的请求代次：只有最新一次的结果能写缓存（重试时旧请求回来也不会覆盖新的） */
const generation = new Map<string, number>();

/** 清掉缓存（重新录制同一张模板后必须调用，否则界面还在显示旧图） */
export function clearTemplateCache(labels?: readonly string[]): void {
  if (!labels) {
    cache.clear();
    useTemplateStore.setState({ entries: {} });
    return;
  }
  for (const label of labels) {
    for (const suffix of ['color', 'gray'] as const) {
      const key = `${label}:${suffix}`;
      cache.delete(key);
      generation.delete(key);
      useTemplateStore.setState((state) => {
        const entries = { ...state.entries };
        delete entries[key];
        return { entries };
      });
    }
  }
}

function cacheKey(label: string, grayscale: boolean): string {
  return `${label}:${grayscale ? 'gray' : 'color'}`;
}

export const useTemplateStore = create<TemplateState>()((set, get) => {
  const patch = (key: string, entry: TemplateEntry): void => {
    set((state) => ({ entries: { ...state.entries, [key]: entry } }));
  };

  /**
   * 取一张图。
   * `force` = 用户点了重试：**保留旧图**去重新拉，拉到再换（拉失败也还留着旧的）。
   */
  const fetchOne = (label: string, grayscale: boolean, force = false): void => {
    const key = cacheKey(label, grayscale);
    const known = cache.get(key);
    if (known && !force) {
      patch(key, { url: known, loading: false });
      return;
    }
    const ticket = (generation.get(key) ?? 0) + 1;
    if (!force && generation.get(key) === ticket - 1 && useTemplateStore.getState().entries[key]?.loading) {
      return; // 已经在取了（force = 用户点了重试，允许插队）
    }
    generation.set(key, ticket);
    patch(key, known ? { url: known, loading: true } : { loading: true });

    void templateImage(label, grayscale)
      .then((data) => {
        if (generation.get(key) !== ticket) {
          return; // 已经有更新的一次请求了，旧结果丢掉
        }
        // 引擎返回 { label, mode, width, height, png }：png 是**裸 base64**（不是 data URL！），
        // 直接塞进 <img src> 浏览器识别不了 → 必须补前缀。踩过两次，别再删这段。
        const raw = typeof data === 'string' ? data : String((data as { png?: string })?.png ?? '');
        const url = !raw ? '' : raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
        if (!url) {
          throw new Error('引擎没返回图片数据');
        }
        cache.set(key, url); // 先落缓存：之后无论如何都不会再"消失"
        patch(key, { url, loading: false });
      })
      .catch((error: unknown) => {
        if (generation.get(key) !== ticket) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        devLog(`取模板截图失败 ${label}: ${message}`);
        // 关键：**只在从没成功过时**才显示失败；已经拿到过的图继续用（宁可显示旧图，也别变"×"）
        const fallback = cache.get(key);
        patch(key, fallback ? { url: fallback, loading: false } : { loading: false, error: message });
      });
  };

  return {
    entries: {},

    load: (label, grayscale = false) => {
      const key = cacheKey(label, grayscale);
      const known = cache.get(key);
      if (known) {
        if (get().entries[key]?.url !== known) {
          patch(key, { url: known, loading: false });
        }
        return;
      }
      fetchOne(label, grayscale);
    },

    retry: (label, grayscale = false) => {
      // 注意：**不清缓存**。清了的话"重试"会先把已经显示出来的图弄没（用户看到的就是模板又消失一次）
      fetchOne(label, grayscale, true);
    },
  };
});

/** 同步读缓存（画布上要一次画很多张，不该为了拿 URL 再渲染一轮）。 */
export function cachedTemplate(label: string, grayscale = false): string | undefined {
  return cache.get(cacheKey(label, grayscale));
}

/** 一次性预取一批模板（状态图加载后调用，画布/详情/面板共用同一份缓存）。 */
export function preloadTemplates(labels: readonly string[]): void {
  const { load } = useTemplateStore.getState();
  for (const label of labels) {
    load(label);
  }
}
