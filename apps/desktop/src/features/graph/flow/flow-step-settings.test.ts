import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FLOW_GLOBAL_CONFIG,
  resolveFlowGlobalDefaults,
} from '@/features/graph/flow/FlowGlobalSettingsDrawer';
import {
  lineStyleForStep,
  mergeStepSettings,
  readStepSettings,
  settingsToParams,
} from '@/features/graph/flow/flow-step-settings';

describe('flow-step-settings', () => {
  it('读写 settings 嵌套对象（含单步延迟与匹配等待覆盖）', () => {
    const params = settingsToParams(
      { x: 0.5 },
      {
        general: { debug: true, matchTimeoutMs: 15000, preDelayMs: 100, postDelayMs: 400 },
        onError: { enabled: true, mode: 'continue' },
        line: { label: 'ok', color: '#ff0000' },
      },
    );
    expect(readStepSettings(params).general?.debug).toBe(true);
    expect(readStepSettings(params).general?.matchTimeoutMs).toBe(15000);
    expect(readStepSettings(params).general?.preDelayMs).toBe(100);
    expect(readStepSettings(params).general?.postDelayMs).toBe(400);
    expect(readStepSettings(params).onError?.mode).toBe('continue');
    expect(lineStyleForStep({ params }, 'next').stroke).toBe('#ff0000');
    expect(lineStyleForStep({ params }, 'next').label).toBe('ok');
  });

  it('resolveFlowGlobalDefaults 默认模板匹配等待 20s 并正确解析覆盖项', () => {
    const defaults = resolveFlowGlobalDefaults(undefined);
    expect(defaults.match_timeout_ms).toBe(20000);
    expect(defaults.wait_timeout_ms).toBe(20000);
    expect(defaults.step_interval_ms).toBe(DEFAULT_FLOW_GLOBAL_CONFIG.step_interval_ms);
    expect(defaults.swipe_bezier).toBe(true);
    expect(defaults.swipe_easing).toBe('ease_in_out');
    expect(defaults.swipe_bezier_order).toBe(3);
    expect(defaults.tap_duration_ms).toBe(50);
    expect(defaults.click_micro_px).toBe(2);

    const custom = resolveFlowGlobalDefaults({
      match_timeout_ms: 8000,
      pre_action_delay_ms: 150,
      post_action_delay_ms: 350,
      on_step_error: 'retry',
      step_retries: 4,
      swipe_bezier: false,
      swipe_easing: 2,
      swipe_bezier_order: 4,
    });
    expect(custom.match_timeout_ms).toBe(8000);
    expect(custom.pre_action_delay_ms).toBe(150);
    expect(custom.post_action_delay_ms).toBe(350);
    expect(custom.on_step_error).toBe('retry');
    expect(custom.step_retries).toBe(4);
    expect(custom.swipe_bezier).toBe(false);
    expect(custom.swipe_easing).toBe('ease_out');
    expect(custom.swipe_bezier_order).toBe(4);
  });

  it('merge 保留未改字段', () => {
    const merged = mergeStepSettings(
      { onError: { enabled: true, retry: true, retryTimes: 5 } },
      { onError: { mode: 'fallback', fallbackStepId: 's_a' } },
    );
    expect(merged.onError?.retry).toBe(true);
    expect(merged.onError?.fallbackStepId).toBe('s_a');
  });

  it('空 settings 时从 params 去掉键', () => {
    const next = settingsToParams({ settings: { general: { debug: false } }, ms: 1 }, {});
    expect(next.settings).toBeUndefined();
    expect(next.ms).toBe(1);
  });
});
