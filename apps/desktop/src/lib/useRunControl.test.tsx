/**
 * 运行按钮的禁用原因（`lib/useRunControl.ts`）：
 *   - 没设备 / 没连上 → 挡住；
 *   - 设备连上，但**图里一个界面节点都没有** → 挡住（先去画面栏框选录一个）。
 *
 * 单独测这个 hook（不去挂 App 主壳）：主壳挂载会触发图 refresh，把测试摆好的脚本冲掉。
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRunControl } from '@/lib/useRunControl';
import { useDeviceStore } from '@/stores/device.store';
import { WORKFLOW_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import type { DeviceRuntime } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

function Probe() {
  const { blocker } = useRunControl();
  return <span data-testid="blocker">{blocker ?? '可运行'}</span>;
}

const DEVICE: DeviceRuntime = {
  id: 'android:3387980',
  name: 'OPPO A57',
  uri: 'android:///?serial=3387980',
  kind: 'android',
  status: 'connected',
  resolution: [720, 1280],
  fps: 14,
};

const blockerText = (): string => screen.getByTestId('blocker').textContent ?? '';

beforeEach(() => {
  useDeviceStore.setState({ devices: [DEVICE], activeId: DEVICE.id });
  useGraphStore.setState({ graphs: {}, raws: {} });
  useSessionStore.setState({ running: {} });
});

describe('运行按钮的禁用原因', () => {
  it('设备连上但步骤链为空 → 挡住', () => {
    useGraphStore.setState({
      raws: {
        [WORKFLOW_SCOPE]: {
          version: 1,
          defaults: {},
          nodes: [],
          edges: [],
          recognizers: {},
          flow: { steps: [] },
        },
      },
      graphs: {
        [WORKFLOW_SCOPE]: {
          deviceId: WORKFLOW_SCOPE,
          nodes: [],
          edges: [],
          recognizers: [],
          variables: [],
          activeNodeId: null,
          pendingNodeId: null,
          flow: { steps: [] },
        },
      },
    });
    render(<Probe />);
    expect(blockerText()).toContain('工作流还是空的');
  });

  it('设备没连上 → 先挡（提示先连设备）', () => {
    useDeviceStore.setState({ devices: [{ ...DEVICE, status: 'connecting' }], activeId: DEVICE.id });
    render(<Probe />);
    expect(blockerText()).toContain('设备还没连上');
  });

  it('一台设备都没有 → 提示先去设备面板', () => {
    useDeviceStore.setState({ devices: [], activeId: '' });
    render(<Probe />);
    expect(blockerText()).toContain('先在设备面板');
  });

  it('步骤链模式：有触发块即可运行（不要求 nodes）', () => {
    useGraphStore.setState({
      raws: {
        [WORKFLOW_SCOPE]: {
          version: 1,
          defaults: {},
          nodes: [],
          edges: [],
          recognizers: {},
          flow: { steps: [{ id: 'trigger', type: 'schedule', params: { at: '09:00' } }] },
        },
      },
      graphs: {
        [WORKFLOW_SCOPE]: {
          deviceId: WORKFLOW_SCOPE,
          nodes: [],
          edges: [],
          recognizers: [],
          variables: [],
          activeNodeId: null,
          pendingNodeId: null,
          flow: { steps: [{ id: 'trigger', type: 'schedule', params: { at: '09:00' } }] },
        },
      },
    });
    render(<Probe />);
    expect(blockerText()).toBe('可运行');
  });
});
