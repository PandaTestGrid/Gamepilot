/**
 * `graph.store` 的**作用域模型**：状态图属于项目（脚本），不属于设备。
 *
 * 背景（用户原话）："状态图是工作空间下面的根，和设备没有关系……我在 A 设备上录的工作流，
 * 在 B 设备上不能跑了是么？" —— 数据层面本来就没绑（`graph.json` 在项目目录里，
 * 每个设备会话都从它加载），绑错的是界面：`graphs[activeId]` 一取不到就显示
 * "这台设备还没有状态图 / 先连接设备"，画布空着。
 *
 * 现在的规矩：
 *   - `graph.get` **不带 deviceId** = 读项目里的脚本 → 没连设备也有内容；
 *   - 脚本那份存在 `SCRIPT_SCOPE` 下，某台设备那份只是它的显示缓存（叠了实时分数）；
 *   - 所有写操作都走**项目级** RPC（不带 deviceId），引擎落盘 + 让所有会话热重载。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { graphGet, graphNodeAdd } from '@/lib/rpc';
import { SCRIPT_SCOPE, graphForDevice, useGraphStore } from '@/stores/graph.store';
import type { GraphData } from '@/types';

vi.mock('@/lib/rpc', () => ({
  devLog: vi.fn(),
  graphGet: vi.fn(),
  graphSave: vi.fn(),
  graphNodeAdd: vi.fn(),
  graphEdgeAdd: vi.fn(),
  graphNodeRemove: vi.fn(),
  graphNodeUpdate: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const PAYLOAD = { nodes: [{ id: 'main', name: '主界面', enter: [] }], edges: [] };

function graph(): GraphData {
  return {
    deviceId: '',
    nodes: [{ id: 'main', name: '主界面', enter: [], x: 0, y: 0, visits: 0 }],
    edges: [],
    recognizers: [],
    variables: [],
    activeNodeId: null,
    pendingNodeId: null,
  };
}

describe('状态图的作用域（项目 vs 设备）', () => {
  beforeEach(() => {
    vi.mocked(graphGet).mockReset();
    vi.mocked(graphNodeAdd).mockReset();
    useGraphStore.setState({ graphs: {}, raws: {} });
  });

  it('没选设备也去拉脚本（项目级），并存在 SCRIPT_SCOPE 下', async () => {
    vi.mocked(graphGet).mockResolvedValue(PAYLOAD as never);

    await useGraphStore.getState().refresh('');

    // 关键：调用时**不带 deviceId**（以前带空串，引擎回"缺少参数 deviceId"）
    expect(graphGet).toHaveBeenCalledWith();
    expect(useGraphStore.getState().graphs[SCRIPT_SCOPE]?.nodes[0]?.id).toBe('main');
  });

  it('有设备时：脚本那份照写，另外给这台设备一份显示缓存', async () => {
    vi.mocked(graphGet).mockResolvedValue(PAYLOAD as never);

    await useGraphStore.getState().refresh('mock:1');

    expect(useGraphStore.getState().graphs[SCRIPT_SCOPE]).toBeTruthy();
    expect(useGraphStore.getState().graphs['mock:1']).toBeTruthy();
  });

  it('graphForDevice：设备那份没有（还没出帧/没连）就退到脚本本身', () => {
    const state = { graphs: { [SCRIPT_SCOPE]: graph() } };

    expect(graphForDevice(state, 'android:7b69da0c')).toBe(state.graphs[SCRIPT_SCOPE]);
    expect(graphForDevice(state, '')).toBe(state.graphs[SCRIPT_SCOPE]);
  });

  it('引擎没起来时只记一行日志，不往外抛（调用方是 void refresh(...)）', async () => {
    vi.mocked(graphGet).mockRejectedValue(new Error('引擎未启动'));

    await expect(useGraphStore.getState().refresh('mock:1')).resolves.toBeUndefined();
    expect(useGraphStore.getState().graphs[SCRIPT_SCOPE]).toBeUndefined();
  });

  it('改图走**项目级** RPC（不带 deviceId）—— 设备只是"在哪台机器上跑"', async () => {
    vi.mocked(graphNodeAdd).mockResolvedValue({ nodeId: 'n1', graph: PAYLOAD } as never);

    await useGraphStore.getState().createNode('mock:1', '新界面');

    expect(graphNodeAdd).toHaveBeenCalledWith({ name: '新界面', enter: undefined });
    expect(vi.mocked(graphNodeAdd).mock.calls[0]).toHaveLength(1); // 第二个参数（deviceId）没传
  });
});
