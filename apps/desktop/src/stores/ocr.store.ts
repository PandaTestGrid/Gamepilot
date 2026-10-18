/**
 * 离线 OCR（PP-OCRv4 Mobile ONNX）：
 * - 点「OCR」即扫描当前画面（不是开关）
 * - 模型随引擎内置；首次 OCR 在后台加载 + `ocr.progress`，避免 RPC 超时
 * - 框选弹窗里的 OCR 按钮：识字并填入名称
 */
import { create } from 'zustand';

import {
  engineStart,
  engineStop,
  type OcrBoxItem,
  ocrCancel,
  ocrLoad,
  ocrRecognize,
  ocrStatus,
  type OcrRecognizeResult,
  type OcrStatusPayload,
} from '@/lib/rpc';

async function withEngineReloadRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('未知方法') || msg.includes('Method not found')) {
      const [{ connectedDevices, useDeviceStore }, { useSessionStore }] = await Promise.all([
        import('@/stores/device.store'),
        import('@/stores/session.store'),
      ]);
      const liveDevices = connectedDevices(useDeviceStore.getState().devices);
      useSessionStore.getState().resetForEngineRestart();
      await engineStop().catch(() => undefined);
      await engineStart().catch(() => undefined);
      await Promise.all(
        liveDevices.map((device) => useSessionStore.getState().connect(device.id, device.uri)),
      );
      return await fn();
    }
    throw error;
  }
}

const DEFAULT_STATUS: OcrStatusPayload = {
  modelId: 'ppocr_v4_mobile',
  modelName: 'PP-OCRv4 轻量离线模型 (ONNX)',
  sizeMb: 15.5,
  state: 'downloaded',
  downloaded: true,
  loaded: false,
  progress: 0,
  downloadedBytes: 0,
  totalBytes: 16_241_867,
  stage: '',
  error: null,
};

const MIN_SCAN_EFFECT_MS = 680;
const LOAD_WAIT_MS = 5 * 60 * 1000;
const OCR_RESULT_WAIT_MS = 120_000;

