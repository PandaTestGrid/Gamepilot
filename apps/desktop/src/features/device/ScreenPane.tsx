/**
 * 画面栏：空态 / 单画面（真实画面 + 识别覆盖 + 录制框选）/ 多开网格。
 *
 * 数据来源是引擎推来的 `engine.frame`（base64 JPEG + 当帧识别结果 + 节点状态）：
 * 识别框、node/tick/fps 浮层全部是引擎的真实数据，前端只做展示与坐标换算
 * （而且坐标本来就是归一化的，连换算都不需要）。
 */
import { Grid2x2, MousePointerSquareDashed, ScanLine } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';

import { RecordOverlay } from '@/features/device/RecordOverlay';
import { GhostButton, PanelShell, StatusDot } from '@/layout/PanelShell';
import { formatResolution } from '@/lib/format';
import { devLog } from '@/lib/rpc';
import { cn } from '@/lib/utils';
import { activeDevice, connectedDevices, useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore, type FrameState } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { RecognizerView } from '@/types';

export function ScreenPane(): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const gridView = useDeviceStore((state) => state.gridView);
  const toggleGrid = useDeviceStore((state) => state.toggleGrid);
  const toggleDevicePopover = useUiStore((state) => state.toggleDevicePopover);
  const recordMode = useUiStore((state) => state.recordMode);
  const frame = useSessionStore((state) => state.frames[activeId]);
  const graph = useGraphStore((state) => state.graphs[activeId]);

  const device = activeDevice(devices, activeId);
  const connected = useMemo(() => connectedDevices(devices), [devices]);
  const recognizers = graph?.recognizers ?? [];
  const confirmedCount = recognizers.filter((item) => item.state !== 'idle').length;

  return (
    <PanelShell
      title="画面"
      actions={
        <>
          <GhostButton
            active={recordMode === 'marquee'}
            onClick={() => toggleRecordMode('marquee')}
            title="框选录制：拖一个矩形生成识别器"
          >
            <MousePointerSquareDashed className="size-3" />
            框选
          </GhostButton>
          <GhostButton
            active={recordMode === 'pick'}
            onClick={() => toggleRecordMode('pick')}
            title="点选录制：单击取 3×3% 邻域小模板"
          >
            <ScanLine className="size-3" />
            点选
          </GhostButton>
          <GhostButton
            active={gridView}
            onClick={toggleGrid}
            title={connected.length < 2 ? '至少 2 台已连接设备才能多开' : '多开网格'}
          >
            <Grid2x2 className="size-3" />
            多开
          </GhostButton>
          <GhostButton title="当前帧命中的识别器数量">读数 {confirmedCount}</GhostButton>
        </>
      }
      footer={<RecognizerReadout recognizers={recognizers} onConnect={() => toggleDevicePopover(true)} />}
    >
      <div className="flex h-full min-h-0 flex-col bg-canvas p-2">
        {gridView && connected.length >= 2 ? (
          <ScreenGrid />
        ) : device?.status === 'connected' ? (
          <SingleScreen
            deviceId={device.id}
            deviceName={device.name}
            resolution={device.resolution}
            frame={frame}
          />
        ) : (
          <EmptyState onConnect={() => toggleDevicePopover(true)} />
        )}
      </div>
    </PanelShell>
  );
}

function toggleRecordMode(mode: 'marquee' | 'pick'): void {
  const state = useUiStore.getState();
  state.setRecordMode(state.recordMode === mode ? 'off' : mode);
}

/* ------------------------------------------------------------------ 空态 */

