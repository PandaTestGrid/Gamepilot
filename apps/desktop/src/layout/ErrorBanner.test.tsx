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
      missingMethods: ['workflow.create', 'workflow.rename'],
      restart,
    });
    render(<ErrorBanner />);

    expect(screen.getByText(/引擎是旧进程/)).toBeInTheDocument();
    expect(screen.getByText(/workflow\.create/)).toBeInTheDocument();

    await user.click(screen.getByText('重启引擎'));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('业务错误里出现 -32601：也认成"旧进程"，同样给出重启入口', async () => {
    const user = userEvent.setup();
    const restart = vi.fn(() => Promise.resolve());
    useEngineStore.setState({ status: 'ready', missingMethods: [], restart });
    useSessionStore.setState({
      error: '引擎返回错误: {"code":-32601,"message":"未知方法: workflow.create"}',
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
    useEngineStore.setState({
      status: 'error',
      info: '引擎启动失败：sidecar 不存在',
      missingMethods: [],
      restart,
    });
    render(<ErrorBanner />);

    expect(screen.getByText(/引擎启动失败/)).toBeInTheDocument();
    await user.click(screen.getByText('重启引擎'));
    expect(restart).toHaveBeenCalled();
  });

  it('引擎中途退出：info 原样显示（不说成"启动失败"），照样给「重启引擎」', () => {
    useEngineStore.setState({
      status: 'error',
      info: '引擎已退出（exit status: 1）：点「重启引擎」重开一次',
      missingMethods: [],
    });
    render(<ErrorBanner />);

    // 原样显示：套一层"引擎启动失败："就把"已退出"说错了
    expect(screen.getByText(/引擎已退出/)).toBeInTheDocument();
    expect(screen.queryByText(/启动失败/)).not.toBeInTheDocument();
    expect(screen.getByText('重启引擎')).toBeInTheDocument();
    // 引擎出问题时，顺手给一个"复制诊断"（别人电脑上跑不起来时最省事的一步）
    expect(screen.getByText('复制诊断')).toBeInTheDocument();
  });
});
