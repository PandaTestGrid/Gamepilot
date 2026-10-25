/**
 * AI 识别器工作台：框示例（可多个）→ 调参 → 开始实时检测看效果 → 保存成识别器。
 *
 * 布局是编辑舞台 + 设置台：
 *   - 左侧是两个固定区域：上方画面与播放控制，下方录制与帧时间轴；
 *   - 设置台用背景色阶、标题权重和组间留白组织示例、命名、检测与运行环境，
 *     底部固定实时检测入口；窄窗口改为上下布局；
 *   - 底部统一放取消 / 保存（保存是主操作，靠右）。
 *
 * 图标语言跟素材区一致：20px 点按区 / 14px lucide，选中用 brand 浅底。
 * 「组件」和「模型」是两件事，所以分开放：组件（worker + 运行时）在「模型与环境」里安装/更换，
 * 权重模型在同组的第一行导入 —— 按钮文案也分开（安装 AI 组件 / 导入模型…），不再挤在标题栏里抢位置。
 */
import { Sparkles, X } from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  YoloPlaybackToolbar,
  YoloRecordingPanel,
  type RecordingTake,
} from '@/features/device/YoloMediaPanels';
import { YoloVideoStage } from '@/features/device/YoloVideoStage';
import { YoloSettingsPanel } from '@/features/device/YoloSettingsPanel';
import { useYoloRecording } from '@/features/device/useYoloRecording';
import { pickFileResult } from '@/features/library/native-dialog';
import { containBox } from '@/lib/canvas';
import { cn } from '@/lib/utils';
import {
  frameAt,
  frameMeta,
  previewYolo,
  recognizerDetail,
  recordingFrameAt,
  type YoloPreviewDet,
  yoloAddModel,
  yoloModels,
  yoloWarmup,
  yoloSetModel,
} from '@/lib/rpc';
import { graphForDevice, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useYoloStore } from '@/stores/yolo.store';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type NormRect = [number, number, number, number];
type FrameSource = 'seek' | 'playback' | 'follow' | 'history' | 'prefetch';

interface ExampleMark {
  readonly id: string;
  readonly rect: NormRect;
  readonly label: string;
  readonly enabled: boolean;
  readonly color: string;
  /** 框这个示例时的冻结帧（data URL）：每个示例各自保留，换画面也不影响 */
  readonly image: string;
  /** 参考帧宽高（缩略图按它等比裁剪，避免拉变形） */
  readonly width: number;
  readonly height: number;
}

interface CachedFrame {
  readonly url: string;
  /** 引擎实际返回的帧号（可能是 nearest 给的相邻帧） */
  readonly index: number;
  readonly width: number;
  readonly height: number;
}

