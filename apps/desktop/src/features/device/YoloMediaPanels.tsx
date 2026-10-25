import {
  ChevronLeft,
  ChevronRight,
  Circle,
  Crop,
  MousePointer2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Scan,
  SkipBack,
  SkipForward,
  Square,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { FrameTimeline, takeDurationText } from '@/features/device/FrameTimeline';
import { cn } from '@/lib/utils';

export interface RecordingTake {
  readonly id: string;
  readonly recordingId: string;
  readonly label: string;
  readonly indices: number[];
  readonly createdAt: number;
  readonly fps?: number;
}

const PLAYBACK_FPS_OPTIONS = [6, 8, 12, 24] as const;

function IconButton({
  testId,
  label,
  title,
  text,
  pressed,
  tone = 'default',
  disabled = false,
  onClick,
  children,
}: {
  testId?: string;
  label: string;
  title?: string;
  text?: string;
  pressed?: boolean;
  tone?: 'default' | 'brand' | 'danger';
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-sm focus-visible:outline-1 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
        text ? 'h-6 gap-1 whitespace-nowrap px-1.5 text-badge' : 'size-5',
        tone === 'brand'
          ? 'text-brand hover:bg-brand/10'
          : tone === 'danger'
            ? 'text-failed hover:bg-failed/10'
            : 'text-dim hover:bg-raised hover:text-fg',
        pressed && 'bg-brand/20 text-brand',
        pressed && tone === 'danger' && 'bg-failed/20 text-failed',
      )}
    >
      {children}
      {text ? <span>{text}</span> : null}
    </button>
  );
}

export function YoloPlaybackToolbar({
  running,
  following,
  playing,
  cursor,
  total,
  isEditMode,
  playbackFps,
  onSeek,
  onFollow,
  onPlayTake,
  onRefresh,
  onPlaybackFpsChange,
}: {
  running: boolean;
  recording: boolean;
  following: boolean;
  playing: boolean;
  cursor: number;
  total: number;
  isEditMode: boolean;
  playbackFps: number;
  onSeek: (position: number) => void;
  onFollow: () => void;
  onPlayTake: () => void;
  onRefresh: () => void;
  onPlaybackFpsChange: (fps: number) => void;
}): ReactNode {
  return (
    <div
      data-testid="yolo-playback-toolbar"
      className="grid min-h-9 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 overflow-x-auto border-t border-line bg-panel px-2"
    >
      <div aria-hidden />
      <div className="flex items-center gap-0.5">
        <IconButton
          testId="yolo-frame-first"
          label="跳到最早帧"
          title="跳到录制里最早的一帧"
          disabled={total < 2}
          onClick={() => onSeek(0)}
        >
          <SkipBack className="size-3.5" strokeWidth={1.75} />
        </IconButton>
        <IconButton
          testId="yolo-frame-prev"
          label="上一帧"
          disabled={total < 2}
          onClick={() => onSeek(cursor - 1)}
        >
          <ChevronLeft className="size-3.5" strokeWidth={1.75} />
        </IconButton>
        <IconButton
          testId="yolo-frame-play"
          label={playing ? '暂停录制回放' : '播放录制'}
          title={playing ? '暂停当前录制' : '从当前帧播放录制'}
          pressed={playing}
          disabled={total < 2 || running}
          onClick={onPlayTake}
        >
          {playing ? (
            <Pause className="size-3.5" strokeWidth={1.75} />
          ) : (
            <Play className="size-3.5" strokeWidth={1.75} />
          )}
        </IconButton>
        <IconButton
          testId="yolo-frame-next"
          label="下一帧"
          disabled={total < 2}
          onClick={() => onSeek(cursor + 1)}
        >
          <ChevronRight className="size-3.5" strokeWidth={1.75} />
        </IconButton>
        <IconButton
          testId="yolo-frame-last"
          label="跳到最新帧"
          title="跳到录制里最新的一帧"
          disabled={total < 2}
          onClick={() => onSeek(total - 1)}
        >
          <SkipForward className="size-3.5" strokeWidth={1.75} />
        </IconButton>
      </div>
      <div data-testid="yolo-playback-actions" className="flex items-center justify-self-end gap-2">
        <label className="flex shrink-0 items-center gap-1 text-badge text-faint">
          回放
          <select
            data-testid="yolo-playback-fps"
            aria-label="回放帧率"
            value={playbackFps}
            onChange={(event) => onPlaybackFpsChange(Number(event.target.value))}
            className="h-6 rounded-sm border border-line bg-canvas px-1 text-badge text-dim focus:border-brand focus:outline-none"
          >
            {PLAYBACK_FPS_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value} fps
              </option>
            ))}
          </select>
        </label>
        <span
          data-testid="yolo-frame-counter"
          className="min-w-12 shrink-0 text-right text-badge tabular-nums text-dim"
          title="当前帧位置 / 录制总帧数"
        >
          {total > 0 ? `${cursor + 1} / ${total}` : '未录制'}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            testId="yolo-refresh-frame"
            label="刷新参考帧"
            text="刷新"
            title={
              isEditMode
                ? '重新取当前画面当背景（在它上面可以继续框新示例）'
                : '重新取最近帧（标注时画面是冻结的）'
            }
            disabled={running}
            onClick={onRefresh}
          >
            <RefreshCw aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          </IconButton>
          <IconButton
            testId="yolo-frame-live"
            label={following ? '暂停实时画面' : '查看实时画面'}
            text="实时"
            title={following ? '暂停实时画面（冻结当前帧）' : '查看设备最新画面'}
            pressed={following}
            disabled={running}
            onClick={onFollow}
          >
            <Radio aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

