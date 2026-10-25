/**
 * AI 组件安装状态机：下载进度 / 完成 / 失败。
 * RPC 用 mock（组件装没装是引擎的状态，这里只验 store 的状态流转）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/rpc', () => ({
  yoloStatus: vi.fn(() =>
    Promise.resolve({
      component: { installed: true, version: '0.1.0', path: 'C:/x', sizeMb: 800, manifest: {} },
      runtime: {},
    }),
  ),
  yoloInstall: vi.fn(() => Promise.resolve({ accepted: true })),
  yoloRemove: vi.fn(() =>
    Promise.resolve({
      installed: false,
      version: null,
      path: 'C:/x',
      sizeMb: 0,
      manifest: {},
    }),
  ),
}));

import { useYoloStore } from '@/stores/yolo.store';

const idle = {
  status: null,
  loading: false,
  installing: false,
  progress: 0,
  stage: '',
  error: null,
};

describe('AI 组件安装状态', () => {
  beforeEach(() => {
    useYoloStore.setState(idle);
  });

  it('下载中：进度和阶段文本跟着更新', () => {
    useYoloStore.setState({ installing: true });
    useYoloStore.getState().applyProgress({
      state: 'downloading',
      progress: 42,
      stage: '正在下载组件… 320MB',
    });

    const state = useYoloStore.getState();
    expect(state.progress).toBe(42);
    expect(state.stage).toContain('320MB');
    expect(state.installing).toBe(true);
  });

  it('完成：停掉安装态并拉一次最新状态', async () => {
    useYoloStore.setState({ installing: true, progress: 90 });
    useYoloStore.getState().applyProgress({
      state: 'done',
      stage: 'AI 组件已就绪',
      status: { installed: true, version: '0.1.0', path: 'C:/x', sizeMb: 800, manifest: {} },
    });

    const state = useYoloStore.getState();
    expect(state.installing).toBe(false);
    expect(state.progress).toBe(100);
    expect(state.status?.installed).toBe(true);
    await Promise.resolve();
  });

  it('失败：记录原因、不再显示安装中', () => {
    useYoloStore.setState({ installing: true });
    useYoloStore.getState().applyProgress({ state: 'error', error: '下载超时' });

    const state = useYoloStore.getState();
    expect(state.installing).toBe(false);
    expect(state.error).toBe('下载超时');
  });

  it('卸载后状态回到未安装', async () => {
    await useYoloStore.getState().remove();
    expect(useYoloStore.getState().status?.installed).toBe(false);
  });
});