function EmptyState({ onConnect }: { onConnect: () => void }): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const discovered = devices.filter((device) => device.status !== 'connected').slice(0, 4);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <span className="text-panel text-dim">还没有连接设备</span>
      <ol className="w-[420px] space-y-1 text-badge text-faint">
        <li>1. 点下面的「连接设备」，选一台手机（USB 调试已授权）或 Mock 设备</li>
        <li>2. 连上后点画面栏的「框选」，在画面上拖一个矩形 → 生成识别器</li>
        <li>3. 录好节点后点顶栏「运行」，状态机就会按你的状态图跑</li>
      </ol>
      <button
        type="button"
        onClick={onConnect}
        className="h-7 rounded-sm bg-brand px-4 text-body font-medium text-[#0b0d12] hover:opacity-90"
      >
        连接设备
      </button>
      <div className="w-80 text-badge text-faint">
        <div className="mb-1 text-dim">已发现（点「连接设备」刷新/连接）</div>
        {discovered.map((device) => (
          <button
            key={device.id}
            type="button"
            onClick={onConnect}
            className="flex h-[26px] w-full items-center gap-2 px-1 text-left hover:bg-raised"
          >
            <StatusDot tone={device.status === 'failed' ? 'failed' : 'idle'} />
            <span className="min-w-0 flex-1 truncate text-body text-fg">{device.name}</span>
            <span>{formatResolution(device.resolution)}</span>
            <span className="text-dim">→</span>
          </button>
        ))}
        {discovered.length === 0 && (
          <div className="px-1 py-2">还没扫描到设备 · 确认手机已插好并允许 USB 调试</div>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- 单画面 */

function SingleScreen({
  deviceId,
  deviceName,
  resolution,
  frame,
}: {
  deviceId: string;
  deviceName: string;
  resolution: readonly [number, number] | null;
  frame: FrameState | undefined;
}): ReactNode {
  const recordMode = useUiStore((state) => state.recordMode);
  const draft = useUiStore((state) => state.draft);
  const beginDraft = useUiStore((state) => state.beginDraft);
  const viewport = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<[number, number, number, number] | null>(null);
  const dragStart = useRef<[number, number] | null>(null);
  const [pointer, setPointer] = useState<[number, number] | null>(null);

  const toNormalized = useCallback((event: React.MouseEvent<HTMLDivElement>): [number, number] => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) {
      return [0, 0];
    }
    return [
      Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    ];
  }, []);

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (recordMode === 'off' || draft) {
      return;
    }
    dragStart.current = toNormalized(event);
    setSelection(null);
  };

  const onMouseMove = (event: React.MouseEvent<HTMLDivElement>): void => {
    const current = toNormalized(event);
    setPointer(recordMode === 'marquee' ? current : null);
    const start = dragStart.current;
    if (!start || recordMode !== 'marquee') {
      return;
    }
    setSelection([
      Math.min(start[0], current[0]),
      Math.min(start[1], current[1]),
      Math.abs(current[0] - start[0]),
      Math.abs(current[1] - start[1]),
    ]);
  };

  const onMouseUp = (): void => {
    if (recordMode === 'pick' && dragStart.current) {
      const [x, y] = dragStart.current;
      beginDraft({ rect: [clamp01(x - 0.015), clamp01(y - 0.015), 0.03, 0.03], score: liveScore(frame) });
      dragStart.current = null;
      return;
    }
    if (selection && selection[2] > 0.01 && selection[3] > 0.01) {
      beginDraft({ rect: selection, score: liveScore(frame) });
    }
    dragStart.current = null;
    setSelection(null);
  };

  const detections = frame?.detections ?? [];

  return (
    <div
      ref={viewport}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      className={cn(
        'relative min-h-0 w-full flex-1 border border-line bg-[#0b0d12]',
        recordMode !== 'off' && 'cursor-crosshair',
      )}
    >
      {frame ? (
        <img
          src={frame.imageUrl}
          alt={`${deviceName} 实时画面`}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          draggable={false}
          onError={() => devLog('画面栏：图片加载失败（字节坏了或 blob 失效）')}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-faint">
          <span className="text-body">
            {deviceName} · {formatResolution(resolution)}
          </span>
          <span className="text-badge">等待首帧…</span>
        </div>
      )}

      {/* 识别框：绿=投票已确认 / 橙=待确认；坐标是引擎给的归一化值 */}
      {detections.map((item) => {
        const [x, y, w, h] = item.rect;
        const tone =
          item.state === 'confirmed' ? 'border-confirmed text-confirmed' : 'border-pending text-pending';
        return (
          <div
            key={item.label}
            className={cn('pointer-events-none absolute border', tone)}
            style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}
          >
            <span className="absolute -top-4 left-0 text-badge whitespace-nowrap">
              {item.label} {item.score.toFixed(2)}
            </span>
          </div>
        );
      })}

      {/* 录制态：十字准星 + 归一化坐标读数 */}
      {recordMode !== 'off' && pointer && (
        <>
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-brand/30"
            style={{ left: `${pointer[0] * 100}%` }}
          />
          <div
            className="pointer-events-none absolute inset-x-0 h-px bg-brand/30"
            style={{ top: `${pointer[1] * 100}%` }}
          />
          <div className="pointer-events-none absolute top-1 left-1 rounded-sm bg-canvas/80 px-1.5 py-0.5 text-badge text-brand">
            ({pointer[0].toFixed(3)}, {pointer[1].toFixed(3)})
          </div>
        </>
      )}

      {/* 框选矩形 */}
      {selection && (
        <div
          className="pointer-events-none absolute border border-dashed border-brand bg-brand/10"
          style={{
            left: `${selection[0] * 100}%`,
            top: `${selection[1] * 100}%`,
            width: `${selection[2] * 100}%`,
            height: `${selection[3] * 100}%`,
          }}
        >
          <span className="absolute -bottom-4 left-0 text-badge text-brand">
            {selection[2].toFixed(3)} × {selection[3].toFixed(3)}
          </span>
        </div>
      )}

      {/* 运行态浮层：全部来自引擎帧 */}
      {frame && (
        <div className="pointer-events-none absolute bottom-1 left-1 rounded-sm bg-canvas/80 px-1.5 py-0.5 text-badge text-dim">
          node={frame.node ?? '-'} · tick={frame.tick} · {frame.fps}fps
          {frame.pending ? ` · pending→${frame.pending}` : ''}
        </div>
      )}

      {draft && <RecordOverlay deviceId={deviceId} />}
    </div>
  );
}