export function YoloRecordingPanel({
  recording,
  recordSeconds,
  inputMode,
  marksCount,
  takes,
  activeTakeId,
  currentTake,
  liveTake,
  cursor,
  frameFps,
  playbackFps,
  thumbnails,
  onRecord,
  onModeChange,
  onClearMarks,
  onSelectTake,
  onRemoveTake,
  onSeek,
  onRequestThumbnail,
}: {
  recording: boolean;
  recordSeconds: number;
  inputMode: 'mark' | 'roi' | 'control';
  marksCount: number;
  takes: readonly RecordingTake[];
  activeTakeId: string | null;
  currentTake: RecordingTake | null;
  /** 录制中的活 take：时间轴边录边长 */
  liveTake: RecordingTake | null;
  cursor: number;
  frameFps?: number;
  playbackFps: number;
  thumbnails: ReadonlyMap<string, string>;
  onRecord: () => void;
  onModeChange: (mode: 'mark' | 'roi' | 'control') => void;
  onClearMarks: () => void;
  onSelectTake: (id: string) => void;
  onRemoveTake: (id: string) => void;
  onSeek: (position: number) => void;
  onRequestThumbnail: (frame: number, recordingId?: string) => void | Promise<void>;
}): ReactNode {
  // 只有录制中才用活 take；停止后的收尾阶段不要拿它冒充当前时间轴（否则和播放条对不上）
  const timelineTake = recording ? liveTake : currentTake;
  const indices = timelineTake?.indices ?? [];
  const duration = takeDurationText(indices, timelineTake?.fps);
  return (
    <div
      data-testid="yolo-timeline-panel"
      className="flex h-[180px] shrink-0 flex-col border-t border-line bg-raised"
    >
      <div
        data-testid="yolo-recording-header"
        className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line px-2"
      >
        <span className="shrink-0 text-badge font-medium text-fg">录制</span>
        <div className="flex min-w-0 items-center gap-0.5">
          <IconButton
            testId="yolo-record"
            label={recording ? '停止录制' : '开始录制'}
            title={recording ? '停止录制并保存这一条' : '开始录制（可录多次）'}
            pressed={recording}
            tone="danger"
            onClick={onRecord}
          >
            {recording ? (
              <Square aria-hidden="true" className="size-2.5 fill-current" strokeWidth={1.5} />
            ) : (
              <Circle aria-hidden="true" className="size-2.5 fill-current" strokeWidth={1.5} />
            )}
          </IconButton>
          {recording ? (
            <span className="min-w-8 px-1 text-badge tabular-nums text-failed">{recordSeconds}s</span>
          ) : null}
          <span aria-hidden className="mx-1 h-3 w-px bg-line" />
          <IconButton
            testId="yolo-mode-mark"
            label="标注模式"
            title="标注：在画面上拖框生成示例"
            pressed={inputMode === 'mark'}
            onClick={() => onModeChange('mark')}
          >
            <Scan aria-hidden="true" className="size-3" strokeWidth={1.5} />
          </IconButton>
          <IconButton
            testId="yolo-mode-roi"
            label="ROI 模式"
            title="ROI：在画面上拖框限定搜索区域（不是示例框）"
            pressed={inputMode === 'roi'}
            onClick={() => onModeChange('roi')}
          >
            <Crop aria-hidden="true" className="size-3" strokeWidth={1.5} />
          </IconButton>
          <IconButton
            testId="yolo-mode-control"
            label="控制模式"
            title="控制：点画面=轻触，拖动=滑动"
            pressed={inputMode === 'control'}
            onClick={() => onModeChange('control')}
          >
            <MousePointer2 aria-hidden="true" className="size-3" strokeWidth={1.5} />
          </IconButton>
          <IconButton
            testId="yolo-toolbar-clear"
            label="清空示例框"
            title="清空所有示例框"
            disabled={marksCount === 0}
            onClick={onClearMarks}
          >
            <Trash2 aria-hidden="true" className="size-3" strokeWidth={1.5} />
          </IconButton>
        </div>
      </div>
      <div
        data-testid="yolo-timeline-dock"
        className="grid min-h-0 flex-1 grid-cols-[minmax(160px,240px)_minmax(0,1fr)] gap-3 px-3 py-2"
      >
        <section className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
          <div className="flex items-center justify-between text-badge text-faint">
            <span>录制</span>
            <span className="tabular-nums">{takes.length} 条</span>
          </div>
          {recording && liveTake ? (
            <div
              data-testid="yolo-live-take"
              className="flex items-center gap-1 rounded-sm border border-failed/50 bg-failed/10 px-2 py-1 text-badge text-fg"
            >
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-failed" />
              <span className="min-w-0 flex-1 truncate">{liveTake.label}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-faint">
                {liveTake.indices.length} 帧
              </span>
            </div>
          ) : null}
          {takes.length === 0 && !recording ? (
            <p className="flex min-h-14 items-center justify-center rounded-sm border border-dashed border-line px-2 py-2 text-center text-badge leading-snug text-faint">
              还没有录制 · 点录制开始，再点一次结束
            </p>
          ) : (
            takes.map((take) => (
              <div
                key={take.id}
                className={cn(
                  'flex items-center gap-1 rounded-sm border px-2 py-1 text-badge',
                  activeTakeId === take.id
                    ? 'border-brand/60 bg-brand/10 text-fg'
                    : 'border-line text-dim hover:bg-raised',
                )}
              >
                <button
                  type="button"
                  data-testid={`yolo-take-${take.id}`}
                  disabled={recording}
                  onClick={() => onSelectTake(take.id)}
                  className="min-w-0 flex-1 truncate text-left disabled:cursor-not-allowed disabled:opacity-50"
                  title={recording ? '先停止当前录制再切换' : `${take.label} · ${take.indices.length} 帧`}
                >
                  {take.label}
                  <span className="ml-1 text-[10px] text-faint">{take.indices.length} 帧</span>
                </button>
                <button
                  type="button"
                  aria-label={`删除 ${take.label}`}
                  disabled={recording}
                  onClick={() => onRemoveTake(take.id)}
                  className="flex size-6 shrink-0 items-center justify-center rounded-sm text-faint hover:bg-raised hover:text-failed disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-faint"
                  title={recording ? '先停止当前录制再删除' : '删除这条录制'}
                >
                  <Trash2 className="size-3.5" strokeWidth={1.75} />
                </button>
              </div>
            ))
          )}
        </section>
        <section className="flex min-h-0 min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 text-badge text-dim">
            <span className="flex min-w-0 items-center gap-1.5">
              时间轴
              {recording ? (
                <span className="flex shrink-0 items-center gap-1 text-failed">
                  <span className="size-1.5 animate-pulse rounded-full bg-failed" />
                  正在录制 {indices.length} 帧
                </span>
              ) : null}
            </span>
            <span data-testid="yolo-timeline-fps" className="truncate tabular-nums text-faint">
              画面 {frameFps?.toFixed(1) ?? '—'} fps · 回放 {playbackFps.toFixed(1)} fps
              {duration ? ` · ${duration}` : ''}
            </span>
          </div>
          <FrameTimeline
            indices={indices}
            cursor={cursor}
            recording={recording}
            fps={timelineTake?.fps}
            disabled={indices.length < 2}
            thumbnails={thumbnails}
            recordingId={timelineTake?.recordingId}
            onRequestThumbnail={onRequestThumbnail}
            onSeek={onSeek}
          />
        </section>
      </div>
    </div>
  );
}
