/**
 * 错误条：把"引擎是旧进程"变成一键可修。
 *
 * 用户视角的原始体验是：点「新建脚本」→ 弹一串 JSON-RPC 错误（-32601 未知方法）→ 不知道怎么办。
 * 现在的约定：这条错误旁边必须有一个「重启引擎」按钮，点了就停旧进程、拉新进程。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBanner } from '@/layout/ErrorBanner';
import { useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
import { useSessionStore } from '@/stores/session.store';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

describe('错误条', () => {
  beforeEach(() => {
    useEngineStore.setState({ status: 'idle', info: '', notifications: [], missingMethods: [] });
    useSessionStore.setState({ error: null });
    useDeviceStore.setState({ scanError: null });
  });

  it('引擎缺方法：直接说"旧进程"+怎么修，并给出「重启引擎」', async () => {
    const user = userEvent.setup();
    const restart = vi.fn(() => Promise.resolve());
    useEngineStore.setState({
      status: 'ready',
      missingMethods: ['project.create', 'project.rename'],
      restart,
    });
    render(<ErrorBanner />);

    expect(screen.getByText(/引擎是旧进程/)).toBeInTheDocument();
    expect(screen.getByText(/project\.create/)).toBeInTheDocument();

    await user.click(screen.getByText('重启引擎'));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('业务错误里出现 -32601：也认成"旧进程"，同样给出重启入口', async () => {
    const user = userEvent.setup();
    const restart = vi.fn(() => Promise.resolve());
    useEngineStore.setState({ status: 'ready', missingMethods: [], restart });
    useSessionStore.setState({
      error: '引擎返回错误: {"code":-32601,"message":"未知方法: project.create"}',
    });
    render(<ErrorBanner />);

    expect(screen.getByText(/旧进程/)).toBeInTheDocument();
    await user.click(screen.getByText('重启引擎'));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('普通业务错误：原样显示，不硬塞"重启引擎"', () => {
    useEngineStore.setState({ status: 'ready', missingMethods: [] });
    useSessionStore.setState({ error: '设备未连接：先在设备面板连接一台' });
    render(<ErrorBanner />);

    expect(screen.getByText(/设备未连接/)).toBeInTheDocument();
    expect(screen.queryByText('重启引擎')).not.toBeInTheDocument();
  });

  it('引擎起不来：给「重启引擎」，点了会重新拉起', async () => {
    const user = userEvent.setup();
    const restart = vi.fn(() => Promise.resolve());
    useEngineStore.setState({ status: 'error', info: '引擎未启动', missingMethods: [], restart });
    render(<ErrorBanner />);

    expect(screen.getByText(/引擎启动失败/)).toBeInTheDocument();
    await user.click(screen.getByText('重启引擎'));
    expect(restart).toHaveBeenCalled();
  });
});
