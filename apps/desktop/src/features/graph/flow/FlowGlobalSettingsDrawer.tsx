/**
 * 画布右侧弹出的「工作流全局配置」面板。
 * 从画布右上角「⋯」菜单打开，读写当前工作流的 `graph.defaults`。
 */
import { Eye, Hand, Move, RotateCcw, ShieldAlert, SlidersHorizontal, Timer, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import {
  DEFAULT_SWIPE_BEZIER,
  parseOptionalBool,
  parseSwipeEasing,
  SWIPE_EASING_OPTIONS,
  type SwipeEasingId,
} from '@/features/graph/flow/flow-swipe-params';
import { IconGhostButton } from '@/layout/PanelShell';
import { FLOW_EDIT_LOCKED_HINT } from '@/lib/flow-edit-lock';
import { useCurrentWorkflowLive } from '@/lib/useLiveWorkflow';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { rawFor, SCRIPT_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useUiStore } from '@/stores/ui.store';

export interface FlowGlobalDefaults {
  readonly step_interval_ms: number;
  readonly pre_action_delay_ms: number;
  readonly post_action_delay_ms: number;
  readonly delay_jitter_ms: number;
  readonly click_jitter_px: number;
  readonly tap_duration_ms: number;
  readonly click_micro_px: number;
  readonly long_press_duration_ms: number;
  readonly swipe_duration_ms: number;
  readonly swipe_bezier: boolean;
  readonly swipe_bezier_order: number;
  readonly swipe_bezier_deviation_px: number;
  readonly swipe_bezier_bias: number;
  readonly swipe_easing: SwipeEasingId;
  readonly swipe_end_wobble: number;
  readonly swipe_end_wobble_px: number;
  readonly default_min_score: number;
  readonly match_timeout_ms: number;
  readonly vote: number;
  readonly tick_ms: number;
  readonly wait_timeout_ms: number;
  readonly on_step_error: 'stop' | 'continue' | 'retry';
  readonly step_retries: number;
  readonly retry_interval_ms: number;
}

/**
 * 这里的每个值都必须等于**引擎没读到 `graph.defaults` 时的兜底值**
 * （`core/flow_engine.py`、`core/bezier_trajectory.py`、`core/graph.py`）。
 * 否则抽屉上写的"默认"不是实际生效的值：比如以前这里写 300ms 步骤间隔、800ms 长按，
 * 引擎兜底却是 0 和 600ms。
 */
export const DEFAULT_FLOW_GLOBAL_CONFIG: FlowGlobalDefaults = {
  step_interval_ms: 0,
  pre_action_delay_ms: 0,
  post_action_delay_ms: 0,
  delay_jitter_ms: 0,
  click_jitter_px: 3,
  tap_duration_ms: 50,
  click_micro_px: 2,
  long_press_duration_ms: 600,
  swipe_duration_ms: 300,
  ...DEFAULT_SWIPE_BEZIER,
  default_min_score: 0.82,
  match_timeout_ms: 20000,
  vote: 2,
  tick_ms: 200,
  wait_timeout_ms: 20000,
  on_step_error: 'stop',
  step_retries: 2,
  retry_interval_ms: 0,
};

function readNumber(raw: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const val = raw?.[key];
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export function resolveFlowGlobalDefaults(raw?: Record<string, unknown>): FlowGlobalDefaults {
  const errRaw = raw?.on_step_error;
  const on_step_error =
    errRaw === 'continue' || errRaw === 'retry' || errRaw === 'stop'
      ? errRaw
      : DEFAULT_FLOW_GLOBAL_CONFIG.on_step_error;

  return {
    step_interval_ms: Math.max(
      0,
      Math.round(readNumber(raw, 'step_interval_ms', DEFAULT_FLOW_GLOBAL_CONFIG.step_interval_ms)),
    ),
    pre_action_delay_ms: Math.max(
      0,
      Math.round(readNumber(raw, 'pre_action_delay_ms', DEFAULT_FLOW_GLOBAL_CONFIG.pre_action_delay_ms)),
    ),
    post_action_delay_ms: Math.max(
      0,
      Math.round(readNumber(raw, 'post_action_delay_ms', DEFAULT_FLOW_GLOBAL_CONFIG.post_action_delay_ms)),
    ),
    delay_jitter_ms: Math.max(
      0,
      Math.round(readNumber(raw, 'delay_jitter_ms', DEFAULT_FLOW_GLOBAL_CONFIG.delay_jitter_ms)),
    ),
    click_jitter_px: Math.max(
      0,
      Math.round(readNumber(raw, 'click_jitter_px', DEFAULT_FLOW_GLOBAL_CONFIG.click_jitter_px)),
    ),
    tap_duration_ms: Math.max(
      10,
      Math.round(readNumber(raw, 'tap_duration_ms', DEFAULT_FLOW_GLOBAL_CONFIG.tap_duration_ms)),
    ),
    click_micro_px: Math.min(
      40,
      Math.max(0, Math.round(readNumber(raw, 'click_micro_px', DEFAULT_FLOW_GLOBAL_CONFIG.click_micro_px))),
    ),
    long_press_duration_ms: Math.max(
      100,
      Math.round(
        readNumber(raw, 'long_press_duration_ms', DEFAULT_FLOW_GLOBAL_CONFIG.long_press_duration_ms),
      ),
    ),
    swipe_duration_ms: Math.max(
      50,
      Math.round(readNumber(raw, 'swipe_duration_ms', DEFAULT_FLOW_GLOBAL_CONFIG.swipe_duration_ms)),
    ),
    swipe_bezier: parseOptionalBool(raw?.swipe_bezier) ?? DEFAULT_FLOW_GLOBAL_CONFIG.swipe_bezier,
    swipe_bezier_order: Math.min(
      8,
      Math.max(
        1,
        Math.round(readNumber(raw, 'swipe_bezier_order', DEFAULT_FLOW_GLOBAL_CONFIG.swipe_bezier_order)),
      ),
    ),
    swipe_bezier_deviation_px: Math.min(
      80,
      Math.max(
        0,
        Math.round(
          readNumber(raw, 'swipe_bezier_deviation_px', DEFAULT_FLOW_GLOBAL_CONFIG.swipe_bezier_deviation_px),
        ),
      ),
    ),
    swipe_bezier_bias: Math.min(
      0.95,
      Math.max(
        0.05,
        Number(readNumber(raw, 'swipe_bezier_bias', DEFAULT_FLOW_GLOBAL_CONFIG.swipe_bezier_bias).toFixed(2)),
      ),
    ),
    swipe_easing: parseSwipeEasing(raw?.swipe_easing, DEFAULT_FLOW_GLOBAL_CONFIG.swipe_easing),
    swipe_end_wobble: Math.min(
      8,
      Math.max(
        0,
        Math.round(readNumber(raw, 'swipe_end_wobble', DEFAULT_FLOW_GLOBAL_CONFIG.swipe_end_wobble)),
      ),
    ),
    swipe_end_wobble_px: Math.min(
      80,
      Math.max(
        0,
        Math.round(readNumber(raw, 'swipe_end_wobble_px', DEFAULT_FLOW_GLOBAL_CONFIG.swipe_end_wobble_px)),
      ),
    ),
    default_min_score: Math.min(
      0.99,
      Math.max(
        0.5,
        Number(readNumber(raw, 'default_min_score', DEFAULT_FLOW_GLOBAL_CONFIG.default_min_score).toFixed(2)),
      ),
    ),
    match_timeout_ms: Math.max(
      0,
      Math.round(readNumber(raw, 'match_timeout_ms', DEFAULT_FLOW_GLOBAL_CONFIG.match_timeout_ms)),
    ),
    vote: Math.max(1, Math.round(readNumber(raw, 'vote', DEFAULT_FLOW_GLOBAL_CONFIG.vote))),
    tick_ms: Math.max(30, Math.round(readNumber(raw, 'tick_ms', DEFAULT_FLOW_GLOBAL_CONFIG.tick_ms))),
    wait_timeout_ms: Math.max(
      500,
      Math.round(readNumber(raw, 'wait_timeout_ms', DEFAULT_FLOW_GLOBAL_CONFIG.wait_timeout_ms)),
    ),
    on_step_error,
    step_retries: Math.max(
      1,
      Math.round(readNumber(raw, 'step_retries', DEFAULT_FLOW_GLOBAL_CONFIG.step_retries)),
    ),
    retry_interval_ms: Math.max(
      0,
      Math.round(readNumber(raw, 'retry_interval_ms', DEFAULT_FLOW_GLOBAL_CONFIG.retry_interval_ms)),
    ),
  };
}

type GlobalSettingsTab = 'basic' | 'human';

const GLOBAL_SETTINGS_TABS: ReadonlyArray<{ id: GlobalSettingsTab; label: string }> = [
  { id: 'basic', label: '基础' },
  { id: 'human', label: '拟人' },
];

const inputCls =
  'h-6 w-20 shrink-0 rounded-sm border border-line bg-canvas px-1.5 text-right font-mono text-badge text-fg focus:border-brand focus:outline-none';

function ConfigSection({
  icon,
  title,
  open,
  onToggle,
  children,
}: {
  icon: ReactNode;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="rounded-sm border border-line bg-canvas/40">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-badge font-medium text-fg hover:bg-raised/60"
      >
        <span className="text-dim">{icon}</span>
        <span className="flex-1 truncate">{title}</span>
        <span className={cn('text-[10px] text-faint transition-transform', open ? 'rotate-90' : '')}>▸</span>
      </button>
      {open ? <div className="space-y-2 border-t border-line/60 px-2.5 py-2">{children}</div> : null}
    </div>
  );
}

function NumberFieldRow({
  label,
  unit,
  value,
  min = 0,
  max = 600000,
  step = 10,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (next: number) => void;
}): ReactNode {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1 truncate text-badge text-dim">{label}</div>
      <div className="flex shrink-0 items-center gap-1">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => {
            const raw = Number(event.target.value);
            if (Number.isFinite(raw)) {
              onChange(Math.min(max, Math.max(min, raw)));
            }
          }}
          className={inputCls}
        />
        <span className="w-6 text-[10px] text-faint">{unit}</span>
      </div>
    </div>
  );
}

