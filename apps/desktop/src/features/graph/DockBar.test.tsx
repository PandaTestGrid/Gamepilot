/**
 * 编辑坞（详情区）的显式展开/收起。
 *
 * 用户反馈"下方加一个展开和收起的功能区域"：以前只有"选中节点/边自动展开"和"拖那道横线"
 * 两个隐式入口，得有一个看得见、点得到的开关。这里守住：按钮切面板状态、文案跟着变。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DockBar } from '@/features/graph/DockBar';

function fakePanel(collapsed = true) {
  let isCollapsed = collapsed;
  return {
    collapse: vi.fn(() => {
      isCollapsed = true;
    }),
    expand: vi.fn(() => {
      isCollapsed = false;
    }),
    isCollapsed: () => isCollapsed,
  };
}

describe('编辑坞控制条', () => {
  it('收起态显示「展开」，点一下展开面板', async () => {
    const user = userEvent.setup();
    const panel = fakePanel(true);
    const ref = { current: panel as never };
    render(<DockBar panelRef={ref} title="界面 · 主界面" />);

    const button = await screen.findByRole('button', { name: /展开/ });
    await user.click(button);

    expect(panel.expand).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /收起/ })).toBeInTheDocument();
  });

  it('展开态显示「收起」，点一下收起面板', async () => {
    const user = userEvent.setup();
    const panel = fakePanel(false);
    const ref = { current: panel as never };
    render(<DockBar panelRef={ref} title="界面 · 商店" />);

    await user.click(await screen.findByRole('button', { name: /收起/ }));
    expect(panel.collapse).toHaveBeenCalled();
  });

  it('收起时也能看到"正在编辑什么"', () => {
    render(<DockBar panelRef={{ current: fakePanel(true) as never }} title="界面 · 主界面" />);
    expect(screen.getByText(/界面 · 主界面/)).toBeInTheDocument();
  });
});
