/**
 * 「多开」连体按钮：左半格切网格，右半格（▾）弹分列菜单。
 *
 * 分列原来在网格上方单独占一行，把画面顶掉几十像素；并进按钮后不再占额外高度。
 * 两条契约：
 *   - 点 ▾ 只弹菜单，**不切**网格；
 *   - 在菜单里选列数 → 记住 + 顺手进多开（否则"点了没反应"）。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GridSplitButton } from '@/features/device/GridSplitButton';
import { useUiStore } from '@/stores/ui.store';

beforeEach(() => {
  useUiStore.setState({ gridColumns: 'auto' });
  window.localStorage.removeItem('gamepilot.grid-columns');
});

function renderButton(active = false): { toggle: ReturnType<typeof vi.fn> } {
  const toggle = vi.fn();
  render(
    <GridSplitButton
      active={active}
      connectedCount={2}
      deviceCount={3}
      autoColumns={2}
      onToggle={toggle}
    />,
  );
  return { toggle };
}

describe('多开连体按钮', () => {
  it('左半格：点了就是切多开', () => {
    const { toggle } = renderButton();
    fireEvent.click(screen.getByTestId('grid-toggle'));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('右半格 ▾：只弹菜单，不切网格', () => {
    const { toggle } = renderButton();
    fireEvent.click(screen.getByTestId('grid-columns-menu'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('菜单里显示自动列数，并且列数不再单独占一行', () => {
    renderButton();
    fireEvent.click(screen.getByTestId('grid-columns-menu'));

    expect(screen.getByText('自动（2）')).toBeInTheDocument();
    expect(screen.getByText('1 列')).toBeInTheDocument();
    expect(screen.getByText('3 列')).toBeInTheDocument();
  });

  it('选列数：记住偏好，并且顺手进多开', async () => {
    // 不在多开时选列数：应该同时切到多开
    const toggle = vi.fn();
    render(
      <GridSplitButton
        active={false}
        connectedCount={2}
        deviceCount={3}
        autoColumns={2}
        onToggle={toggle}
      />,
    );
    fireEvent.click(screen.getByTestId('grid-columns-menu'));
    fireEvent.click(screen.getByTestId('grid-columns-3'));

    await waitFor(() => expect(useUiStore.getState().gridColumns).toBe(3));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('已经在多开时选列数：只改列数，不重复切', () => {
    const { toggle } = renderButton(true);
    fireEvent.click(screen.getByTestId('grid-columns-menu'));
    fireEvent.click(screen.getByTestId('grid-columns-1'));

    expect(useUiStore.getState().gridColumns).toBe(1);
    expect(toggle).not.toHaveBeenCalled();
  });

  it('点菜单外面 / Esc 收起菜单', () => {
    renderButton();
    fireEvent.click(screen.getByTestId('grid-columns-menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
