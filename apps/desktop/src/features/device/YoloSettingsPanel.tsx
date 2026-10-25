import { Crop, Download, FolderPlus, Play, Square, Trash2, X } from 'lucide-react';
import { type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';

import { exampleThumbnailStyle } from '@/features/device/yolo-example-thumbnail';
import { YoloRoiPreview } from '@/features/device/YoloRoiPreview';
import { type YoloComponentStatus, type YoloPreviewDet } from '@/lib/rpc';
import { cn } from '@/lib/utils';

type NormRect = [number, number, number, number];

export interface YoloSettingsMark {
  readonly id: string;
  readonly rect: NormRect;
  readonly label: string;
  readonly enabled: boolean;
  readonly color: string;
  readonly image: string;
  readonly width: number;
  readonly height: number;
}

export interface YoloSettingsPreview {
  dets: YoloPreviewDet[];
  ms: number;
  inferMs: number;
  queueMs: number;
  wallMs: number;
  device: string;
  width: number;
  height: number;
}

export interface YoloSettingsPanelProps {
  marks: YoloSettingsMark[];
  enabledMarks: YoloSettingsMark[];
  refsDirtyRef: RefObject<boolean>;
  setMarks: Dispatch<SetStateAction<YoloSettingsMark[]>>;
  toggleMark: (id: string) => void;
  removeMark: (id: string) => void;
  isEditMode: boolean;
  label: string;
  setLabelOverride: Dispatch<SetStateAction<string | null>>;
  conf: number;
  setConf: Dispatch<SetStateAction<number>>;
  iou: number;
  setIou: Dispatch<SetStateAction<number>>;
  imgsz: number;
  setImgsz: Dispatch<SetStateAction<number>>;
  tile: boolean;
  setTile: Dispatch<SetStateAction<boolean>>;
  tileSize: number;
  setTileSize: Dispatch<SetStateAction<number>>;
  search: 'region' | 'full';
  roi: readonly [number, number, number, number] | null;
  setRoi: Dispatch<SetStateAction<[number, number, number, number] | null>>;
  /** 当前画面分辨率：ROI 矢量示意按它的比例画 */
  roiResolution?: readonly [number, number] | null;
  /** 切到画面上的 ROI 拖框模式（会先停掉实时检测） */
  onStartRoi: () => void;
  /** 画面当前就在 ROI 模式下（按钮高亮） */
  roiModeActive: boolean;
  setSearch: Dispatch<SetStateAction<'region' | 'full'>>;
  modelInfo: { models: string[]; model: string; device?: string } | null;
  modelBusy: boolean;
  running: boolean;
  switchModel: (name: string) => Promise<void>;
  addModel: () => Promise<void>;
  deviceChip: { text: string; tone: string; dot: string; title: string } | null;
  modelNote: string | null;
  modelUnavailable: boolean;
  ready: boolean;
  status: YoloComponentStatus | null;
  installFromFile: () => Promise<void>;
  checkingComponent: boolean;
  installing: boolean;
  loading: boolean;
  progress: number;
  stage: string;
  install: (source?: string) => Promise<void>;
  error: string | null;
  refresh: () => Promise<void>;
  runtimeError: string | null;
  preview: YoloSettingsPreview | null;
  previewDevice: string;
  toggleDetection: () => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const IMGSZ_OPTIONS = [480, 640, 960, 1280] as const;
const TILE_OPTIONS = [480, 640, 960] as const;
/** CPU 推理的悬停提示（GPU 正常时不显示） */
const CPU_HINT = 'worker 当前跑在 CPU 上（没装 CUDA 组件或 CUDA 不可用），推理会比较慢';

/** 设置台以留白和表面色阶分组，而不是为每个小节画一道分割线。 */
function Section({
  title,
  action,
  hint,
  children,
  primary = false,
}: {
  title: string;
  action?: ReactNode;
  hint?: string;
  children: ReactNode;
  primary?: boolean;
}): ReactNode {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3', primary ? 'bg-raised px-3 py-3' : 'px-3 py-1')}>
      <div className="flex min-h-5 items-center justify-between gap-2">
        <h3 className={cn('font-medium text-fg', primary ? 'text-panelhead' : 'text-body')}>{title}</h3>
        {action}
      </div>
      {children}
      {hint ? <p className="text-badge leading-snug text-dim">{hint}</p> : null}
    </section>
  );
}

/** 参数行：左边标签、右边控件（窄栏里比两列网格稳，不会把「推荐分辨率」挤成两行）。 */
function Row({ label, title, children }: { label: string; title?: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-center justify-between gap-2 text-badge">
      <span className="shrink-0 text-faint" title={title}>
        {label}
      </span>
      {children}
    </div>
  );
}

export function YoloSettingsPanel({
  marks,
  enabledMarks,
  refsDirtyRef,
  setMarks,
  toggleMark,
  removeMark,
  isEditMode,
  label,
  setLabelOverride,
  conf,
  setConf,
  iou,
  setIou,
  imgsz,
  setImgsz,
  tile,
  setTile,
  tileSize,
  setTileSize,
  search,
  setSearch,
  roi,
  setRoi,
  roiResolution,
  onStartRoi,
  roiModeActive,
  modelInfo,
  modelBusy,
  running,
  switchModel,
  addModel,
  deviceChip,
  modelNote,
  modelUnavailable,
  ready,
  status,
  installFromFile,
  checkingComponent,
  installing,
  loading,
  progress,
  stage,
  install,
  error,
  refresh,
  runtimeError,
  preview,
  previewDevice,
  toggleDetection,
}: YoloSettingsPanelProps): ReactNode {
  return (
    <aside
      data-testid="yolo-settings"
      className="flex h-[min(54vh,480px)] min-h-[240px] flex-col overflow-hidden border-t border-line bg-panel lg:h-auto lg:min-h-0 lg:border-t-0 lg:border-l"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
        <Section
          title="示例"
          primary
          action={
            <span className="flex items-center gap-2 text-badge text-faint">
              <span className="tabular-nums">
                {marks.length > 0 ? `${enabledMarks.length}/${marks.length} 启用` : '0 个'}
              </span>
              {marks.length > 0 ? (
                <button
                  type="button"
                  data-testid="yolo-example-clear"
                  onClick={() => {
                    refsDirtyRef.current = true;
                    setMarks([]);
                  }}
                  title="清空所有示例框（重新拖框即可再建）"
                  className="text-faint underline-offset-2 hover:text-fg hover:underline"
                >
                  清空
                </button>
              ) : null}
            </span>
          }
          hint={
            marks.length > 0
              ? '缩略图只显示框内区域；模型收到的是完整参考帧和框坐标。点缩略图可暂时停用。'
              : undefined
          }
        >
          {marks.length === 0 ? (
            <div
              data-testid="yolo-example-list"
              className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-sm border border-dashed border-line bg-canvas/30 px-3 py-2 text-center text-badge text-faint"
            >
              <span>还没有示例框</span>
              <span className="text-badge text-faint">在左侧画面上按住拖框，框住要识别的目标</span>
            </div>
          ) : (
            <div data-testid="yolo-example-list" className="flex flex-wrap gap-2">
              {marks.map((mark, index) => (
                <div key={mark.id} className="group relative">
                  <button
                    type="button"
                    data-testid={`yolo-mark-toggle-${mark.id}`}
                    aria-pressed={mark.enabled}
                    onClick={() => toggleMark(mark.id)}
                    title={
                      mark.enabled
                        ? `示例 ${index + 1}：点击暂时不用这个示例`
                        : `示例 ${index + 1}：点击重新启用`
                    }
                    className={cn(
                      'block size-11 shrink-0 overflow-hidden rounded-sm border-2 bg-canvas',
                      !mark.enabled && 'opacity-40',
                    )}
                    style={{ borderColor: mark.color }}
                  >
                    <span className="flex h-full w-full items-center justify-center bg-canvas">
                      <span
                        aria-hidden
                        data-testid={`yolo-mark-thumb-${mark.id}`}
                        className="block h-full w-full bg-no-repeat"
                        style={exampleThumbnailStyle(mark.image, mark.rect, mark.width, mark.height)}
                      />
                    </span>
                  </button>
                  <span className="pointer-events-none absolute -left-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-sm border border-line bg-panel px-0.5 text-[9px] leading-none tabular-nums text-dim">
                    {index + 1}
                  </span>
                  <button
                    type="button"
                    data-testid={`yolo-mark-remove-${mark.id}`}
                    aria-label="删除示例"
                    title="删除这个示例"
                    onClick={() => removeMark(mark.id)}
                    className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-sm border border-line bg-panel text-faint opacity-0 hover:border-failed/50 hover:text-failed focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3" strokeWidth={1.75} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section
          title="识别器"
          primary
          hint={
            isEditMode
              ? '改名会一起更新引用它的模块；留原名则只改参数。'
              : '保存后的识别器名；也是新示例的默认标签。'
          }
        >
          <input
            data-testid="yolo-label"
            aria-label="识别器名称"
            autoFocus
            value={label}
            title={isEditMode ? '改名会一起更新引用它的模块' : undefined}
            onChange={(event) => {
              const next = event.target.value;
              setLabelOverride(next);
              // 一次标记只有一个名字：改名时所有示例跟着改
              setMarks((current) => current.map((item) => ({ ...item, label: next })));
            }}
            placeholder="例如：精英怪"
            className="h-7 w-full rounded-sm border border-line bg-canvas px-2 text-body text-fg focus:border-brand focus:outline-none disabled:opacity-60"
          />
          {!isEditMode && label.trim().length === 0 ? (
            <p className="text-badge text-pending">名字不能为空</p>
          ) : null}
        </Section>

        <Section title="检测参数" hint="阈值越高越保守；小目标可开分块（CPU 会变慢）。">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex min-w-0 flex-col gap-1">
              <span className="flex items-center justify-between gap-1 text-badge text-faint">
                <span>置信度</span>
                <span className="tabular-nums text-dim">{conf.toFixed(2)}</span>
              </span>
              <input
                type="range"
                aria-label="置信度阈值"
                min={0.05}
                max={1}
                step={0.01}
                value={conf}
                onChange={(event) => setConf(Number(event.target.value))}
                className="h-1 w-full accent-[var(--brand)]"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="flex items-center justify-between gap-1 text-badge text-faint">
                <span title="仅影响本窗口试识别，保存后流程使用引擎默认去重参数">预览去重 IoU</span>
                <span className="tabular-nums text-dim">{iou.toFixed(2)}</span>
              </span>
              <input
                type="range"
                aria-label="NMS IoU"
                min={0.1}
                max={0.9}
                step={0.01}
                value={iou}
                onChange={(event) => setIou(Number(event.target.value))}
                className="h-1 w-full accent-[var(--brand)]"
              />
            </label>
          </div>

          <Row label="推荐分辨率" title="检测前把画面缩放到这个尺寸；越小越快，小目标用大尺寸">
            <select
              aria-label="推荐分辨率"
              value={imgsz}
              onChange={(event) => setImgsz(Number(event.target.value))}
              className="h-7 w-[132px] rounded-sm border border-line bg-canvas px-1.5 text-badge text-fg focus:border-brand focus:outline-none"
            >
              {IMGSZ_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}（{size === 480 ? '最快' : size === 640 ? '快' : size === 960 ? '均衡' : '小目标'}）
                </option>
              ))}
            </select>
          </Row>

          <div className="flex items-center justify-between gap-2 text-badge">
            <label
              className="flex shrink-0 items-center gap-1.5 text-faint"
              title={tile ? '画面切块分别检测，适合小目标；CPU 上会明显变慢' : '画面切块分别检测，适合小目标'}
            >
              <input
                type="checkbox"
                checked={tile}
                onChange={(event) => setTile(event.target.checked)}
                className="size-3.5 accent-[var(--brand)]"
              />
              分块检测
            </label>
            <select
              aria-label="分块大小"
              value={tileSize}
              title={tile ? '每块推理时的缩放尺寸' : '勾选「分块检测」后才能选块大小'}
              disabled={!tile}
              onChange={(event) => setTileSize(Number(event.target.value))}
              className="h-7 w-[112px] rounded-sm border border-line bg-canvas px-1.5 text-badge text-fg focus:border-brand focus:outline-none disabled:opacity-50"
            >
              {TILE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  块 {size}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between gap-2 text-badge">
            <span
              className="shrink-0 text-faint"
              title="有独立搜索区域时可限定范围；未设置时仍搜索全屏。标记图片的框不是搜索区域。流程中的搜索范围由步骤单独设置。"
            >
              搜索范围
            </span>
            <span className="flex overflow-hidden rounded-sm border border-line">
              {(
                [
                  ['region', '默认区域'],
                  ['full', '全屏'],
                ] as const
              ).map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`yolo-search-${value}`}
                  aria-pressed={search === value}
                  onClick={() => setSearch(value)}
                  className={cn(
                    'h-7 px-2.5 text-badge',
                    search === value ? 'bg-active text-fg' : 'text-dim hover:bg-raised hover:text-fg',
                  )}
                >
                  {text}
                </button>
              ))}
            </span>
          </div>

          {search === 'full' ? (
            <div className="space-y-1.5 rounded-sm border border-line bg-canvas/50 px-2 py-2">
              <div className="flex items-center gap-1.5 text-badge text-fg">
                <span className="size-2 rounded-full bg-confirmed" />
                当前是「全屏」搜索
              </div>
              <p className="text-[10px] leading-snug text-dim">
                ROI 当前不会参与搜索，也不会画在游戏画面上。切回「默认区域」后，已保存的 ROI 会继续生效。
              </p>
              {roi ? (
                <button
                  type="button"
                  data-testid="yolo-roi-use"
                  onClick={() => setSearch('region')}
                  className="h-7 rounded-sm border border-brand/50 px-2 text-badge text-brand hover:bg-brand/10"
                >
                  切回默认区域并使用 ROI
                </button>
              ) : null}
            </div>
          ) : (
            <>
              {/* ROI：矢量示意 + 就地按钮（不用先切工具栏模式也知道在哪、怎么改） */}
              <YoloRoiPreview roi={roi} resolution={roiResolution} />

              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  data-testid="yolo-roi-mark"
                  data-capture-keep
                  aria-pressed={roiModeActive}
                  title="到画面上拖一个框，限定 AI 只在框内搜索（不是标记示例）"
                  onClick={onStartRoi}
                  className={cn(
                    'flex h-7 items-center gap-1 rounded-sm border px-2 text-badge transition-colors',
                    roiModeActive
                      ? 'border-brand bg-active text-brand'
                      : 'border-line bg-canvas text-dim hover:border-brand/50 hover:bg-raised hover:text-fg',
                  )}
                >
                  <Crop className="size-3 shrink-0" strokeWidth={1.75} />
                  {roiModeActive ? '在画面上拖框…' : roi ? '重画 ROI' : '标记 ROI'}
                </button>
                {roi ? (
                  <button
                    type="button"
                    data-testid="yolo-roi-clear"
                    title="删掉搜索区域，恢复全屏"
                    onClick={() => setRoi(null)}
                    className="flex h-7 items-center gap-1 rounded-sm border border-line bg-canvas px-2 text-badge text-faint hover:border-err/50 hover:bg-raised hover:text-err"
                  >
                    <X className="size-3 shrink-0" strokeWidth={1.75} />
                    清除
                  </button>
                ) : null}
              </div>

              <p className="text-[10px] leading-snug text-dim">
                {roi
                  ? '已设置 ROI：外框 = 画面，蓝块 = 实际搜索区域。'
                  : '未设置 ROI：默认按全屏搜索。点「标记 ROI」后在画面上拖框限定搜索范围。'}
              </p>
            </>
          )}
        </Section>

        <Section title="模型与环境" hint="组件 = 推理运行时；模型 = .pt 权重。">
          {modelInfo ? (
            <>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-badge text-faint">模型</span>
                <select
                  data-testid="yolo-model-select"
                  aria-label="模型"
                  value={modelInfo.model}
                  disabled={modelBusy || running}
                  onChange={(event) => void switchModel(event.target.value)}
                  title="切换会重启推理进程，下次检测时加载"
                  className="h-7 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1.5 text-badge text-fg focus:border-brand focus:outline-none disabled:opacity-50"
                >
                  {modelInfo.models.length === 0 ? (
                    <option value={modelInfo.model}>{modelInfo.model}（缺失）</option>
                  ) : null}
                  {modelInfo.models.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid="yolo-add-model"
                  disabled={modelBusy || running}
                  onClick={() => void addModel()}
                  title="从本机导入 .pt 权重（或内含 .pt 的 .zip），复制进组件模型目录"
                  className="flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-line px-2 text-badge text-dim hover:bg-raised hover:text-fg disabled:opacity-40"
                >
                  <FolderPlus className="size-3.5" strokeWidth={1.75} />
                  导入模型…
                </button>
              </div>
              <div className="flex min-h-[16px] items-center gap-2 text-badge">
                <span className="shrink-0 text-faint">推理设备</span>
                {deviceChip ? (
                  <span
                    data-testid="yolo-model-device"
                    className={cn('inline-flex items-center gap-1', deviceChip.tone)}
                    title={deviceChip.title}
                  >
                    <span className={cn('size-1.5 rounded-full', deviceChip.dot)} />
                    {deviceChip.text}
                    {deviceChip.text === 'CPU' ? '（较慢）' : ''}
                  </span>
                ) : (
                  <span className="text-faint">未启动</span>
                )}
                {modelBusy ? <span className="text-pending">切换中…</span> : null}
                {modelNote ? (
                  <span
                    className={cn(
                      'min-w-0 truncate',
                      modelNote.startsWith('已切换') || modelNote.startsWith('已导入')
                        ? 'text-confirmed'
                        : 'text-failed',
                    )}
                    title={modelNote}
                  >
                    {modelNote}
                  </span>
                ) : null}
              </div>
            </>
          ) : ready ? (
            <p className="text-badge text-faint">
              {modelUnavailable ? '当前引擎不支持读取模型列表' : '正在读取模型列表…'}
            </p>
          ) : null}

          {ready ? (
            <div className="flex items-center justify-between gap-2 text-badge text-faint">
              <span className="truncate">
                {status?.installed
                  ? `AI 组件${status.version ? ` v${status.version}` : ''} 已就绪`
                  : '开发态：引擎自带 AI 运行时'}
              </span>
              <button
                type="button"
                data-testid="yolo-install-component"
                disabled={running}
                onClick={() => void installFromFile()}
                title="安装/更换 AI 组件包（选择 .zip）"
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-line px-2 text-badge text-dim hover:bg-raised hover:text-fg disabled:opacity-40"
              >
                <Download className="size-3.5" strokeWidth={1.75} />
                更换组件…
              </button>
            </div>
          ) : null}

          {checkingComponent ? <p className="text-badge text-faint">正在检查 AI 组件…</p> : null}

          {/* 组件未就绪才展开安装卡：就绪时界面上看不到"加载/检查"过程 */}
          {installing || (!loading && !ready) ? (
            <div
              className="flex flex-col gap-1.5 rounded-sm border border-pending/30 bg-pending/5 px-2 py-1.5 text-badge"
              data-testid="yolo-component-status"
            >
              <span className="text-pending">
                还没有安装 AI 组件（CPU 版约 400MB；有 NVIDIA 显卡建议装 CUDA 版，约 4~5GB，装一次即可）
              </span>
              {installing ? (
                <div className="flex flex-col gap-1">
                  <div className="h-1 w-full overflow-hidden rounded-full bg-raised">
                    <div
                      className="h-full bg-brand transition-[width]"
                      style={{ width: `${Math.max(3, progress)}%` }}
                    />
                  </div>
                  <span className="text-faint">{stage || '安装中…'}</span>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="yolo-install"
                    onClick={() => void install()}
                    className="flex h-7 w-fit items-center gap-1.5 rounded-sm border border-brand/50 px-2 text-brand hover:bg-brand/10"
                  >
                    <Download className="size-3.5" strokeWidth={1.75} /> 安装 AI 组件
                  </button>
                  <button
                    type="button"
                    data-testid="yolo-install-file"
                    onClick={() => void installFromFile()}
                    title="离线安装：选择已经下载好的组件 zip"
                    className="h-7 rounded-sm border border-line px-2 text-dim hover:bg-raised hover:text-fg"
                  >
                    从本地 zip 安装…
                  </button>
                </div>
              )}
              {error ? (
                <div className="text-failed">
                  {messageOf(error)}
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    className="ml-1 underline hover:text-fg"
                  >
                    重试
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {ready && error ? (
            <div className="rounded-sm border border-failed/40 bg-failed/5 px-2 py-1 text-badge text-failed">
              {messageOf(error)}
              <button type="button" onClick={() => void refresh()} className="ml-1 underline hover:text-fg">
                重试
              </button>
            </div>
          ) : null}
          {runtimeError ? (
            <p className="text-badge text-failed" title={runtimeError}>
              worker：{runtimeError}
            </p>
          ) : null}
        </Section>
      </div>

      {/* 底部钉住「开始实时检测」：调参时不用滚动就能点到 */}
      <div className="relative z-10 shrink-0 border-t border-line bg-raised px-4 py-3">
        <div className="mb-1.5 flex min-h-[16px] flex-wrap items-center gap-x-2 gap-y-1 text-badge">
          {running ? (
            <span className="flex items-center gap-1 text-confirmed">
              <span className="size-1.5 animate-pulse rounded-full bg-confirmed" />
              检测中
            </span>
          ) : null}
          <span className={preview ? 'text-dim' : 'text-faint'}>
            {running
              ? preview
                ? `${preview.dets.length} 个目标 · ${preview.ms.toFixed(0)}ms`
                : '等待第一帧…'
              : preview
                ? `上次检测 · ${preview.dets.length} 个目标 · ${preview.ms.toFixed(0)}ms`
                : '还没开始检测'}
          </span>
          {previewDevice ? (
            <span
              className={preview?.device === 'cuda' ? 'text-confirmed' : 'text-pending'}
              title={preview?.device === 'cpu' ? CPU_HINT : undefined}
            >
              · {previewDevice}
            </span>
          ) : null}
          {preview?.device === 'cpu' ? <span className="text-pending">（CPU 推理偏慢）</span> : null}
        </div>
        <button
          type="button"
          data-testid="yolo-detect-toggle"
          disabled={!ready || enabledMarks.length === 0}
          onClick={toggleDetection}
          title={ready ? '用当前参数连续检测，结果画在画面上' : '先安装 AI 组件'}
          className={cn(
            'flex h-8 w-full items-center justify-center gap-1.5 rounded-sm border text-body',
            running
              ? 'border-failed/60 text-failed enabled:hover:bg-failed/10'
              : 'border-brand/50 text-brand enabled:hover:bg-brand/10',
            (!ready || enabledMarks.length === 0) && 'cursor-not-allowed opacity-40',
          )}
        >
          {running ? (
            <Square className="size-3.5" strokeWidth={1.75} />
          ) : (
            <Play className="size-3.5" strokeWidth={1.75} />
          )}
          {running ? '停止检测' : '开始实时检测'}
        </button>
      </div>
    </aside>
  );
}