function SelectFieldRow({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="space-y-1">
      <div className="truncate text-badge text-dim">{label}</div>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-6 w-full rounded-sm border border-line bg-canvas px-1.5 text-badge text-fg focus:border-brand focus:outline-none"
      >
        {children}
      </select>
    </div>
  );
}

export function FlowGlobalSettingsDrawer(): ReactNode {
  const open = useUiStore((state) => state.flowGlobalSettingsOpen);
  const setOpen = useUiStore((state) => state.setFlowGlobalSettingsOpen);
  const activeId = useDeviceStore((state) => state.activeId);
  const rawDefaults = useGraphStore((state) => rawFor(state, activeId || SCRIPT_SCOPE)?.defaults);
  const patchDefaults = useGraphStore((state) => state.patchDefaults);
  const lockEdits = useCurrentWorkflowLive();

  const [tab, setTab] = useState<GlobalSettingsTab>('basic');
  const [openTiming, setOpenTiming] = useState(true);
  const [openTouch, setOpenTouch] = useState(true);
  const [openDelayJitter, setOpenDelayJitter] = useState(true);
  const [openClickHuman, setOpenClickHuman] = useState(true);
  const [openSwipeHuman, setOpenSwipeHuman] = useState(true);
  const [openVision, setOpenVision] = useState(true);
  const [openError, setOpenError] = useState(true);

  if (!open) {
    return null;
  }

  const cfg = resolveFlowGlobalDefaults(rawDefaults);

  const updateField = <K extends keyof FlowGlobalDefaults>(key: K, value: FlowGlobalDefaults[K]): void => {
    if (lockEdits) {
      return;
    }
    void patchDefaults({ [key]: value });
  };

  const handleResetDefaults = (): void => {
    if (lockEdits) {
      return;
    }
    void patchDefaults({ ...DEFAULT_FLOW_GLOBAL_CONFIG });
  };

  return (
    <aside
      data-testid="flow-global-settings-drawer"
      aria-label="工作流全局配置"
      className="flex h-full w-[276px] shrink-0 flex-col border-l border-line bg-panel select-none"
    >
      {/* 顶部标题栏 */}
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-line px-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <SlidersHorizontal className="size-3.5 shrink-0 text-brand" strokeWidth={1.75} />
          <span className="truncate text-badge font-medium text-fg">全局配置</span>
          <span className="rounded-sm bg-raised px-1 py-0.2 text-[10px] text-faint">
            {lockEdits ? '运行中只读' : '默认值'}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconGhostButton
            disabled={lockEdits}
            onClick={handleResetDefaults}
            title={lockEdits ? FLOW_EDIT_LOCKED_HINT : '恢复全部默认参数'}
          >
            <RotateCcw className="size-3" strokeWidth={1.75} />
          </IconGhostButton>
          <IconGhostButton onClick={() => setOpen(false)} title="关闭全局配置">
            <X className="size-3.5" strokeWidth={1.75} />
          </IconGhostButton>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="全局配置分类"
        className="flex h-7 shrink-0 items-stretch border-b border-line"
      >
        {GLOBAL_SETTINGS_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            data-testid={`global-settings-tab-${item.id}`}
            onClick={() => setTab(item.id)}
            className={cn(
              'min-w-0 flex-1 whitespace-nowrap border-b-2 px-2 text-badge',
              tab === item.id ? 'border-brand text-fg' : 'border-transparent text-dim hover:text-fg',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div
        className={cn(
          'min-h-0 flex-1 space-y-2 overflow-y-auto p-2',
          lockEdits && 'pointer-events-none opacity-60',
        )}
      >
        {tab === 'basic' ? (
          <div data-testid="global-settings-pane-basic" className="space-y-2">
            <ConfigSection
              icon={<Timer className="size-3.5" strokeWidth={1.75} />}
              title="步骤节奏与延迟"
              open={openTiming}
              onToggle={() => setOpenTiming((v) => !v)}
            >
              <NumberFieldRow
                label="步骤间隔"
                unit="ms"
                value={cfg.step_interval_ms}
                step={50}
                onChange={(val) => updateField('step_interval_ms', val)}
              />
              <NumberFieldRow
                label="动作前延迟"
                unit="ms"
                value={cfg.pre_action_delay_ms}
                step={50}
                onChange={(val) => updateField('pre_action_delay_ms', val)}
              />
              <NumberFieldRow
                label="动作后延迟"
                unit="ms"
                value={cfg.post_action_delay_ms}
                step={50}
                onChange={(val) => updateField('post_action_delay_ms', val)}
              />
            </ConfigSection>

            <ConfigSection
              icon={<Hand className="size-3.5" strokeWidth={1.75} />}
              title="触控时长"
              open={openTouch}
              onToggle={() => setOpenTouch((v) => !v)}
            >
              <NumberFieldRow
                label="单击按下"
                unit="ms"
                value={cfg.tap_duration_ms}
                min={10}
                max={2000}
                step={10}
                onChange={(val) => updateField('tap_duration_ms', val)}
              />
              <NumberFieldRow
                label="长按"
                unit="ms"
                value={cfg.long_press_duration_ms}
                min={100}
                max={30000}
                step={100}
                onChange={(val) => updateField('long_press_duration_ms', val)}
              />
              <NumberFieldRow
                label="滑动"
                unit="ms"
                value={cfg.swipe_duration_ms}
                min={50}
                max={10000}
                step={50}
                onChange={(val) => updateField('swipe_duration_ms', val)}
              />
            </ConfigSection>

            <ConfigSection
              icon={<Eye className="size-3.5" strokeWidth={1.75} />}
              title="识别与等待默认参数"
              open={openVision}
              onToggle={() => setOpenVision((v) => !v)}
            >
              <NumberFieldRow
                label="匹配等待"
                unit="ms"
                value={cfg.match_timeout_ms}
                min={0}
                max={600000}
                step={1000}
                onChange={(val) => updateField('match_timeout_ms', val)}
              />
              <NumberFieldRow
                label="等待超时"
                unit="ms"
                value={cfg.wait_timeout_ms}
                min={500}
                max={600000}
                step={1000}
                onChange={(val) => updateField('wait_timeout_ms', val)}
              />
              <NumberFieldRow
                label="匹配阈值"
                unit="分"
                value={cfg.default_min_score}
                min={0.5}
                max={0.99}
                step={0.01}
                onChange={(val) => updateField('default_min_score', Number(val.toFixed(2)))}
              />
              <NumberFieldRow
                label="稳定帧数"
                unit="帧"
                value={cfg.vote}
                min={1}
                max={10}
                step={1}
                onChange={(val) => updateField('vote', val)}
              />
              <NumberFieldRow
                label="采样间隔"
                unit="ms"
                value={cfg.tick_ms}
                min={30}
                max={5000}
                step={20}
                onChange={(val) => updateField('tick_ms', val)}
              />
            </ConfigSection>

            <ConfigSection
              icon={<ShieldAlert className="size-3.5" strokeWidth={1.75} />}
              title="异常兜底策略"
              open={openError}
              onToggle={() => setOpenError((v) => !v)}
            >
              <div className="space-y-1">
                <div className="text-badge text-dim">步骤失败默认处理</div>
                <select
                  value={cfg.on_step_error}
                  onChange={(event) =>
                    updateField('on_step_error', event.target.value as FlowGlobalDefaults['on_step_error'])
                  }
                  className="h-6 w-full rounded-sm border border-line bg-canvas px-1.5 text-badge text-fg focus:border-brand focus:outline-none"
                >
                  <option value="stop">停止工作流并报错</option>
                  <option value="continue">忽略错误并继续下一步</option>
                  <option value="retry">自动重试当前步骤</option>
                </select>
              </div>
              {cfg.on_step_error === 'retry' ? (
                <>
                  <NumberFieldRow
                    label="重试次数"
                    unit="次"
                    value={cfg.step_retries}
                    min={1}
                    max={20}
                    step={1}
                    onChange={(val) => updateField('step_retries', val)}
                  />
                  <NumberFieldRow
                    label="重试间隔"
                    unit="ms"
                    value={cfg.retry_interval_ms}
                    min={0}
                    max={60000}
                    step={100}
                    onChange={(val) => updateField('retry_interval_ms', val)}
                  />
                </>
              ) : null}
            </ConfigSection>
          </div>
        ) : (
          <div data-testid="global-settings-pane-human" className="space-y-2">
            <ConfigSection
              icon={<Timer className="size-3.5" strokeWidth={1.75} />}
              title="时间抖动"
              open={openDelayJitter}
              onToggle={() => setOpenDelayJitter((v) => !v)}
            >
              <NumberFieldRow
                label="时间抖动"
                unit="ms"
                value={cfg.delay_jitter_ms}
                step={10}
                onChange={(val) => updateField('delay_jitter_ms', val)}
              />
            </ConfigSection>

            <ConfigSection
              icon={<Hand className="size-3.5" strokeWidth={1.75} />}
              title="点击拟人"
              open={openClickHuman}
              onToggle={() => setOpenClickHuman((v) => !v)}
            >
              <NumberFieldRow
                label="坐标偏移"
                unit="px"
                value={cfg.click_jitter_px}
                min={0}
                max={100}
                step={1}
                onChange={(val) => updateField('click_jitter_px', val)}
              />
              <NumberFieldRow
                label="触点微移"
                unit="px"
                value={cfg.click_micro_px}
                min={0}
                max={40}
                step={1}
                onChange={(val) => updateField('click_micro_px', val)}
              />
            </ConfigSection>

            <ConfigSection
              icon={<Move className="size-3.5" strokeWidth={1.75} />}
              title="滑动拟人"
              open={openSwipeHuman}
              onToggle={() => setOpenSwipeHuman((v) => !v)}
            >
              <label className="flex cursor-pointer items-center gap-2 text-badge text-dim">
                <input
                  type="checkbox"
                  data-testid="global-swipe-bezier"
                  checked={cfg.swipe_bezier}
                  onChange={(event) => updateField('swipe_bezier', event.target.checked)}
                />
                贝塞尔滑动
              </label>
              {cfg.swipe_bezier ? (
                <>
                  <NumberFieldRow
                    label="曲线阶数"
                    unit="阶"
                    value={cfg.swipe_bezier_order}
                    min={1}
                    max={8}
                    step={1}
                    onChange={(val) => updateField('swipe_bezier_order', val)}
                  />
                  <NumberFieldRow
                    label="轨迹波动"
                    unit="px"
                    value={cfg.swipe_bezier_deviation_px}
                    min={0}
                    max={80}
                    step={1}
                    onChange={(val) => updateField('swipe_bezier_deviation_px', val)}
                  />
                  <NumberFieldRow
                    label="波动位置"
                    unit=""
                    value={cfg.swipe_bezier_bias}
                    min={0.05}
                    max={0.95}
                    step={0.05}
                    onChange={(val) => updateField('swipe_bezier_bias', Number(val.toFixed(2)))}
                  />
                  <SelectFieldRow
                    label="速度曲线"
                    value={cfg.swipe_easing}
                    onChange={(val) => updateField('swipe_easing', parseSwipeEasing(val))}
                  >
                    {SWIPE_EASING_OPTIONS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </SelectFieldRow>
                  <NumberFieldRow
                    label="终点摆动"
                    unit="次"
                    value={cfg.swipe_end_wobble}
                    min={0}
                    max={8}
                    step={1}
                    onChange={(val) => updateField('swipe_end_wobble', val)}
                  />
                  {cfg.swipe_end_wobble > 0 ? (
                    <NumberFieldRow
                      label="摆动幅度"
                      unit="px"
                      value={cfg.swipe_end_wobble_px}
                      min={0}
                      max={80}
                      step={1}
                      onChange={(val) => updateField('swipe_end_wobble_px', val)}
                    />
                  ) : null}
                </>
              ) : null}
            </ConfigSection>
          </div>
        )}
      </div>
    </aside>
  );
}
