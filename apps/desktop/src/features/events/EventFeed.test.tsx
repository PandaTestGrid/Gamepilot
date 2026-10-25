import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventFeed } from '@/features/events/EventFeed';
import { useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import type { TraceEventView } from '@/types';

const event = (seq: number): TraceEventView => ({
  deviceId: 'dev',
  seq,
  ts: 1700000000 + seq,
  type: 'step_started',
  node: 'step',
  edge: null,
  message: `event-${seq}`,
});
beforeEach(() => {
  useDeviceStore.setState({ activeId: 'dev' });
  useEventStore.setState({ events: {}, filter: 'all', seq: 0 });
});
afterEach(() => vi.restoreAllMocks());

describe('事件列表增量渲染', () => {
  it('500条列表追加一条只格式化新行，不重格式化保留的499条', () => {
    useEventStore.getState().appendEngineEvents(Array.from({ length: 500 }, (_, i) => event(i + 1)));
    const format = vi.fn((ts: number) => String(ts));
    vi.spyOn(
      Intl.DateTimeFormat.prototype as unknown as { readonly format: unknown },
      'format',
      'get',
    ).mockReturnValue(format);
    render(<EventFeed />);
    expect(format).toHaveBeenCalledTimes(500);
    format.mockClear();
    act(() => useEventStore.getState().appendEngineEvent(event(501)));
    expect(format).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('event-1')).not.toBeInTheDocument();
    expect(screen.getByText('event-501')).toBeInTheDocument();
    expect(screen.getByText('500 条')).toBeInTheDocument();
  });

  it('保持zh-CN本地24小时显示与筛选/设备隔离', async () => {
    const first = event(1);
    useEventStore
      .getState()
      .appendEngineEvents([first, { ...event(2), type: 'step_failed' }, { ...event(3), deviceId: 'other' }]);
    render(<EventFeed />);
    expect(
      screen.getByText(new Date(first.ts * 1000).toLocaleTimeString('zh-CN', { hour12: false })),
    ).toBeInTheDocument();
    expect(screen.getByText('2 条')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByText('仅失败'));
    expect(screen.queryByText('event-1')).not.toBeInTheDocument();
    expect(screen.getByText('event-2')).toBeInTheDocument();
    expect(screen.queryByText('event-3')).not.toBeInTheDocument();
  });
});