/* --------------------------------------------------------------- 多开网格 */

function ScreenGrid(): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const setActive = useDeviceStore((state) => state.setActive);
  const frames = useSessionStore((state) => state.frames);
  const connected = useMemo(() => connectedDevices(devices), [devices]);
  const columns = connected.length >= 4 ? 2 : 1;

  return (
    <div className="grid h-full gap-1" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {connected.map((device) => {
        const frame = frames[device.id];
        return (
          <button
            key={device.id}
            type="button"
            onClick={() => setActive(device.id)}
            className={cn(
              'relative flex min-h-0 flex-col border bg-[#0b0d12] text-left',
              device.id === activeId ? 'border-brand' : 'border-line hover:border-dim',
            )}
          >
            <span className="flex h-6 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
              <StatusDot tone="confirmed" />
              <span className="text-body">{device.name}</span>
              <span className="flex-1" />
              <span className="text-badge text-faint">{frame ? `${frame.fps}fps` : '—'}</span>
            </span>
            <span className="relative flex flex-1 items-center justify-center overflow-hidden">
              {frame ? (
                <img
                  src={frame.imageUrl}
                  alt={`${device.name} 画面`}
                  className="absolute inset-0 h-full w-full object-contain"
                  draggable={false}
                />
              ) : (
                <span className="text-badge text-faint">等待首帧…</span>
              )}
            </span>
            <span className="flex h-5 shrink-0 items-center justify-between border-t border-line px-2 text-badge text-faint">
              <span>{formatResolution(device.resolution)}</span>
              <span>{frame?.node ?? '-'}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------- 底部识别读数 */

function RecognizerReadout({
  recognizers,
  onConnect,
}: {
  recognizers: readonly RecognizerView[];
  onConnect: () => void;
}): ReactNode {
  return (
    <div className="shrink-0 border-t border-line">
      <div className="flex h-6 items-center px-2 text-badge text-faint">
        识别读数
        <span className="flex-1" />
        <button type="button" onClick={onConnect} className="hover:text-fg">
          查看设备
        </button>
      </div>
      {recognizers.map((item) => (
        <div key={item.label} className="flex h-[26px] items-center gap-2 px-2 hover:bg-raised">
          <StatusDot
            tone={item.state === 'confirmed' ? 'confirmed' : item.state === 'pending' ? 'pending' : 'idle'}
          />
          <span className="w-32 truncate text-body">{item.label}</span>
          <span className="text-body text-dim">{item.score.toFixed(2)}</span>
          <span className="flex-1" />
          <span className="text-badge text-faint">
            {item.state === 'confirmed' ? '稳定' : item.state === 'pending' ? '待确认' : '未命中'}
          </span>
        </div>
      ))}
      {recognizers.length === 0 && (
        <div className="px-2 py-3 text-badge text-faint">还没有识别器 · 打开「框选」在画面上拖一个矩形</div>
      )}
    </div>
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 录制时给草稿一个"本帧分数"参考值：取重叠最多的识别器分数。 */
function liveScore(frame: FrameState | undefined): number {
  if (!frame || frame.detections.length === 0) {
    return 0;
  }
  return frame.detections.reduce((best, item) => Math.max(best, item.score), 0);
}
