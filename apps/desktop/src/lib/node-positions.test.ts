/**
 * 节点坐标记忆：这是"拖动后节点消失 / 建新节点前面的节点也没了"的根治点。
 *
 * 守住五条：
 *   1. 引擎回包（只有网格坐标）不能覆盖用户拖过的位置；
 *   2. 新出现的节点用引擎给的坐标，删掉的节点自然丢弃；
 *   3. 坐标写进 localStorage，重启后还在；`重新布局` 显式丢弃；
 *   4. 存储坏掉（隐私模式/脏数据）不能让画布挂掉；
 *   5. 记忆**只按脚本目录**分（不按设备）：同一份脚本换台设备看到的是同一份摆位，
 *      否则"切设备布局自己变了"（用户反馈）；旧版本按设备存的那些键要能读回来。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyPositions,
  clearStoredPositions,
  clearStoredPositionsForRoot,
  clearStoredPositionsUnder,
  copyStoredPositions,
  loadStoredPositions,
  migrateStoredPositions,
  positionsOf,
  preservePositions,
  setPositionScope,
  storePositions,
} from '@/lib/node-positions';
import type { GraphData } from '@/types';

function graph(nodes: Array<{ id: string; x: number; y: number }>): GraphData {
  return {
    deviceId: 'dev',
    nodes: nodes.map((node) => ({ name: node.id, enter: [], visits: 0, ...node })),
    edges: [],
    variables: [],
    recognizers: [],
    activeNodeId: null,
    pendingNodeId: null,
  };
}

describe('节点坐标记忆', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setPositionScope('/repo/workspaces/默认/斗技');
  });

  it('引擎回包不会覆盖拖过的坐标（这是"拖动后节点弹回去"的根因）', () => {
    const before = graph([{ id: 'n1', x: 400, y: 260 }]); // 用户拖到的位置
    const fromEngine = graph([{ id: 'n1', x: 60, y: 40 }]); // 引擎重排后的网格位置

    expect(preservePositions(fromEngine, before).nodes[0]).toMatchObject({ x: 400, y: 260 });
  });

  it('新节点用引擎坐标，删掉的节点不残留', () => {
    const before = graph([
      { id: 'n1', x: 400, y: 260 },
      { id: 'n2', x: 500, y: 300 },
    ]);
    const fromEngine = graph([
      { id: 'n1', x: 60, y: 40 },
      { id: 'n3', x: 260, y: 40 }, // 新节点
    ]);

    const merged = preservePositions(fromEngine, before);
    expect(merged.nodes.map((node) => node.id)).toEqual(['n1', 'n3']);
    expect(merged.nodes[0]).toMatchObject({ x: 400, y: 260 }); // 老的保住
    expect(merged.nodes[1]).toMatchObject({ x: 260, y: 40 }); // 新的用引擎的
  });

  it('没有上一份图时按原样返回（不误伤）', () => {
    const fresh = graph([{ id: 'n1', x: 60, y: 40 }]);
    expect(preservePositions(fresh, undefined)).toBe(fresh);
  });

  it('localStorage 记住坐标：重启后还在', () => {
    storePositions(graph([{ id: 'n1', x: 321, y: 123 }]));

    expect(loadStoredPositions()).toEqual({ n1: { x: 321, y: 123 } });
    // 冷启动：引擎回包 + 本地记忆 → 位置恢复
    const restored = applyPositions(graph([{ id: 'n1', x: 60, y: 40 }]), loadStoredPositions());
    expect(restored.nodes[0]).toMatchObject({ x: 321, y: 123 });
  });

  it('坐标只按脚本记：换设备不会各摆一套（"切设备布局自己变了"的根治点）', () => {
    storePositions(graph([{ id: 'n1', x: 321, y: 123 }]));
    // 同一份脚本、另一台设备：读到的还是同一份摆位
    // （以前键是 `:<设备 id>`，A 设备摆好切到 B 就套用 B 的旧记忆）
    expect(loadStoredPositions()).toEqual({ n1: { x: 321, y: 123 } });
    // 存储里只有"脚本级"一个键，不再出现 `:<设备 id>` 后缀
    expect(Object.keys(window.localStorage)).toEqual(['gamepilot.node-positions:/repo/workspaces/默认/斗技']);
  });

  it('旧版本按设备存的坐标还能读回来（升级不丢摆位）', () => {
    const scope = 'gamepilot.node-positions:/repo/workspaces/默认/斗技';
    // 设备 id 里本身带冒号（android:7b69da0c），键的切分不能按冒号数去猜
    window.localStorage.setItem(`${scope}:android:7b69da0c`, JSON.stringify({ n1: { x: 10, y: 20 } }));
    window.localStorage.setItem(
      `${scope}:ios:bbb`,
      JSON.stringify({ n1: { x: 33, y: 44 }, n2: { x: 5, y: 6 } }),
    );

    // 同名节点后写的那台赢，不同节点的坐标合并成一份
    expect(loadStoredPositions()).toEqual({ n1: { x: 33, y: 44 }, n2: { x: 5, y: 6 } });
    // 别的脚本的记忆不能被顺手捡进来
    window.localStorage.setItem(
      'gamepilot.node-positions:/repo/workspaces/默认/御魂:android:7b69da0c',
      JSON.stringify({ n9: { x: 1, y: 1 } }),
    );
    expect(loadStoredPositions()).toEqual({ n1: { x: 33, y: 44 }, n2: { x: 5, y: 6 } });
  });

  it('换工作流不串味（每个工作流的摆位分开记）', () => {
    storePositions(graph([{ id: 'n1', x: 1, y: 2 }]));
    setPositionScope('/repo/workspaces/默认/御魂');

    expect(loadStoredPositions()).toEqual({});
  });

  it('清掉记忆（重新布局用）：脚本级与旧设备级的都不留', () => {
    storePositions(graph([{ id: 'n1', x: 1, y: 2 }]));
    window.localStorage.setItem(
      'gamepilot.node-positions:/repo/workspaces/默认/斗技:android:aaa',
      JSON.stringify({ n1: { x: 9, y: 9 } }),
    );

    clearStoredPositions();

    expect(loadStoredPositions()).toEqual({});
  });

  it('存储里是脏数据时不抛异常（画布不能因此挂掉）', () => {
    window.localStorage.setItem('gamepilot.node-positions:/repo/workspaces/默认/斗技', '{{{ 不是 JSON');
    expect(loadStoredPositions()).toEqual({});

    window.localStorage.setItem(
      'gamepilot.node-positions:/repo/workspaces/默认/斗技',
      JSON.stringify({ n1: { x: 'oops' }, n2: { x: 5, y: 6 } }),
    );
    expect(loadStoredPositions()).toEqual({ n2: { x: 5, y: 6 } });
  });

  it('positionsOf 只取 id 与坐标', () => {
    expect(positionsOf(graph([{ id: 'n1', x: 7, y: 8 }]))).toEqual({ n1: { x: 7, y: 8 } });
    expect(positionsOf(undefined)).toEqual({});
  });

  it('localStorage 写入失败（隐私模式）不抛异常', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => storePositions(graph([{ id: 'n1', x: 1, y: 1 }]))).not.toThrow();
    setItem.mockRestore();
  });

  it('工作流改名与复制时迁移/拷贝坐标，删除工作流或工作区时清掉对应键', () => {
    storePositions(graph([{ id: 'n1', x: 180, y: 260 }]));

    copyStoredPositions('/repo/workspaces/默认/斗技', '/repo/workspaces/默认/斗技-副本');
    setPositionScope('/repo/workspaces/默认/斗技-副本');
    expect(loadStoredPositions()).toEqual({ n1: { x: 180, y: 260 } });

    migrateStoredPositions('/repo/workspaces/默认/斗技', '/repo/workspaces/默认/道馆');
    setPositionScope('/repo/workspaces/默认/斗技');
    expect(loadStoredPositions()).toEqual({});
    setPositionScope('/repo/workspaces/默认/道馆');
    expect(loadStoredPositions()).toEqual({ n1: { x: 180, y: 260 } });

    clearStoredPositionsForRoot('/repo/workspaces/默认/斗技-副本');
    setPositionScope('/repo/workspaces/默认/斗技-副本');
    expect(loadStoredPositions()).toEqual({});

    clearStoredPositionsUnder('/repo/workspaces/默认');
    setPositionScope('/repo/workspaces/默认/道馆');
    expect(loadStoredPositions()).toEqual({});
  });
});
