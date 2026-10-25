import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StartupApp } from '@/layout/StartupApp';
import { useEngineStore } from '@/stores/engine.store';

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn((command: string): Promise<unknown> =>
    command === 'finish_startup' ? Promise.resolve() : Promise.resolve({}),
  ),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

beforeEach(() => {
  invoke.mockClear();
  useEngineStore.setState({
    status: 'connecting',
    info: '正在启动引擎',
    notifications: [],
    missingMethods: [],
  });
});

describe('StartupApp', () => {
  it('引擎未就绪时不显示主窗口，ready 后只切换一次', async () => {
    const view = render(<StartupApp />);
    expect(invoke).not.toHaveBeenCalledWith('finish_startup');

    useEngineStore.setState({ status: 'ready', info: 'engine ready' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('finish_startup'));

    view.rerender(<StartupApp />);
    await Promise.resolve();
    expect(invoke.mock.calls.filter(([command]) => command === 'finish_startup')).toHaveLength(1);
  });
});
