/**
 * 右键菜单：加东西的入口应该出现在鼠标所在的位置。
 *
 * 三套菜单（空白 / 节点 / 边）由 GraphPane 组装，这里守菜单本身的行为：
 * 渲染交给它的项、点一项就执行并关闭、Esc / 点别处关闭、危险项有独立的颜色。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { GraphContextMenu, type MenuAnchor } from '@/features/graph/GraphContextMenu';

function anchor(items: MenuAnchor['items']): MenuAnchor {
  return {
    kind: 'node',
    id: 'main',
    flow: { x: 0, y: 0 },
    screen: { x: 100, y: 100 },
    title: '节点 主界面',
    items,
  };
}

describe('画布右键菜单', () => {
  it('渲染标题与所有项，点一项执行并关闭', async () => {
    const user = userEvent.setup();
    const addStep = vi.fn();
    const onClose = vi.fn();
    render(
      <GraphContextMenu
        anchor={anchor([
          { label: '加一步操作', hint: '原地动作', onSelect: addStep },
          { label: '删除这个界面', danger: true, onSelect: vi.fn() },
        ])}
        onClose={onClose}
      />,
    );

    expect(screen.getByText('节点 主界面')).toBeInTheDocument();
    await user.click(screen.getByText('加一步操作'));

    expect(addStep).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('危险项（删除）用失败色标出来，避免误点', () => {
    render(
      <GraphContextMenu
        anchor={anchor([{ label: '删除这个界面', danger: true, onSelect: vi.fn() }])}
        onClose={vi.fn()}
      />,
    );

    // 颜色在按钮上（文字本身只是个 span）
    expect(screen.getByText('删除这个界面').closest('button')?.className).toContain('text-failed');
  });

  it('Esc 关闭', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <GraphContextMenu anchor={anchor([{ label: '加一步操作', onSelect: vi.fn() }])} onClose={onClose} />,
    );

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('点菜单外面关闭（不黏在屏幕上）', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <div>
        <GraphContextMenu anchor={anchor([{ label: '加一步操作', onSelect: vi.fn() }])} onClose={onClose} />
        <button type="button">别处</button>
      </div>,
    );

    await user.click(screen.getByText('别处'));
    expect(onClose).toHaveBeenCalled();
  });

  it('二级菜单：点一级项展开子菜单，点子项才执行', async () => {
    const user = userEvent.setup();
    const createWait = vi.fn();
    render(
      <GraphContextMenu
        anchor={anchor([
          {
            label: '等待',
            submenu: [
              { label: '0.5 秒', onSelect: createWait },
              { label: '自定义…', onSelect: vi.fn() },
            ],
          },
        ])}
        onClose={vi.fn()}
      />,
    );

    // 一级项本身不该执行任何东西，只展开二级
    await user.click(screen.getByText('等待'));
    expect(createWait).not.toHaveBeenCalled();
    expect(screen.getByText('0.5 秒')).toBeInTheDocument();

    await user.click(screen.getByText('0.5 秒'));
    expect(createWait).toHaveBeenCalledTimes(1);
  });

  it('二级项执行后关闭整个菜单', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const pick = vi.fn();
    render(
      <GraphContextMenu
        anchor={anchor([{ label: '按键', submenu: [{ label: '返回', onSelect: pick }] }])}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByText('按键'));
    await user.click(screen.getByText('返回'));
    expect(pick).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('二级菜单里的输入行：填两个坐标 → 点「加这一步」提交', async () => {
    const user = userEvent.setup();
    const submit = vi.fn();
    render(
      <GraphContextMenu
        anchor={anchor([
          {
            label: '点击',
            submenu: [
              {
                label: '坐标（相对）',
                note: '0~1',
                input: {
                  fields: [
                    { key: 'x', placeholder: 'x' },
                    { key: 'y', placeholder: 'y' },
                  ],
                  submitLabel: '加这一步',
                  onSubmit: submit,
                },
              },
            ],
          },
        ])}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByText('点击'));
    await user.type(screen.getByLabelText('x'), '0.42');
    await user.type(screen.getByLabelText('y'), '68%');
    await user.click(screen.getByText('加这一步'));

    expect(submit).toHaveBeenCalledWith({ x: '0.42', y: '68%' });
  });

  it('输入行里按 Enter 也能提交', async () => {
    const user = userEvent.setup();
    const submit = vi.fn();
    render(
      <GraphContextMenu
        anchor={anchor([
          {
            label: '滑动',
            submenu: [
              {
                label: '起止坐标（相对）',
                input: {
                  fields: [{ key: 'x', placeholder: 'x' }],
                  submitLabel: '加这一步',
                  onSubmit: submit,
                },
              },
            ],
          },
        ])}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByText('滑动'));
    await user.type(screen.getByLabelText('x'), '0.5{Enter}');
    expect(submit).toHaveBeenCalledWith({ x: '0.5' });
  });
});