interface PendingOcrResult {
  readonly gen: number;
  readonly deviceId: string;
  readonly resolve: (result: OcrRecognizeResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

let pendingOcrResult: PendingOcrResult | null = null;

function armOcrResultWait(deviceId: string, gen: number): Promise<OcrRecognizeResult> {
  return new Promise((resolve, reject) => {
    if (pendingOcrResult) {
      clearTimeout(pendingOcrResult.timer);
      pendingOcrResult.reject(new Error('OCR 已被新的任务取代'));
      pendingOcrResult = null;
    }
    const timer = setTimeout(() => {
      if (pendingOcrResult?.gen === gen) {
        pendingOcrResult = null;
        reject(new Error('OCR 等待结果超时'));
      }
    }, OCR_RESULT_WAIT_MS);
    pendingOcrResult = { gen, deviceId, resolve, reject, timer };
  });
}

function settlePendingOcrResult(payload: OcrRecognizeResult): void {
  const deviceId = payload.deviceId ?? '';
  if (!pendingOcrResult || pendingOcrResult.deviceId !== deviceId) {
    return;
  }
  clearTimeout(pendingOcrResult.timer);
  const pending = pendingOcrResult;
  pendingOcrResult = null;
  pending.resolve(payload);
}

export interface OcrScanVisual {
  readonly id: number;
  readonly deviceId: string;
  /** 归一化选区矩形；null 表示整屏扫描 */
  readonly rect: readonly [number, number, number, number] | null;
}

export interface OcrState {
  readonly status: OcrStatusPayload;
  readonly recognizing: boolean;
  readonly scanningScreen: boolean;
  readonly scanVisual: OcrScanVisual | null;
  readonly pickBoxes: Readonly<Record<string, readonly OcrBoxItem[]>>;
  readonly lastError: string | null;

  readonly refreshStatus: () => Promise<OcrStatusPayload>;
  readonly applyProgress: (payload: OcrStatusPayload) => void;
  readonly applyRecognizeResult: (payload: OcrRecognizeResult) => void;
  readonly loadModel: () => Promise<boolean>;
  readonly recognizeRegion: (
    deviceId: string,
    rect: readonly [number, number, number, number],
  ) => Promise<string>;
  readonly scanScreenForPick: (deviceId: string) => Promise<readonly OcrBoxItem[]>;
  readonly cancelRecognize: () => Promise<void>;
  readonly clearPickBoxes: (deviceId?: string) => void;
}

/** 把识别出的文本清理为适合做识别器/模板名的字符串（去掉首尾空白与换行）。 */
export function sanitizeOcrLabel(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
}

let scanVisualSeq = 0;
let ocrRunGeneration = 0;
let loadWaiters: Array<(ok: boolean) => void> = [];

function isTestEnv(): boolean {
  return typeof process !== 'undefined' && Boolean(process.env.VITEST);
}

async function waitMinDuration(startedAt: number): Promise<void> {
  if (isTestEnv()) {
    return;
  }
  const elapsed = performance.now() - startedAt;
  if (elapsed < MIN_SCAN_EFFECT_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_SCAN_EFFECT_MS - elapsed));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const useOcrStore = create<OcrState>()((set, get) => ({
  status: DEFAULT_STATUS,
  recognizing: false,
  scanningScreen: false,
  scanVisual: null,
  pickBoxes: {},
  lastError: null,

  refreshStatus: async () => {
    try {
      const next = await withEngineReloadRetry(() => ocrStatus());
      set({ status: next, lastError: next.error });
      return next;
    } catch {
      return get().status;
    }
  },

  applyProgress: (payload) => {
    set({ status: payload, lastError: payload.error });
    if (payload.state === 'ready') {
      const waiters = loadWaiters;
      loadWaiters = [];
      for (const resolve of waiters) resolve(true);
    } else if (payload.state === 'error') {
      const waiters = loadWaiters;
      loadWaiters = [];
      for (const resolve of waiters) resolve(false);
    }
  },

  applyRecognizeResult: (payload) => {
    if (!payload.deviceId) {
      return;
    }
    settlePendingOcrResult(payload);
  },

  loadModel: async () => {
    if (get().status.state === 'ready') {
      return true;
    }
    if (get().status.state === 'downloading') {
      return await waitUntilLoaded(get);
    }
    set((state) => ({
      status: {
        ...state.status,
        state: 'downloading',
        progress: state.status.downloaded ? 90 : 2,
        stage: '正在加载 PP-OCRv4 模型…',
        error: null,
      },
      lastError: null,
    }));
    try {
      const next = await withEngineReloadRetry(() => ocrLoad());
      set({ status: next, lastError: next.error });
      if (next.state === 'ready') {
        return true;
      }
      if (next.state === 'error') {
        return false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 后台下载仍可能在跑：超时不立刻失败，继续等进度通知
      if (!message.includes('超时') && !message.toLowerCase().includes('timeout')) {
        set((state) => ({
          status: { ...state.status, state: 'error', error: message, stage: message },
          lastError: message,
        }));
        return false;
      }
    }
    if (isTestEnv()) {
      return get().status.state === 'ready';
    }
    return await waitUntilLoaded(get);
  },

  cancelRecognize: async () => {
    ocrRunGeneration += 1;
    if (pendingOcrResult) {
      clearTimeout(pendingOcrResult.timer);
      pendingOcrResult.resolve({ text: '', score: 0, items: [], cancelled: true });
      pendingOcrResult = null;
    }
    try {
      await withEngineReloadRetry(() => ocrCancel());
    } catch {
      // 引擎未就绪时仍清本地状态
    }
    set({
      recognizing: false,
      scanningScreen: false,
      scanVisual: null,
    });
  },

  recognizeRegion: async (deviceId, rect) => {
    scanVisualSeq += 1;
    const visualId = scanVisualSeq;
    const runGen = ++ocrRunGeneration;
    const startedAt = performance.now();
    set({
      recognizing: true,
      scanVisual: { id: visualId, deviceId, rect },
      lastError: null,
    });
    try {
      if (get().status.state !== 'ready') {
        const ok = await get().loadModel();
        if (!ok) {
          return '';
        }
      }
      const { withDeviceSession } = await import('@/stores/session.store');
      const resultWait = armOcrResultWait(deviceId, runGen);
      const accepted = await withDeviceSession(deviceId, () => ocrRecognize(deviceId, rect));
      if (!accepted.accepted) {
        return '';
      }
      const res = await resultWait;
      if (runGen !== ocrRunGeneration || res.cancelled) {
        return '';
      }
      if (res.error) {
        set({ lastError: res.error });
        return '';
      }
      await waitMinDuration(startedAt);
      return sanitizeOcrLabel(res.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runGen === ocrRunGeneration) {
        set({ lastError: message });
      }
      return '';
    } finally {
      if (runGen === ocrRunGeneration) {
        set((state) => ({
          recognizing: false,
          scanVisual: state.scanVisual?.id === visualId ? null : state.scanVisual,
        }));
      }
    }
  },

  scanScreenForPick: async (deviceId) => {
    scanVisualSeq += 1;
    const visualId = scanVisualSeq;
    const runGen = ++ocrRunGeneration;
    const startedAt = performance.now();
    set((state) => {
      const nextBoxes = { ...state.pickBoxes };
      delete nextBoxes[deviceId];
      return {
        scanningScreen: true,
        scanVisual: { id: visualId, deviceId, rect: null },
        pickBoxes: nextBoxes,
        lastError: null,
      };
    });
    try {
      if (get().status.state !== 'ready') {
        const ok = await get().loadModel();
        if (!ok) {
          const message = get().lastError || get().status.error || 'OCR 模型尚未就绪';
          const { useSessionStore } = await import('@/stores/session.store');
          useSessionStore.setState({ error: message });
          return [];
        }
      }
      const { withDeviceSession, useSessionStore } = await import('@/stores/session.store');
      const resultWait = armOcrResultWait(deviceId, runGen);
      const accepted = await withDeviceSession(deviceId, () => ocrRecognize(deviceId));
      if (!accepted.accepted) {
        return [];
      }
      const res = await resultWait;
      if (runGen !== ocrRunGeneration || res.cancelled) {
        return [];
      }
      if (res.error) {
        set({ lastError: res.error });
        useSessionStore.setState({ error: res.error });
        return [];
      }
      await waitMinDuration(startedAt);
      const items = res.items ?? [];
      set((state) => ({
        pickBoxes: { ...state.pickBoxes, [deviceId]: items },
      }));
      if (items.length === 0) {
        useSessionStore.setState({ error: '当前画面未识别到文字' });
      }
      return items;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runGen === ocrRunGeneration) {
        set({ lastError: message });
        const { useSessionStore } = await import('@/stores/session.store');
        useSessionStore.setState({ error: message });
      }
      return [];
    } finally {
      if (runGen === ocrRunGeneration) {
        set((state) => ({
          scanningScreen: false,
          scanVisual: state.scanVisual?.id === visualId ? null : state.scanVisual,
        }));
      }
    }
  },

  clearPickBoxes: (deviceId) => {
    if (!deviceId) {
      if (Object.keys(get().pickBoxes).length === 0) {
        return;
      }
      set({ pickBoxes: {} });
      return;
    }
    set((state) => {
      if (!(deviceId in state.pickBoxes)) {
        return state;
      }
      const next = { ...state.pickBoxes };
      delete next[deviceId];
      return { pickBoxes: next };
    });
  },
}));

async function waitUntilLoaded(get: () => OcrState): Promise<boolean> {
  if (get().status.state === 'ready') {
    return true;
  }
  if (get().status.state === 'error') {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => {
      loadWaiters = loadWaiters.filter((item) => item !== onDone);
      resolve(get().status.state === 'ready');
    }, LOAD_WAIT_MS);
    const onDone = (ok: boolean): void => {
      window.clearTimeout(timer);
      resolve(ok);
    };
    loadWaiters.push(onDone);
    void (async () => {
      while (loadWaiters.includes(onDone)) {
        await sleep(800);
        try {
          const next = await ocrStatus();
          useOcrStore.getState().applyProgress(next);
        } catch {
          // 轮询失败不中断：继续等 ocr.progress
        }
      }
    })();
  });
}