const MARK_COLORS = ['#4ade80', '#60a5fa', '#fbbf24', '#f472b6', '#a78bfa', '#22d3ee'];
/** 示例区最多缓存多少个缩略图对应的参考帧（data URL 比较占内存） */
const FRAME_CACHE_LIMIT = 120;
/** 回放时顺手预取后面几帧，拖动时不用等 */
const PREFETCH_AHEAD = 6;
export function YoloRecognizerDialog({
  deviceId,
  open,
  editLabel = null,
  onClose,
}: {
  deviceId: string;
  open: boolean;
  /** 传了就进入编辑模式（素材区点铅笔打开） */
  editLabel?: string | null;
  onClose: () => void;
}): ReactNode {
  const isEditMode = Boolean(editLabel);
  const graph = useGraphStore((state) => graphForDevice(state, deviceId));
  const frame = useSessionStore((state) => state.frames[deviceId]);
  const touchDevice = useSessionStore((state) => state.touch);
  const create = useSessionStore((state) => state.createYoloRecognizer);
  const update = useSessionStore((state) => state.updateYoloRecognizer);
  const {
    status,
    runtimeAvailable,
    runtimeDevice,
    runtimeError,
    loading,
    installing,
    progress,
    stage,
    error,
    refresh,
    install,
  } = useYoloStore();

  const [labelOverride, setLabelOverride] = useState<string | null>(null);
  const [marks, setMarks] = useState<ExampleMark[]>([]);
  const [conf, setConf] = useState(0.3);
  const [search, setSearch] = useState<'region' | 'full'>('region');
  const [roi, setRoi] = useState<NormRect | null>(null);
  const [iou, setIou] = useState(0.45);
  const [imgsz, setImgsz] = useState<number>(640);
  const [tile, setTile] = useState(false);
  const [tileSize, setTileSize] = useState<number>(640);
  const [running, setRunning] = useState(false);
  /** 画面交互模式：标注=拖框；控制=点和拖直接发给设备（标完框想点一下游戏验证时用） */
  const [inputMode, setInputMode] = useState<'mark' | 'roi' | 'control'>('mark');
  const [preview, setPreview] = useState<{
    dets: YoloPreviewDet[];
    ms: number;
    inferMs: number;
    queueMs: number;
    wallMs: number;
    device: string;
    width: number;
    height: number;
  } | null>(null);
  // 打开弹窗时冻结一张画面：标注/调参/检测都在静态图上做，画面不会动、框也不会闪
  const [snapshot, setSnapshot] = useState<{ url: string; width: number; height: number } | null>(null);
  // 帧缓冲元信息（引擎保留最近若干帧）：按 index 懒加载，不在前端存上千张图
  const bufferRef = useRef<{ indices: number[] } | null>(null);
  const frameCacheRef = useRef<Map<string, CachedFrame>>(new Map());
  const frameRequestsRef = useRef<Map<string, { session: number; promise: Promise<CachedFrame | null> }>>(
    new Map(),
  );
  const frameSessionActiveRef = useRef(open);
  // 时间轴轨道上的帧缩略图：先合并一小批，再提交不可变 Map，避免每帧 clone + render。
  const [frameThumbs, setFrameThumbs] = useState<ReadonlyMap<string, string>>(() => new Map());
  const frameThumbsRef = useRef(frameThumbs);
  const pendingThumbsRef = useRef(new Map<string, string>());
  const thumbTimerRef = useRef<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  const lastIndexRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  /** 回放帧率（界面上的 fps 选择，仿 Sequencer 的 30 fps 下拉） */
  const [playbackFps, setPlaybackFps] = useState(8);
  const takingRef = useRef<RecordingTake | null>(null);
  const [following, setFollowing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // 帧被新画面挤掉这类"正常现象"用提示语，不用红色报错：它不是用户做错了什么
  const [frameNote, setFrameNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [modelInfo, setModelInfo] = useState<{
    models: string[];
    model: string;
    device?: string;
  } | null>(null);
  // 旧引擎没有 yolo.models：别让「正在读取模型列表…」永远转着
  const [modelUnavailable, setModelUnavailable] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState<NormRect | null>(null);
  const dragRef = useRef<{ startX: number; startY: number } | null>(null);
  // 控制模式的指针手势：down/move/up 直接转成设备 touch（move 约 60Hz 限频）
  const controlRef = useRef<{ active: boolean; lastMoveAt: number }>({ active: false, lastMoveAt: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const frameAreaRef = useRef<HTMLDivElement>(null);
  const [fitBox, setFitBox] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null,
  );
  const previewIdRef = useRef<string>('preview');
  const markSeq = useRef(0);
  // 每次打开弹窗都是一个新会话：异步取帧/读示例回来时要能判断"这次结果是不是已经过期"
  const sessionRef = useRef(0);
  // 取帧是并发的：只用最后一次请求的结果更新画面，避免慢请求把新画面盖回去
  const frameSeqRef = useRef(0);
  // 示例参考图有变化：下一次预览把每张快照一起带过去（避免每帧都传图）
  const refsDirtyRef = useRef(true);

  const suggestedLabel = `ai_${(graph?.recognizers.length ?? 0) + 1}`;
  const label = labelOverride ?? suggestedLabel;
  const enabledMarks = marks.filter((item) => item.enabled);
  // worker 用什么设备推理：CPU 组件在这行直接标出来，否则用户只会看到"检测 10s"
  const previewDevice = preview
    ? preview.device === 'cuda'
      ? 'GPU'
      : preview.device === 'cpu'
        ? 'CPU'
        : String(preview.device ?? '').toUpperCase()
    : '';
  const deviceChip =
    modelInfo?.device === 'cuda' || runtimeDevice === 'cuda'
      ? { text: 'GPU', tone: 'text-confirmed', dot: 'bg-confirmed', title: 'worker 在 GPU（CUDA）上推理' }
      : modelInfo?.device === 'cpu' || runtimeDevice === 'cpu'
        ? {
            text: 'CPU',
            tone: 'text-pending',
            dot: 'bg-pending',
            title: 'worker 回落到了 CPU 推理：没装 CUDA 组件或 CUDA 不可用，会明显变慢',
          }
        : modelInfo
          ? { text: '加载中', tone: 'text-faint', dot: 'bg-idle', title: 'worker 未启动 / 模型加载中' }
          : null;
  const headerStatus = !deviceChip || deviceChip.text === '加载中' ? '组件就绪' : `${deviceChip.text} 推理`;

  const setCursorAt = useCallback((position: number): void => {
    cursorRef.current = position;
    setCursor(position);
  }, []);

  const clearFrameWork = useCallback((): void => {
    frameRequestsRef.current.clear();
    pendingThumbsRef.current.clear();
    if (thumbTimerRef.current !== null) {
      window.clearTimeout(thumbTimerRef.current);
      thumbTimerRef.current = null;
    }
  }, []);

  // 关闭/换设备/卸载时立即使未完成请求失效，不等下次打开的异步 reset。
  useEffect(() => {
    frameSessionActiveRef.current = open;
    return () => {
      frameSessionActiveRef.current = false;
      sessionRef.current += 1;
      clearFrameWork();
    };
  }, [open, deviceId, editLabel, clearFrameWork]);

  const rememberThumbnail = useCallback((key: string, url: string): void => {
    if (!frameSessionActiveRef.current) return;
    if ((pendingThumbsRef.current.get(key) ?? frameThumbsRef.current.get(key)) === url) return;
    pendingThumbsRef.current.set(key, url);
    if (thumbTimerRef.current !== null) return;
    const token = sessionRef.current;
    // 短定时器也适用于后台窗口和测试环境，不依赖 RAF 是否继续运行。
    thumbTimerRef.current = window.setTimeout(() => {
      thumbTimerRef.current = null;
      if (token !== sessionRef.current || !frameSessionActiveRef.current) return;
      const next = new Map(frameThumbsRef.current);
      for (const [pendingKey, pendingUrl] of pendingThumbsRef.current) {
        next.set(pendingKey, pendingUrl);
      }
      pendingThumbsRef.current.clear();
      while (next.size > 160) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      frameThumbsRef.current = next;
      setFrameThumbs(next);
    }, 16);
  }, []);

  const rememberFrame = useCallback(
    (key: string, cached: CachedFrame): void => {
      const cache = frameCacheRef.current;
      cache.set(key, cached);
      // 最多缓存 120 帧（几张画面，够一次回放），多了丢最老的
      if (cache.size > FRAME_CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
      rememberThumbnail(key, cached.url);
    },
    [rememberThumbnail],
  );

  /** 取一帧（带缓存）。取不到返回 null —— 调用方决定是回退还是忽略。 */
  const getFrame = useCallback(
    (absolute: number, recordingId?: string): Promise<CachedFrame | null> => {
      if (!frameSessionActiveRef.current) return Promise.resolve(null);
      const key = `${recordingId ?? 'buffer'}:${absolute}`;
      const cached = frameCacheRef.current.get(key);
      if (cached) {
        // 完整帧和时间轴缩略图独立淘汰：命中完整帧时仍须补回缺失的缩略图。
        rememberThumbnail(key, cached.url);
        return Promise.resolve(cached);
      }
      const token = sessionRef.current;
      const inflight = frameRequestsRef.current.get(key);
      if (inflight?.session === token) return inflight.promise;
      const promise = (async (): Promise<CachedFrame | null> => {
        try {
          // nearest：回放时请求的帧大概率已经被新画面挤掉了，让引擎给最近保留的一帧
          const payload = recordingId
            ? await recordingFrameAt(deviceId, recordingId, absolute)
            : await frameAt(deviceId, absolute, { nearest: true });
          // 关掉/重开弹窗后迟到的响应不能写进新会话的缓存
          if (token !== sessionRef.current || !frameSessionActiveRef.current) {
            return null;
          }
          const cachedFrame: CachedFrame = {
            url: `data:image/jpeg;base64,${payload.jpeg}`,
            index: payload.index,
            width: payload.width,
            height: payload.height,
          };
          // 缓冲帧可能已被挤掉；绝不把 nearest 返回的别帧缓存成请求帧。
          if (cachedFrame.index === absolute) {
            rememberFrame(key, cachedFrame);
          } else if (!recordingId) {
            rememberFrame(`buffer:${cachedFrame.index}`, cachedFrame);
          }
          return cachedFrame;
        } catch {
          return null;
        }
      })();
      frameRequestsRef.current.set(key, { session: token, promise });
      void promise.finally(() => {
        // 旧会话的完成回调不能删掉新会话同 key 的请求。
        if (frameRequestsRef.current.get(key)?.promise === promise) {
          frameRequestsRef.current.delete(key);
        }
      });
      return promise;
    },
    [deviceId, rememberFrame, rememberThumbnail],
  );

  /** 用引擎当前的真实缓冲同步进度条（帧号会跳号，缓冲也会被新帧挤动）。 */
  const syncBuffer = useCallback(
    async (displayedIndex: number | null): Promise<void> => {
      const token = sessionRef.current;
      try {
        const meta = await frameMeta(deviceId);
        if (token !== sessionRef.current) {
          return;
        }
        const indices = Array.isArray(meta?.indices) ? meta.indices : [];
        if (!meta || !meta.count || indices.length === 0) {
          bufferRef.current = null;
          return;
        }
        const next = { indices: [...indices] };
        bufferRef.current = next;
        if (displayedIndex !== null) {
          const position = indices.indexOf(displayedIndex);
          setCursorAt(position >= 0 ? position : indices.length - 1);
        }
      } catch {
        // 老引擎没有 meta：维持旧列表，取不到帧时再回退
      }
    },
    [deviceId, setCursorAt],
  );

  const captureSnapshot = useCallback(
    (keepPreview = false): void => {
      const token = sessionRef.current;
      const current = useSessionStore.getState().frames[deviceId];
      if (!current?.imageUrl) {
        if (token === sessionRef.current) {
          setSnapshot(null);
        }
        return;
      }
      const width = current.resolution[0];
      const height = current.resolution[1];
      // 帧图是 blob URL，会被下一帧替换/回收：转成 data URL 才冻得住
      void fetch(current.imageUrl)
        .then((response) => response.blob())
        .then(
          (blob) =>
            new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                if (typeof reader.result === 'string') {
                  resolve(reader.result);
                } else {
                  reject(new Error('读不出画面数据'));
                }
              };
              reader.onerror = () => reject(reader.error ?? new Error('读取画面失败'));
              reader.readAsDataURL(blob);
            }),
        )
        .then((url) => {
          if (token === sessionRef.current) {
            setSnapshot({ url, width, height });
          }
        })
        .catch(() => {
          if (token === sessionRef.current) {
            setSnapshot({ url: current.imageUrl, width, height });
          }
        });
      // 新会话 = 引擎也换一张冻结帧。停止检测时传 keepPreview：保留上一次的检测结果/统计，
      // 只是把画面冻在当前帧，避免"结果框还挂着、背景却是打开弹窗时的老画面"。
      if (!keepPreview) {
        previewIdRef.current = crypto.randomUUID();
        setPreview(null);
      }
    },
    [deviceId],
  );

  /** 把某一帧显示到画面上；帧被挤掉时自动落到最近一帧，绝不把引擎报错抛给用户。
   *  recordingId 可以显式传入：切换录制时不要靠 ref 猜，免得拿错录制的帧号。 */
  const showFrame = useCallback(
    async (absolute: number, source: FrameSource, recordingIdOverride?: string): Promise<void> => {
      if (source === 'prefetch') {
        await getFrame(absolute, recordingIdOverride ?? takingRef.current?.recordingId);
        return;
      }
      const token = sessionRef.current;
      const seq = ++frameSeqRef.current;
      const recordingId =
        recordingIdOverride ??
        (source === 'seek' || source === 'playback' || source === 'history'
          ? takingRef.current?.recordingId
          : undefined);
      const fetched = await getFrame(absolute, recordingId);
      if (token !== sessionRef.current || seq !== frameSeqRef.current) {
        return;
      }
      if (fetched) {
        setSnapshot({ url: fetched.url, width: fetched.width, height: fetched.height });
        lastIndexRef.current = fetched.index;
        if (source === 'seek' && fetched.index !== absolute) {
          setFrameNote('画面刷新很快，这一帧已被挤掉 · 已跳到最近保留的一帧');
          await syncBuffer(fetched.index);
        }
        return;
      }
      if (recordingId || source === 'playback') {
        setFrameNote('录制帧暂时无法读取，请重试');
        return;
      }
      // 旧引擎（不认识 nearest）或这一次取帧失败：退到最新画面，别让对话框停在一张取不到的脸上
      const meta = await frameMeta(deviceId).catch(() => null);
      if (token !== sessionRef.current || seq !== frameSeqRef.current) {
        return;
      }
      const indices = Array.isArray(meta?.indices) ? meta.indices : [];
      const latest = indices[indices.length - 1];
      if (latest === undefined) {
        setFrameNote('画面还没准备好');
        return;
      }
      const fallback = await getFrame(latest);
      if (token !== sessionRef.current || seq !== frameSeqRef.current || !fallback) {
        return;
      }
      setSnapshot({ url: fallback.url, width: fallback.width, height: fallback.height });
      lastIndexRef.current = fallback.index;
      await syncBuffer(fallback.index);
      setFrameNote(source === 'seek' ? '这一帧已经取不到了 · 已跳到最新画面' : '已跳到最新画面');
    },
    [deviceId, getFrame, syncBuffer],
  );

  const {
    takes,
    activeTakeId,
    recording,
    recordSeconds,
    liveTake,
    taking,
    toggleRecording,
    selectTake,
    removeTake,
    resetRecordings,
  } = useYoloRecording({
    deviceId,
    frameFps: frame?.fps,
    setFrameNote,
    setCursorAt,
    setFollowing,
    setPlaying,
    setPreview,
    showFrame,
    takingRef,
  });
  // 录制中时间轴跟着活 take 长；停止后切到正式 take
  const timelineTake = recording ? liveTake : taking;
  const timelineIndices = timelineTake?.indices ?? [];

  // 时间轴按需取缩略图：轨道上缺哪一帧就补哪一帧（录制中边录边补），
  // recordingId 由轨道直接带过来，避免切换录制时用错 ID。
  const requestTimelineThumb = useCallback(
    async (absolute: number, recordingId?: string): Promise<void> => {
      if (!recordingId) return;
      await getFrame(absolute, recordingId);
    },
    [getFrame],
  );

  const loadModelInfo = useCallback(async (): Promise<void> => {
    try {
      const result = await yoloModels();
      setModelInfo({ models: [...result.models], model: result.model, device: result.device });
      setModelUnavailable(false);
    } catch {
      // 旧引擎没有模型接口：显示一句说明，不显示模型行
      setModelInfo(null);
      setModelUnavailable(true);
    }
  }, []);

  const switchModel = useCallback(async (name: string): Promise<void> => {
    setModelBusy(true);
    setModelNote(null);
    try {
      const result = await yoloSetModel(name);
      setModelInfo({ models: [...result.models], model: result.model, device: result.device });
      setModelNote('已切换：下一次检测时加载新模型（约 3–10 秒）');
      setPreview(null);
    } catch (caught) {
      setModelNote(messageOf(caught));
    } finally {
      setModelBusy(false);
    }
  }, []);

  const addModel = useCallback(async (): Promise<void> => {
    const picked = await pickFileResult('选择 YOLOE 权重（.pt，或内含 .pt 的 .zip）', ['pt', 'zip']);
    if (picked.kind === 'cancelled') {
      return;
    }
    if (picked.kind === 'unavailable') {
      setModelNote(`原生文件选择不可用：${picked.reason}`);
      return;
    }
    setModelBusy(true);
    setModelNote(null);
    try {
      const added = await yoloAddModel(picked.path);
      const first = added.added[0];
      if (first) {
        await switchModel(first);
        if (added.added.length > 1) {
          setModelNote(`已导入 ${added.added.length} 个模型，已切到 ${first}`);
        }
      } else {
        await loadModelInfo();
      }
    } catch (caught) {
      setModelNote(messageOf(caught));
    } finally {
      setModelBusy(false);
    }
  }, [loadModelInfo, switchModel]);

  // 回放：按 ~8fps 逐帧走缓冲帧，播到底自动停；同时预取后面几帧。
  // 注意：预取只进缓存、不直接换画面，否则画面会抢在光标前面跳帧。
  useEffect(() => {
    if (!playing) {
      return;
    }
    const timer = window.setInterval(() => {
      const current = timelineTake;
      const total = current?.indices.length ?? 0;
      if (!current || total < 2) {
        setPlaying(false);
        return;
      }
      const next = cursorRef.current + 1;
      if (next >= total) {
        setPlaying(false);
        return;
      }
      setCursorAt(next);
      const absolute = current.indices[next];
      if (absolute === undefined) {
        return;
      }
      void showFrame(absolute, 'playback', current.recordingId);
      for (let ahead = next + 1; ahead <= Math.min(total - 1, next + PREFETCH_AHEAD); ahead += 1) {
        const index = current.indices[ahead];
        if (index !== undefined) {
          void showFrame(index, 'prefetch', current.recordingId);
        }
      }
    }, 1000 / playbackFps);
    return () => window.clearInterval(timer);
  }, [playing, playbackFps, setCursorAt, showFrame, timelineTake]);

  // 实时跟随：持续取最新帧（拖动进度条或回放时自动暂停）。
  // 编辑模式同样允许跟随：老示例是归一化坐标，换到当前画面上继续框新示例是正常操作。
  useEffect(() => {
    if (!following) {
      return;
    }
    const timer = window.setInterval(() => {
      void (async () => {
        const token = sessionRef.current;
        try {
          const meta = await frameMeta(deviceId);
          if (token !== sessionRef.current) {
            return;
          }
          const indices = Array.isArray(meta?.indices) ? meta.indices : [];
          const latest = indices[indices.length - 1];
          if (!meta || !meta.count || latest === undefined) {
            return;
          }
          if (latest === lastIndexRef.current) {
            return;
          }
          const next = { indices: [...indices] };
          bufferRef.current = next;
          // 实时画面不推动录制时间轴，后台录制与当前浏览位置独立。
          await showFrame(latest, 'follow');
        } catch {
          // 跟随失败不弹错：下次轮询再试
        }
      })();
    }, 150);
    return () => window.clearInterval(timer);
  }, [following, deviceId, setCursorAt, showFrame]);

  const seekFrame = useCallback(
    (position: number): void => {
      const current = timelineTake?.indices ?? [];
      const total = current.length;
      if (total === 0) {
        return;
      }
      const next = Math.min(total - 1, Math.max(0, position));
      setCursorAt(next);
      setPlaying(false);
      setFollowing(false);
      setPreview(null);
      const absolute = current[next];
      if (absolute !== undefined) {
        void showFrame(absolute, 'seek', timelineTake?.recordingId);
      }
    },
    [setCursorAt, showFrame, timelineTake],
  );

  const toggleDetection = (): void => {
    if (running) {
      setRunning(false);
      captureSnapshot(true);
    } else {
      setPlaying(false);
      setFollowing(false);
      setLocalError(null);
      setRunning(true);
    }
  };

  /** 时间轴拖动：实时检测中拖动就先停下检测，让用户能真正"切帧"看画面。 */
  const handleSeek = useCallback(
    (position: number): void => {
      if (running) {
        setRunning(false);
        setFrameNote('拖动时间轴：已停止实时检测');
      }
      seekFrame(position);
    },
    [running, seekFrame],
  );

  const loadDetail = useCallback(async (): Promise<void> => {
    if (!editLabel) {
      return;
    }
    const token = sessionRef.current;
    try {
      const detail = await recognizerDetail(deviceId, editLabel);
      // 期间又点了新建/换了一个识别器：这份结果已经过期，别覆盖当前会话
      if (token !== sessionRef.current) {
        return;
      }
      setLabelOverride(detail.label);
      setConf(detail.threshold);
       setRoi(detail.roi ? (detail.roi as NormRect) : null);
      setSearch(detail.search);
      setImgsz(detail.imgsz);
      setTile(detail.tile);
      setTileSize(detail.tileSize);
      const loaded = detail.examples.map((item, index) => ({
        id: `e${index}`,
        rect: item.rect as NormRect,
        label: item.label,
        enabled: true,
        color: MARK_COLORS[index % MARK_COLORS.length] ?? '#4ade80',
        image: item.image,
        width: item.width || 1,
        height: item.height || 1,
      }));
      setMarks(loaded);
      setPreview(null);
      // 用第一个示例的参考帧当背景，已有框才能对上位置；
      // 老识别器可能没存参考图（image 为空）——这时退到当前画面，保证还能继续框新示例
      const first = detail.examples[0];
      bufferRef.current = null;
      setCursorAt(0);
      lastIndexRef.current = null;
      if (first && first.image) {
        setSnapshot({ url: first.image, width: first.width || 1, height: first.height || 1 });
      } else {
        setSnapshot(null);
        captureSnapshot();
      }
      setModelNote(null);
    } catch (caught) {
      if (token === sessionRef.current) {
        setLocalError(messageOf(caught));
      }
    }
  }, [deviceId, editLabel, setCursorAt, captureSnapshot]);

  const loadHistory = useCallback(async (): Promise<void> => {
    const token = sessionRef.current;
    setPreview(null);
    frameSeqRef.current += 1;
    previewIdRef.current = crypto.randomUUID();
    try {
      const meta = await frameMeta(deviceId);
      if (token !== sessionRef.current) {
        return;
      }
      if (!meta || !meta.count) {
        bufferRef.current = null;
        captureSnapshot();
        return;
      }
      const indices = Array.isArray(meta.indices) ? meta.indices : [];
      const latest = indices[indices.length - 1];
      if (latest === undefined) {
        bufferRef.current = null;
        captureSnapshot();
        return;
      }
      const next = { indices: [...indices] };
      bufferRef.current = next;
      setCursorAt(indices.length - 1);
      lastIndexRef.current = latest;
      await showFrame(latest, 'history');
      // 取最新若干帧当画面，并顺手预热最近几帧（拖动/回放基本不用等）
      for (let back = 1; back <= 8; back += 1) {
        const position = indices.length - 1 - back;
        const index = indices[position];
        if (position < 0 || index === undefined) {
          break;
        }
        void showFrame(index, 'prefetch');
      }
    } catch {
      // 老引擎没有 meta：退回单帧快照
      if (token === sessionRef.current) {
        captureSnapshot();
      }
    }
  }, [deviceId, captureSnapshot, setCursorAt, showFrame]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void refresh();
    // 打开弹窗就后台预热 worker：模型加载完，状态从「未启动」变成 GPU/CPU
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void yoloWarmup()
        .then(() => {
          if (!cancelled) {
            void loadModelInfo();
          }
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, refresh, loadModelInfo]);

  // 每次打开都是一次全新的会话：上一个识别器的示例框/阈值/快照绝不能带进来。
  // 关闭时组件并没有卸载（`open=false` 只返回 null），状态会一直留着。
  const resetSession = useCallback((): void => {
    resetRecordings();
    sessionRef.current += 1;
    frameSeqRef.current += 1;
    markSeq.current = 0;
    refsDirtyRef.current = true;
    previewIdRef.current = crypto.randomUUID();
    setMarks([]);
    setLabelOverride(null);
    setConf(0.3);
    setSearch('region');
    setIou(0.45);
    setImgsz(640);
    setTile(false);
    setTileSize(640);
    setRunning(false);
    setPreview(null);
    bufferRef.current = null;
    lastIndexRef.current = null;
    frameCacheRef.current.clear();
    clearFrameWork();
    const emptyThumbs = new Map<string, string>();
    frameThumbsRef.current = emptyThumbs;
    setFrameThumbs(emptyThumbs);
    setFollowing(false);
    setPlaying(false);
    setCursorAt(0);
    setSnapshot(null);
    setDragging(null);
    setLocalError(null);
    setFrameNote(null);
    setModelNote(null);
    dragRef.current = null;
  }, [resetRecordings, setCursorAt, clearFrameWork]);

  // 延后一拍再取帧：避免在 effect 里同步 setState（也让首帧先渲染出来）
  useEffect(() => {
    if (!open) {
      return;
    }
    // 先清空上一个会话，再按模式装载（新建=取帧 / 编辑=读示例）
    const timer = window.setTimeout(() => {
      resetSession();
      if (isEditMode) {
        void loadDetail();
      } else {
        void loadHistory();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, isEditMode, resetSession, loadDetail, loadHistory]);

  const componentReady = Boolean(status?.installed) || runtimeAvailable;
  useEffect(() => {
    if (!open || !componentReady || modelInfo) {
      return;
    }
    const timer = window.setTimeout(() => void loadModelInfo(), 0);
    return () => window.clearTimeout(timer);
  }, [open, componentReady, modelInfo, loadModelInfo]);

  const ready = Boolean(status?.installed) || runtimeAvailable;
  // 刚打开弹窗时 status 还在查：别在这 1~2 秒里谎报「未安装 AI 组件」
  const checkingComponent = loading && !ready;
  const canSave = ready && label.trim().length > 0 && enabledMarks.length > 0 && !saving;
  const saveHint = !ready
    ? checkingComponent
      ? '正在检查 AI 组件…'
      : '先安装 AI 组件'
    : label.trim().length === 0
      ? '先填一个识别器名称'
      : enabledMarks.length === 0
        ? '先在左侧框一个示例'
        : null;
  const resW = preview?.width ?? snapshot?.width ?? frame?.resolution[0] ?? 1;
  const resH = preview?.height ?? snapshot?.height ?? frame?.resolution[1] ?? 1;
  // 标注用冻结帧（不动）；实时检测时切到当前帧（真·实时）
  const displayUrl = running ? (frame?.imageUrl ?? snapshot?.url) : snapshot?.url;
  const displayW = running ? (frame?.resolution[0] ?? snapshot?.width ?? 1) : (snapshot?.width ?? 1);
  const displayH = running ? (frame?.resolution[1] ?? snapshot?.height ?? 1) : (snapshot?.height ?? 1);

  // 画面按「可用区域」等比自适应（含黑边），框坐标相对这块画面算，始终对齐
  useEffect(() => {
    const node = frameAreaRef.current;
    if (!node) {
      return;
    }
    let raf = 0;
    let last = '';
    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      const box = containBox(
        { width: rect.width, height: rect.height },
        { width: Math.max(1, displayW), height: Math.max(1, displayH) },
      );
      if (box) {
        const key = `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}`;
        if (key !== last) {
          last = key;
          setFitBox(box);
        }
      }
      raf = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(raf);
  }, [displayW, displayH]);

  const pointOf = (event: ReactPointerEvent<HTMLDivElement>): [number, number] => {
    const element = boxRef.current;
    if (!element) {
      return [0, 0];
    }
    const bounds = element.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
    return [x, y];
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const [x, y] = pointOf(event);
    if (inputMode === 'control') {
      controlRef.current = { active: true, lastMoveAt: 0 };
      setFrameNote(null);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 指针可能已经释放
      }
      void touchDevice(deviceId, 'down', x, y);
      return;
    }
    dragRef.current = { startX: x, startY: y };
    setDragging([x, y, 0, 0]);
    setFrameNote(null);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (inputMode === 'control') {
      const control = controlRef.current;
      if (!control.active) {
        return;
      }
      const now = performance.now();
      if (now - control.lastMoveAt < 16) {
        return;
      }
      control.lastMoveAt = now;
      const [x, y] = pointOf(event);
      void touchDevice(deviceId, 'move', x, y);
      return;
    }
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    const [x, y] = pointOf(event);
    setDragging([
      Math.min(drag.startX, x),
      Math.min(drag.startY, y),
      Math.abs(x - drag.startX),
      Math.abs(y - drag.startY),
    ]);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 忽略：指针可能已经释放
    }
    if (inputMode === 'control') {
      const control = controlRef.current;
      control.active = false;
      const [x, y] = pointOf(event);
      void touchDevice(deviceId, 'up', x, y);
      return;
    }
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(null);
    if (!drag) {
      return;
    }
    // 用松手时的真实坐标，而不是上次 pointermove 的 React 状态（可能滞后一帧）。
    const [x, y] = pointOf(event);
    const rect: NormRect = [
      Math.min(drag.startX, x),
      Math.min(drag.startY, y),
      Math.abs(x - drag.startX),
      Math.abs(y - drag.startY),
    ];
    if (rect[2] < 0.02 || rect[3] < 0.02) {
      return;
    }
    if (inputMode === 'roi') {
      setRoi(rect);
      // 一次框选就够：回到标注模式（还要改就再点「重画 ROI」），
      // 否则按钮会一直停在「在画面上拖框…」，看起来像没记下来。
      setInputMode('mark');
      setFrameNote('ROI 已记录：之后只在这个区域内搜索');
      return;
    }
    if (!snapshot) {
      return;
    }
    markSeq.current += 1;
    const id = `m${markSeq.current}`;
    setMarks((current) => [
      ...current,
      {
        id,
        rect,
        label: label.trim() || `目标${current.length + 1}`,
        enabled: true,
        color: MARK_COLORS[current.length % MARK_COLORS.length] ?? '#4ade80',
        image: snapshot.url,
        width: snapshot.width,
        height: snapshot.height,
      },
    ]);
    refsDirtyRef.current = true;
  };

  const removeMark = (id: string): void => {
    refsDirtyRef.current = true;
    setMarks((current) => current.filter((item) => item.id !== id));
  };

  /** 切换标注/控制：不能把上一模式的手势带过去（否则会拖出一个假框/假滑动）。 */
  const switchInputMode = (mode: 'mark' | 'roi' | 'control'): void => {
    dragRef.current = null;
    controlRef.current.active = false;
    setDragging(null);
    setInputMode(mode);
  };

  /** 设置面板里的「标记 ROI」：实时检测会挡住拖框，所以先停下来再切模式。 */
  const startRoi = (): void => {
    if (running) {
      setRunning(false);
      setFrameNote('标记 ROI：已停止实时检测');
    }
    switchInputMode('roi');
  };

  const toggleMark = (id: string): void => {
    refsDirtyRef.current = true;
    setMarks((current) =>
      current.map((item) => (item.id === id ? { ...item, enabled: !item.enabled } : item)),
    );
  };

  // 实时检测：按当前参数循环调预览，结果画在画面上
  useEffect(() => {
    if (!open || !running) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const tick = async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      const active = marks.filter((item) => item.enabled);
      if (active.length === 0) {
        setPreview(null);
        timer = window.setTimeout(() => void tick(), 400);
        return;
      }
      try {
        const startedAt = Date.now();
        const result = await previewYolo(deviceId, {
          previewId: previewIdRef.current,
          examples: active.map((item) => ({
            rect: item.rect,
            label: item.label,
            ...(refsDirtyRef.current && item.image ? { image: item.image } : {}),
          })),
          conf,
          iou,
          imgsz,
          tile,
          tileSize,
          // 实时检测跑当前帧；冻结只用于标注
          freeze: false,
          roi: roi ?? undefined,
        });
        if (!cancelled) {
          refsDirtyRef.current = false;
          setPreview({
            dets: result.dets,
            ms: result.ms,
            inferMs: result.inferMs,
            queueMs: result.queueMs,
            wallMs: Date.now() - startedAt,
            device: result.device,
            width: result.width,
            height: result.height,
          });
          setLocalError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setLocalError(messageOf(caught));
          setRunning(false);
        }
        return;
      }
      if (!cancelled) {
        timer = window.setTimeout(() => void tick(), 30);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [open, running, marks, conf, iou, imgsz, tile, tileSize, deviceId, roi]);

  // 帧被挤掉的提示是"瞬时信息"：几秒后自己消失，不占着底部永远不走了
  useEffect(() => {
    if (!frameNote) {
      return;
    }
    const timer = window.setTimeout(() => setFrameNote(null), 4000);
    return () => window.clearTimeout(timer);
  }, [frameNote]);

  // Esc 关闭（和项目里其它临时浮层一致）
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, saving, onClose]);

  const installFromFile = async (): Promise<void> => {
    const picked = await pickFileResult('选择 AI 组件包（.zip）', ['zip']);
    if (picked.kind === 'cancelled') {
      return;
    }
    if (picked.kind === 'unavailable') {
      useYoloStore.setState({ error: `原生文件选择不可用：${picked.reason}` });
      return;
    }
    await install(picked.path);
  };

  const submit = async (): Promise<void> => {
    if (!canSave) {
      return;
    }
    setSaving(true);
    const spec = {
      type: 'yolo',
      examples: enabledMarks.map((item) => ({
        rect: item.rect,
        label: item.label,
        image: item.image,
      })),
      classes: [],
      threshold: conf,
      search,
      imgsz,
      tile,
      tile_size: tileSize,
      tile_overlap: 0.2,
      // 显式传 null = 清除 ROI（引擎收到 null 会删掉旧值，不会残留局部搜索区域）
      roi,
    };
    const ok =
      isEditMode && editLabel
        ? await update(deviceId, editLabel, spec, label.trim())
        : await create(deviceId, label.trim(), spec);
    setSaving(false);
    if (ok) {
      setMarks([]);
      setPreview(null);
      setLabelOverride(null);
      setRunning(false);
      onClose();
    }
  };

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={onClose}
    >
      <div
        data-testid="yolo-recognizer-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={isEditMode ? `编辑 AI 识别器 ${editLabel}` : 'AI 识别器'}
        className="flex h-[min(92vh,900px)] w-[min(1240px,96vw)] flex-col overflow-hidden rounded-md border border-line bg-panel text-body"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {/* 标题栏：只放身份和状态；「安装组件」挪进右栏，和「导入模型」彻底分开 */}
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
          <Sparkles className="size-3.5 shrink-0 text-brand" strokeWidth={1.75} />
          <span className="shrink-0 text-panelhead font-medium text-fg">AI 识别</span>
          <span className="truncate text-badge text-faint">
            {isEditMode ? `编辑 ${editLabel}` : '框示例 → 实时检测 → 保存'}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {ready ? (
              <span
                className="inline-flex items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-dim"
                title={deviceChip?.title}
              >
                <span className={cn('size-1.5 rounded-full', deviceChip?.dot ?? 'bg-idle')} />
                {headerStatus}
              </span>
            ) : checkingComponent ? (
              <span className="inline-flex items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-faint">
                <span className="size-1.5 animate-pulse rounded-full bg-idle" />
                检查组件…
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-sm border border-pending/40 px-1.5 py-0.5 text-[10px] text-pending">
                <span className="size-1.5 rounded-full bg-pending" />
                未安装 AI 组件
              </span>
            )}
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              className="flex size-6 items-center justify-center rounded-sm text-dim hover:bg-raised hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_316px] lg:overflow-hidden">
          {/* 左侧两个独立区域：画面操作在上，录制与时间轴在下。 */}
          <div
            data-testid="yolo-workspace"
            className="flex min-h-[320px] min-w-0 flex-col bg-panel lg:min-h-0"
          >
            <div data-testid="yolo-screen-panel" className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
              <YoloVideoStage
                frameAreaRef={frameAreaRef}
                boxRef={boxRef}
                fitBox={fitBox}
                displayUrl={displayUrl}
                marks={marks}
                roi={roi}
                preview={preview}
                previewDevice={previewDevice}
                running={running}
                inputMode={inputMode}
                isEditMode={isEditMode}
                dragging={dragging}
                resW={resW}
                resH={resH}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onRetry={() => captureSnapshot()}
              />
              <YoloPlaybackToolbar
                running={running}
                recording={recording}
                following={following}
                playing={playing}
                cursor={cursor}
                total={timelineIndices.length}
                isEditMode={isEditMode}
                playbackFps={playbackFps}
                onSeek={handleSeek}
                onFollow={() => {
                  setPlaying(false);
                  if (!following) setPreview(null);
                  setFollowing((value) => !value);
                }}
                onPlayTake={() => {
                  setFollowing(false);
                  if (playing) {
                    setPlaying(false);
                  } else if (timelineIndices.length > 1) {
                    if (cursor >= timelineIndices.length - 1) handleSeek(0);
                    setPlaying(true);
                  }
                }}
                onRefresh={() => void loadHistory()}
                onPlaybackFpsChange={setPlaybackFps}
              />
            </div>

            <YoloRecordingPanel
              recording={recording}
              recordSeconds={recordSeconds}
              inputMode={inputMode}
              marksCount={marks.length}
              takes={takes}
              activeTakeId={activeTakeId}
              currentTake={taking}
              liveTake={liveTake}
              cursor={cursor}
              frameFps={frame?.fps}
              playbackFps={playbackFps}
              thumbnails={frameThumbs}
              onRecord={() => void toggleRecording()}
              onModeChange={switchInputMode}
              onClearMarks={() => {
                refsDirtyRef.current = true;
                setMarks([]);
              }}
              onSelectTake={selectTake}
              onRemoveTake={removeTake}
              onSeek={handleSeek}
              onRequestThumbnail={requestTimelineThumb}
            />
          </div>

          <YoloSettingsPanel
            marks={marks}
            enabledMarks={enabledMarks}
            refsDirtyRef={refsDirtyRef}
            setMarks={setMarks}
            toggleMark={toggleMark}
            removeMark={removeMark}
            isEditMode={isEditMode}
            label={label}
            setLabelOverride={setLabelOverride}
            conf={conf}
            setConf={setConf}
            iou={iou}
            setIou={setIou}
            imgsz={imgsz}
            setImgsz={setImgsz}
            tile={tile}
            setTile={setTile}
            tileSize={tileSize}
            setTileSize={setTileSize}
            search={search}
            setSearch={setSearch}
            roi={roi}
            setRoi={setRoi}
            roiResolution={
              snapshot ? ([snapshot.width, snapshot.height] as const) : (frame?.resolution ?? null)
            }
            onStartRoi={startRoi}
            roiModeActive={inputMode === 'roi'}
            modelInfo={modelInfo}
            modelBusy={modelBusy}
            running={running}
            switchModel={switchModel}
            addModel={addModel}
            deviceChip={deviceChip}
            modelNote={modelNote}
            modelUnavailable={modelUnavailable}
            ready={ready}
            status={status}
            installFromFile={installFromFile}
            checkingComponent={checkingComponent}
            installing={installing}
            loading={loading}
            progress={progress}
            stage={stage}
            install={install}
            error={error}
            refresh={refresh}
            runtimeError={runtimeError}
            preview={preview}
            previewDevice={previewDevice ?? ''}
            toggleDetection={toggleDetection}
          />
        </div>

        {/* 底部操作：主操作靠右，不再是一条铺满整行的「保存识别器」 */}
        <footer className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
          <div className="min-w-0 flex-1 truncate text-badge">
            {localError ? (
              <span className="text-failed">{localError}</span>
            ) : frameNote ? (
              <span className="text-pending">{frameNote}</span>
            ) : saveHint ? (
              <span className="text-faint">{saveHint}</span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-7 shrink-0 rounded-sm border border-line px-3 text-body text-dim hover:bg-raised hover:text-fg"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="yolo-save"
            disabled={!canSave}
            title={ready ? (enabledMarks.length ? undefined : '先框一个示例') : '先安装 AI 组件'}
            onClick={() => void submit()}
            className={cn(
              'h-7 shrink-0 rounded-sm bg-brand px-4 text-body font-medium text-[#0b0d12] enabled:hover:opacity-90',
              !canSave && 'cursor-not-allowed opacity-40',
            )}
          >
            {saving ? '保存中…' : isEditMode ? '保存修改' : '保存识别器'}
          </button>
        </footer>
      </div>
    </div>
  );
}
