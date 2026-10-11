/**
 * 底部调试抽屉：Tab 切换、点同一个 Tab 收起、状态行与内容区一起在。
 *
 * 这是"调试信息集中到下面一处"的落地：事件流 / 日志 / 控制台 / 时间轴四个 Tab，
 * 收起时只占 28px（状态行），点开才拉开。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefObject } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';

import { BottomDock } from '@/layout/BottomDock';
import { useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { useLogStore } from '@/stores/log.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

/** 假的 Panel 句柄：只记 expand/collapse 被调过几次（真面板尺寸在布局测试里验） */
function fakePanelRef(): { ref: RefObject<PanelImperativeHandle | null>; calls: string[] } {
  const calls: string[] = [];
  const handle = {
    collapse: () => calls.push('collapse'),
    expand: () => calls.push('expand'),
  } as unknown as PanelImperativeHandle;
  return { ref: { current: handle }, calls };
}

describe('底部调试抽屉', () => {
  beforeEach(() => {
    useUiStore.setState({ dockTab: 'events', dockOpen: false });
    useDeviceStore.setState({ devices: [], activeId: '', gridView: false });
    useEventStore.setState({ events: {}, filter: 'all', seq: 0 });
    useLogStore.setState({ entries: [], minLevel: 'debug' });
    useSessionStore.setState({ frames: {}, links: {}, running: {}, ready: {}, error: null });
  });

  it('状态行不换行也不压扁：指标 shrink-0/nowrap，按钮 shrink-0（小窗口的布局回归）', () => {
    const { ref } = fakePanelRef();
    render(<BottomDock panelRef={ref} />);

    // 小窗口下的老毛病：`link dvt（慢）` 的 `（慢）` 掉到第二行、`run 运行中` 被截成半个字。
    // jsdom 没有排版引擎，所以这里锁的是"不许换行/不许压缩"这条 CSS 契约本身。
    for (const key of ['node', 'tick', 'vote', 'link', 'fps', 'capture', 'input', 'run']) {
      const chip = screen.getByText(key).parentElement;
      expect(chip?.className, `${key} 这一枚应当不换行`).toContain('whitespace-nowrap');
      expect(chip?.className, `${key} 这一枚不参与压缩`).toContain('shrink-0');
    }

    // 挤不下时收起谁：node / run 永不收起（"在哪 / 跑没跑"必须看得见），
    // 其余六枚都带一个容器查询阈值（容器 = 状态行自己，见 StatusBar 的 `@container`）
    expect(screen.getByText('node').parentElement?.className).not.toContain('@max-');
    expect(screen.getByText('run').parentElement?.className).not.toContain('@max-');
    for (const key of ['input', 'capture', 'vote', 'link', 'fps', 'tick']) {
      expect(screen.getByText(key).parentElement?.className, `${key} 应当有收起阈值`).toMatch(
        /@max-\[\d+px\]:hidden/,
      );
    }

    // 事件摘要先让位（截断 + 窄了整条收起），不会去挤指标
    const summary = screen.getByText('骨架自检未运行');
    expect(summary.className).toContain('truncate');
    expect(summary.className).toContain('min-w-0');
    expect(summary.className).toMatch(/@max-\[\d+px\]:hidden/);

    // 右侧 Tab / 抽屉按钮整组不压缩：中文标签被挤成竖排文字就点不了了
    for (const label of ['事件流', '日志', '控制台', '时间轴', '抽屉']) {
      const button = screen.getByText(label).closest('button');
      expect(button?.className, `${label} 按钮应当不压缩`).toContain('shrink-0');
      expect(button?.className, `${label} 按钮应当不换行`).toContain('whitespace-nowrap');
    }
  });

  it('四个 Tab 都在，且收起时面板是 collapse（不占纵向空间）', () => {
    const { ref, calls } = fakePanelRef();
    render(<BottomDock panelRef={ref} />);

    for (const label of ['事件流', '日志', '控制台', '时间轴']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(calls).toContain('collapse');
  });

  it('点「日志」：抽屉展开、切到日志 Tab、面板 expand', async () => {
    const user = userEvent.setup();
    const { ref, calls } = fakePanelRef();
    render(<BottomDock panelRef={ref} />);

    useLogStore.getState().appendEngine({ level: 'WARNING', logger: 'gamepilot.session', message: '掉线了' });
    await user.click(screen.getByText('日志'));

    expect(useUiStore.getState().dockOpen).toBe(true);
    expect(useUiStore.getState().dockTab).toBe('logs');
    expect(screen.getByText('掉线了')).toBeInTheDocument();
    expect(calls).toContain('expand');
  });

  it('再点同一个 Tab = 收起（和"再点一次关掉"的直觉一致）', async () => {
    const user = userEvent.setup();
    const { ref } = fakePanelRef();
    render(<BottomDock panelRef={ref} />);

    await user.click(screen.getByText('事件流'));
    expect(useUiStore.getState().dockOpen).toBe(true);

    await user.click(screen.getByText('事件流'));
    expect(useUiStore.getState().dockOpen).toBe(false);
  });

  it('控制台 Tab：能发 RPC（这里只验它真的渲染出输入框与发送按钮）', async () => {
    const user = userEvent.setup();
    const { ref } = fakePanelRef();
    render(<BottomDock panelRef={ref} />);

    await user.click(screen.getByText('控制台'));

    expect(screen.getByPlaceholderText('device.status')).toBeInTheDocument();
    expect(screen.getByText('发送')).toBeInTheDocument();
    expect(screen.getByText('engine.ping')).toBeInTheDocument();
  });

  it('时间轴 Tab：显示当前帧信息（占位实现也要能看出"现在是哪一帧"）', async () => {
    const user = userEvent.setup();
    const { ref } = fakePanelRef();
    useSessionStore.setState({
      frames: {
        'dev-1': {
          imageUrl: 'blob:x',
          index: 42,
          resolution: [720, 1280],
          node: 'main',
          pending: null,
          tick: 42,
          fps: 9.5,
          captureMs: 12,
          detections: [],
          ts: Date.now(),
        },
      },
    });
    useDeviceStore.setState({ activeId: 'dev-1' });
    render(<BottomDock panelRef={ref} />);

    await user.click(screen.getByText('时间轴'));

    expect(screen.getByText('#42')).toBeInTheDocument();
    // 节点名同时出现在状态行里，所以这里断言"时间轴那一格里也有"
    expect(screen.getAllByText('main').length).toBeGreaterThan(0);
    expect(screen.getByText(/还没接真实的帧环形缓冲/)).toBeInTheDocument();
  });
});
