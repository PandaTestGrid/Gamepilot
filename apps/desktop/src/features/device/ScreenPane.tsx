/**
 * 画面栏：空态 / 单画面（含识别覆盖与录制框选）/ 多开网格。
 *
 * 画面本体在 M1 接入（引擎推 `engine.frame`，base64 JPEG）；
 * 这里用占位区域 + 归一化百分比定位的识别框，把**交互与布局**先做出来：
 *   - 识别框三态：绿=已确认 / 橙=待投票 / 红=失败残影
 *   - 录制态：十字准星 + 归一化坐标读数 + 框选（松手弹草稿表单）
 */
import { Grid2x2, MousePointerSquareDashed, ScanLine } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';

import { RecordOverlay } from '@/features/device/RecordOverlay';
import { GhostButton, PanelShell, StatusDot } from '@/layout/PanelShell';
import { cn } from '@/lib/utils';
import { activeDevice, connectedDevices, useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';
import { useUiStore } from '@/stores/ui.store';
import type { RecognizerView } from '@/types';

export function ScreenPane(): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const gridView = useDeviceStore((state) => state.gridView);
  const toggleGrid = useDeviceStore((state) => state.toggleGrid);
  const toggleDevicePopover = useUiStore((state) => state.toggleDevicePopover);
  const recordMode = useUiStore((state) => state.recordMode);
  const grid = useGraphStore((state) => state.graphs[activeId]);

  const device = activeDevice(devices, activeId);
  const connected = useMemo(() => connectedDevices(devices), [devices]);
  const recognizers = grid?.recognizers ?? [];
  // 元素很少（一个界面通常 <10 个识别器），直接过滤即可，不需要 useMemo
  const activeRecognizers = (grid?.recognizers ?? []).filter((item) => item.state !== 'idle');

  return (
    <PanelShell
      title="画面"
      actions={
        <>
          <GhostButton
            active={recordMode === 'marquee'}
            onClick={() => toggleRecordMode('marquee')}
            title="框选录制：拖一个矩形生成模板"
          >
            <MousePointerSquareDashed className="size-3" />
            框选
          </GhostButton>
          <GhostButton
            active={recordMode === 'pick'}
            onClick={() => toggleRecordMode('pick')}
            title="点选录制：单击取 3×3 邻域小模板"
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
          <GhostButton title="读数">读数 {activeRecognizers.length}</GhostButton>
        </>
      }
      footer={<RecognizerReadout recognizers={recognizers} onConnectAll={() => toggleDevicePopover(true)} />}
    >
      <div className="h-full bg-canvas p-2">
        {gridView && connected.length >= 2 ? (
          <ScreenGrid />
        ) : device?.status === 'connected' ? (
          <SingleScreen deviceId={device.id} deviceName={device.name} resolution={device.resolution} />
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
  const discovered = devices.filter((device) => device.status !== 'connected').slice(0, 3);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <span className="text-panel text-dim">未连接设备</span>
      <button
        type="button"
        onClick={onConnect}
        className="h-7 rounded-sm bg-brand px-4 text-body font-medium text-[#0b0d12] hover:opacity-90"
      >
        连接设备
      </button>
      <div className="w-72 text-badge text-faint">
        <div className="mb-1 text-dim">最近 / 已发现</div>
        {discovered.map((device) => (
          <button
            key={device.id}
            type="button"
            onClick={onConnect}
            className="flex h-[26px] w-full items-center gap-2 px-1 text-left hover:bg-raised"
          >
            <StatusDot tone={device.status === 'failed' ? 'failed' : 'idle'} />
            <span className="flex-1 truncate text-body text-fg">{device.name}</span>
            <span>{device.resolution.join('×')}</span>
            <span className="text-dim">→</span>
          </button>
        ))}
        <div className="mt-2">正在扫描：adb 设备 1 个 · Windows 窗口 7 个</div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- 单画面 */

function SingleScreen({
  deviceId,
  deviceName,
  resolution,
}: {
  deviceId: string;
  deviceName: string;
  resolution: readonly [number, number];
}): ReactNode {
  const recordMode = useUiStore((state) => state.recordMode);
  const draft = useUiStore((state) => state.draft);
  const beginDraft = useUiStore((state) => state.beginDraft);
  const graph = useGraphStore((state) => state.graphs[deviceId]);
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
      // 点选 = 以点击点为中心取 3×3% 的小模板（DESIGN.md §4.2 B）
      beginDraft({ rect: [clamp01(x - 0.015), clamp01(y - 0.015), 0.03, 0.03], score: mockScore(0.03) });
      dragStart.current = null;
      return;
    }
    if (selection && selection[2] > 0.01 && selection[3] > 0.01) {
      beginDraft({ rect: selection, score: mockScore(selection[2] * selection[3]) });
    }
    dragStart.current = null;
    setSelection(null);
  };

  const activeRecognizers = (graph?.recognizers ?? []).filter((item) => item.state !== 'idle');

  return (
    <div
      ref={viewport}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      className={cn(
        'relative h-full w-full border border-line bg-[#0b0d12]',
        recordMode !== 'off' && 'cursor-crosshair',
      )}
    >
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-faint">
        <span className="text-body">
          {deviceName} · {resolution[0]}×{resolution[1]}
        </span>
        <span className="text-badge">实时画面（M1 接入引擎帧推送）</span>
      </div>

      {/* 识别框覆盖：绿=已确认 / 橙=待投票 */}
      {activeRecognizers.map((item) => {
        const [x, y, w, h] = item.roi;
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

      {/* 录制态：十字准星 + 归一化读数 */}
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

      {draft && <RecordOverlay deviceId={deviceId} />}
    </div>
  );
}

/* --------------------------------------------------------------- 多开网格 */

function ScreenGrid(): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const setActive = useDeviceStore((state) => state.setActive);
  const connected = useMemo(() => connectedDevices(devices), [devices]);
  const columns = connected.length >= 4 ? 2 : 1;

  return (
    <div className="grid h-full gap-1" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {connected.map((device) => (
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
            <span className="text-badge text-faint">{device.fps}fps</span>
          </span>
          <span className="flex flex-1 flex-col items-center justify-center gap-1 text-faint">
            <span className="text-badge">
              {device.resolution[0]}×{device.resolution[1]}
            </span>
            <span className="text-badge">{device.id === activeId ? '活动设备' : '点击切为活动'}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------- 底部识别读数 */

function RecognizerReadout({
  recognizers,
  onConnectAll,
}: {
  recognizers: readonly RecognizerView[];
  onConnectAll: () => void;
}): ReactNode {
  return (
    <div className="shrink-0 border-t border-line">
      <div className="flex h-6 items-center px-2 text-badge text-faint">
        识别读数
        <span className="flex-1" />
        <button type="button" onClick={onConnectAll} className="hover:text-fg">
          查看设备
        </button>
      </div>
      {recognizers.map((item) => (
        <div key={item.label} className="flex h-[26px] items-center gap-2 px-2 hover:bg-raised">
          <StatusDot
            tone={item.state === 'confirmed' ? 'confirmed' : item.state === 'pending' ? 'pending' : 'idle'}
          />
          <span className="w-28 truncate text-body">{item.label}</span>
          <span className="text-body text-dim">{item.score.toFixed(2)}</span>
          <span className="flex-1" />
          <span className="text-badge text-faint">
            {item.state === 'confirmed' ? '稳定' : item.state === 'pending' ? '待确认' : '未命中'}
          </span>
        </div>
      ))}
    </div>
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 占位：真实分数来自引擎本帧的模板匹配结果；这里按面积给个似是而非的值 */
function mockScore(area: number): number {
  return Math.round((0.62 + Math.min(0.33, area * 3)) * 100) / 100;
}
