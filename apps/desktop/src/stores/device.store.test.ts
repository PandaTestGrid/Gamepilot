import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MOCK_DEVICES } from '@/mock/seed';
import { useDeviceStore } from '@/stores/device.store';

function reset(): void {
  useDeviceStore.setState({ devices: MOCK_DEVICES, activeId: 'dev-a', gridView: false });
}

describe('多设备 store', () => {
  beforeEach(() => {
    reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connect 先进入 connecting，再变成 connected 并带 fps', () => {
    useDeviceStore.getState().connect('dev-c');
    expect(useDeviceStore.getState().devices.find((item) => item.id === 'dev-c')?.status).toBe('connecting');

    vi.advanceTimersByTime(800);

    const device = useDeviceStore.getState().devices.find((item) => item.id === 'dev-c');
    expect(device?.status).toBe('connected');
    expect(device?.fps).toBeGreaterThan(0);
  });

  it('切换活动设备只改 activeId，不影响其他设备', () => {
    useDeviceStore.getState().setActive('dev-b');
    expect(useDeviceStore.getState().activeId).toBe('dev-b');
    expect(useDeviceStore.getState().devices.find((item) => item.id === 'dev-a')?.status).toBe('connected');
  });

  it('断开活动设备时自动切到另一台已连接设备', () => {
    useDeviceStore.getState().disconnect('dev-a');

    const state = useDeviceStore.getState();
    expect(state.devices.find((item) => item.id === 'dev-a')?.status).toBe('discovered');
    expect(state.activeId).toBe('dev-b');
  });

  it('已连接设备少于 2 台时自动退出多开网格', () => {
    useDeviceStore.setState({ gridView: true });
    useDeviceStore.getState().disconnect('dev-b');

    expect(useDeviceStore.getState().gridView).toBe(false);
  });

  it('失败态会带上错误原因与修复建议', () => {
    useDeviceStore.getState().failConnect('dev-c', '端口被占用');

    const device = useDeviceStore.getState().devices.find((item) => item.id === 'dev-c');
    expect(device?.status).toBe('failed');
    expect(device?.error).toBe('端口被占用');
    expect(device?.suggestedFix).toBeTruthy();
  });
});
