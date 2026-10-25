/**
 * AI（YOLO）识别组件：可选下载的独立 worker（torch + 模型）。
 *
 * - 组件装好之前，`AI 识别` 入口只显示"安装组件"；
 * - 安装是异步的，进度走 `yolo.progress` 通知（session.store 转发到这里）；
 * - 状态缓存在 store 里，素材区入口和弹窗共用一份，不各拉一遍。
 */
import { create } from 'zustand';

import {
  type YoloComponentStatus,
  type YoloProgressPayload,
  yoloInstall,
  yoloRemove,
  yoloStatus,
} from '@/lib/rpc';

interface YoloStoreState {
  status: YoloComponentStatus | null;
  /** 开发态：引擎进程里直接有 torch + 模型（没装组件也能跑） */
  runtimeAvailable: boolean;
  /** worker 实际推理设备（cuda/cpu/空） */
  runtimeDevice: string;
  /** worker 最近一次错误（推理失败、加载失败…） */
  runtimeError: string | null;
  loading: boolean;
  installing: boolean;
  progress: number;
  stage: string;
  error: string | null;
  refresh: () => Promise<void>;
  install: (source?: string) => Promise<void>;
  remove: () => Promise<void>;
  applyProgress: (payload: YoloProgressPayload) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useYoloStore = create<YoloStoreState>((set, get) => ({
  status: null,
  runtimeAvailable: false,
  runtimeDevice: '',
  runtimeError: null,
  loading: false,
  installing: false,
  progress: 0,
  stage: '',
  error: null,

  refresh: async () => {
    set({ loading: true });
    try {
      const payload = await yoloStatus();
      set({
        status: payload.component,
        runtimeAvailable: Boolean(payload.runtime.available),
        runtimeDevice: typeof payload.runtime.device === 'string' ? payload.runtime.device : '',
        runtimeError:
          typeof payload.runtime.error === 'string' && payload.runtime.error ? payload.runtime.error : null,
        loading: false,
        error: null,
      });
    } catch (error) {
      set({ loading: false, error: messageOf(error) });
    }
  },

  install: async (source) => {
    if (get().installing) {
      return;
    }
    set({ installing: true, progress: 0, stage: '正在准备…', error: null });
    try {
      await yoloInstall(source);
    } catch (error) {
      set({ installing: false, error: messageOf(error) });
    }
  },

  remove: async () => {
    try {
      const status = await yoloRemove();
      set({ status, progress: 0, stage: '', error: null });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  applyProgress: (payload) => {
    if (payload.state === 'error') {
      set({ installing: false, error: payload.error ?? 'AI 组件安装失败', stage: '' });
      return;
    }
    if (payload.state === 'done') {
      set({
        installing: false,
        progress: 100,
        stage: payload.stage ?? 'AI 组件已就绪',
        status: payload.status ?? get().status,
      });
      void get().refresh();
      return;
    }
    set({
      progress: payload.progress ?? get().progress,
      stage: payload.stage ?? get().stage,
    });
  },
}));
