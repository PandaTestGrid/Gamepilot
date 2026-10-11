/**
 * 任务标签栏必须"引擎没起来也不崩"：空数据、拉取失败都只显示空。
 */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskTabs } from '@/features/graph/TaskTabs';
import { useSessionStore } from '@/stores/session.store';

vi.mock('@/lib/rpc', () => ({
  devLog: vi.fn(),
  projectCreate: vi.fn(),
  workspaceTree: vi.fn(() => Promise.reject(new Error('引擎未启动'))),
}));

describe('任务标签栏', () => {
  beforeEach(() => {
    useSessionStore.setState({ project: null });
  });

  it('没有当前脚本时渲染为空（不抛错）', () => {
    const { container } = render(<TaskTabs />);
    expect(container.textContent).toBe('');
  });

  it('目录树拉取失败时渲染为空（不把异常抛给上层）', () => {
    useSessionStore.setState({
      project: { root: '/tmp/x/y', name: 'y', nodes: 0, edges: 0, recognizers: 0 },
    });
    const { container } = render(<TaskTabs />);
    expect(container.textContent).toBe('');
  });
});
