import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { RecordingTake } from '@/features/device/YoloMediaPanels';
import { isUnknownMethodError, staleEngineHint } from '@/lib/engine-methods';
import { recordingDelete, recordingMeta, recordingStart, recordingStop } from '@/lib/rpc';

type FrameSource = 'seek' | 'playback' | 'follow' | 'history' | 'prefetch';

interface RecordingOptions {
  deviceId: string;
  frameFps?: number;
  setFrameNote: (note: string | null) => void;
  setCursorAt: (position: number) => void;
  setFollowing: (following: boolean) => void;
  setPlaying: (playing: boolean) => void;
  setPreview: (preview: null) => void;
  showFrame: (absolute: number, source: FrameSource) => Promise<void>;
  takingRef: RefObject<RecordingTake | null>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Owns manual recordings and their takes; the caller still owns timeline and frame display. */
export function useYoloRecording({
  deviceId,
  frameFps,
  setFrameNote,
  setCursorAt,
  setFollowing,
  setPlaying,
  setPreview,
  showFrame,
  takingRef,
}: RecordingOptions) {
  const [takes, setTakes] = useState<RecordingTake[]>([]);
  const takesRef = useRef<RecordingTake[]>([]);
  const [activeTakeId, setActiveTakeId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  /** 录制中的「活 take」：引擎边录边落盘，前端轮询 meta 让时间轴实时长出来 */
  const [liveTake, setLiveTake] = useState<RecordingTake | null>(null);
  const liveTakeRef = useRef<RecordingTake | null>(null);
  const liveIndicesRef = useRef<number[]>([]);
  /** 录制是否还在进行：停止瞬间就置 false，挡住还在飞的轮询把光标/状态改回去 */
  const recordingActiveRef = useRef(false);
  const activeRecordingRef = useRef<string | null>(null);
  const recordingBusyRef = useRef(false);
  const takeSeq = useRef(0);
  const latestFpsRef = useRef(frameFps);
  useEffect(() => {
    latestFpsRef.current = frameFps;
  }, [frameFps]);
  const recordedFpsRef = useRef<number | undefined>(undefined);
  const taking = takes.find((item) => item.id === activeTakeId) ?? null;
  // Increment on reset so a late RPC from the previous dialog session cannot add a take.
  const generationRef = useRef(0);

  useEffect(() => {
    takingRef.current = taking;
  }, [taking, takingRef]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setRecordSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  // 录制中轮询引擎的录屏 meta：时间轴边录边长，不用等停止才看到帧。
  // 同时把 takingRef 指到活 take，这样录制中拖动时间轴也能按 recordingId 取回那一帧。
  useEffect(() => {
    if (!recording) return;
    const recordingId = activeRecordingRef.current;
    if (!recordingId) return;
    const generation = generationRef.current;
    let cancelled = false;
    let busy = false;
    const tick = async (): Promise<void> => {
      if (busy || !recordingActiveRef.current || cancelled || generation !== generationRef.current) return;
      busy = true;
      try {
        const gathered: number[] = [];
        // 从上次拿到的最后一帧往后翻页：录制久了也不用每轮从头扫
        let afterIndex: number | undefined = liveIndicesRef.current.at(-1);
        for (let page = 0; page < 20; page += 1) {
          const result = await recordingMeta(deviceId, recordingId, afterIndex);
          if (!recordingActiveRef.current || cancelled || generation !== generationRef.current) return;
          gathered.push(...(result.indices ?? []));
          if (!result.hasMore || result.nextAfterIndex == null || result.nextAfterIndex === afterIndex) {
            break;
          }
          afterIndex = result.nextAfterIndex;
        }
        const lastKnown = liveIndicesRef.current.at(-1) ?? -1;
        const appended = gathered.filter((index) => index > lastKnown);
        if (appended.length === 0) return;
        const nextIndices = liveIndicesRef.current.concat(appended);
        liveIndicesRef.current = nextIndices;
        const live: RecordingTake = {
          id: `live-${recordingId}`,
          recordingId,
          label: '录制中',
          indices: nextIndices,
          createdAt: Date.now(),
          fps: recordedFpsRef.current,
        };
        liveTakeRef.current = live;
        takingRef.current = live;
        setLiveTake(live);
      } catch {
        // 旧引擎/暂时读不到：下一轮再试，不打断录制
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 350);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [deviceId, recording, takingRef]);

  const toggleRecording = useCallback(async (): Promise<void> => {
    if (recordingBusyRef.current) return;
    recordingBusyRef.current = true;
    const generation = generationRef.current;
    try {
      if (!recording) {
        try {
          const result = await recordingStart(deviceId);
          if (generation !== generationRef.current) {
            void recordingStop(deviceId, result.recordingId)
              .catch(() => undefined)
              .finally(() => void recordingDelete(deviceId, result.recordingId).catch(() => undefined));
            return;
          }
          activeRecordingRef.current = result.recordingId;
          liveIndicesRef.current = [];
          const fps = latestFpsRef.current;
          recordedFpsRef.current = typeof fps === 'number' && fps > 0 ? fps : undefined;
          // 仅开始后台采集，保留当前画面跟随、回放和交互状态。
          recordingActiveRef.current = true;
          setRecording(true);
          setRecordSeconds(0);
          setFrameNote(null);
        } catch (caught) {
          if (generation === generationRef.current) {
            const detail = messageOf(caught);
            setFrameNote(
              isUnknownMethodError(detail) ? staleEngineHint(['recording.start']) : `无法开始录制：${detail}`,
            );
          }
        }
        return;
      }
      const recordingId = activeRecordingRef.current;
      if (!recordingId) return;
      recordingActiveRef.current = false;
      setRecording(false);
      activeRecordingRef.current = null;
      try {
        await recordingStop(deviceId, recordingId);
        const indices: number[] = [];
        let afterIndex: number | undefined;
        while (true) {
          if (generation !== generationRef.current) {
            void recordingDelete(deviceId, recordingId).catch(() => undefined);
            return;
          }
          const page = await recordingMeta(deviceId, recordingId, afterIndex);
          indices.push(...(page.indices ?? []));
          if (!page.hasMore || page.nextAfterIndex == null || page.nextAfterIndex === afterIndex) break;
          afterIndex = page.nextAfterIndex;
        }
        if (generation !== generationRef.current) {
          void recordingDelete(deviceId, recordingId).catch(() => undefined);
          return;
        }
        if (indices.length === 0) {
          await recordingDelete(deviceId, recordingId);
          liveTakeRef.current = null;
          setLiveTake(null);
          if (generation === generationRef.current) {
            setFrameNote('录制结束：没有拿到帧（先让画面出帧再录）');
          }
          return;
        }
        takeSeq.current += 1;
        const take: RecordingTake = {
          id: `take-${Date.now()}`,
          recordingId,
          label: `录制 ${takeSeq.current}`,
          indices,
          createdAt: Date.now(),
          fps: recordedFpsRef.current,
        };
        takesRef.current = [take, ...takesRef.current];
        takingRef.current = take;
        liveTakeRef.current = null;
        liveIndicesRef.current = [];
        setLiveTake(null);
        setTakes(takesRef.current);
        setActiveTakeId(take.id);
        // 保存只更新录制列表；不抢画面、不冻结实时、不覆盖正在标注的参考帧。
        if (generation === generationRef.current) {
          setFrameNote(`已保存 ${take.label}（${indices.length} 帧）`);
        }
      } catch (caught) {
        liveTakeRef.current = null;
        setLiveTake(null);
        if (generation === generationRef.current) {
          setFrameNote(`录制失败：${messageOf(caught)}`);
        } else {
          void recordingDelete(deviceId, recordingId).catch(() => undefined);
        }
      }
    } finally {
      if (generation === generationRef.current) recordingBusyRef.current = false;
    }
  }, [deviceId, recording, setFrameNote, takingRef]);

  const selectTake = useCallback(
    (id: string): void => {
      const take = takesRef.current.find((item) => item.id === id);
      if (!take || take.indices.length === 0) return;
      takingRef.current = take;
      setActiveTakeId(id);
      setFollowing(false);
      setPlaying(false);
      setPreview(null);
      setCursorAt(take.indices.length - 1);
      const last = take.indices[take.indices.length - 1];
      if (last !== undefined) void showFrame(last, 'history');
    },
    [setCursorAt, setFollowing, setPlaying, setPreview, showFrame, takingRef],
  );

  const removeTake = useCallback(
    (id: string): void => {
      const recordingId = takesRef.current.find((item) => item.id === id)?.recordingId;
      if (recordingId) void recordingDelete(deviceId, recordingId);
      takesRef.current = takesRef.current.filter((item) => item.id !== id);
      setTakes(takesRef.current);
      if (takingRef.current?.id === id) {
        takingRef.current = null;
        setActiveTakeId(null);
        setCursorAt(0);
      }
    },
    [deviceId, setCursorAt, takingRef],
  );

  /** Called by the parent session reset; discards recordings belonging to the old session. */
  const resetRecordings = useCallback((): void => {
    generationRef.current += 1;
    recordingActiveRef.current = false;
    recordingBusyRef.current = false;
    const active = activeRecordingRef.current;
    activeRecordingRef.current = null;
    if (active) {
      void recordingStop(deviceId, active)
        .catch(() => undefined)
        .finally(() => void recordingDelete(deviceId, active).catch(() => undefined));
    }
    for (const take of takesRef.current) {
      void recordingDelete(deviceId, take.recordingId).catch(() => undefined);
    }
    takesRef.current = [];
    takingRef.current = null;
    liveTakeRef.current = null;
    liveIndicesRef.current = [];
    setLiveTake(null);
    setTakes([]);
    setActiveTakeId(null);
    setRecording(false);
    setRecordSeconds(0);
  }, [deviceId, takingRef]);

  return {
    takes,
    takesRef,
    activeTakeId,
    recording,
    recordSeconds,
    liveTake,
    activeRecordingRef,
    recordingBusyRef,
    takeSeq,
    taking,
    takingRef,
    toggleRecording,
    selectTake,
    removeTake,
    resetRecordings,
  };
}
