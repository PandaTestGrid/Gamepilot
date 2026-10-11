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

  it('没有工作区时给"新建工作区"入口（新用户第一眼该看到出路，而不是空白）', () => {
    const { container } = render(<TaskTabs />);
    expect(container.textContent).toContain('新建工作区');
  });

  it('目录树拉取失败时不崩（降级成"新建工作区"入口，不把异常抛给上层）', () => {
    useSessionStore.setState({
      project: {
        root: '/tmp/x/y',
        graphPath: '/tmp/x/y/graph.json',
        templates: 0,
        nodes: 0,
        edges: 0,
        recognizers: 0,
      },
    });
    const { container } = render(<TaskTabs />);
    expect(container.textContent).toContain('新建工作区');
  });
});
