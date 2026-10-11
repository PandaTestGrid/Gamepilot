/**
 * 节点坐标记忆：这是"拖动后节点消失 / 建新节点前面的节点也没了"的根治点。
 *
 * 守住四条：
 *   1. 引擎回包（只有网格坐标）不能覆盖用户拖过的位置；
 *   2. 新出现的节点用引擎给的坐标，删掉的节点自然丢弃；
 *   3. 坐标写进 localStorage，重启后还在；`重新布局` 显式丢弃；
 *   4. 存储坏掉（隐私模式/脏数据）不能让画布挂掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyPositions,
  clearStoredPositions,
  loadStoredPositions,
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
    setPositionScope('/repo/projects/default');
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
    storePositions('dev', graph([{ id: 'n1', x: 321, y: 123 }]));

    expect(loadStoredPositions('dev')).toEqual({ n1: { x: 321, y: 123 } });
    // 冷启动：引擎回包 + 本地记忆 → 位置恢复
    const restored = applyPositions(graph([{ id: 'n1', x: 60, y: 40 }]), loadStoredPositions('dev'));
    expect(restored.nodes[0]).toMatchObject({ x: 321, y: 123 });
  });

  it('换脚本目录不串味（各脚本的摆位分开记）', () => {
    storePositions('dev', graph([{ id: 'n1', x: 1, y: 2 }]));
    setPositionScope('/repo/projects/其他脚本');

    expect(loadStoredPositions('dev')).toEqual({});
  });

  it('清掉记忆（重新布局用）', () => {
    storePositions('dev', graph([{ id: 'n1', x: 1, y: 2 }]));
    clearStoredPositions('dev');
    expect(loadStoredPositions('dev')).toEqual({});
  });

  it('存储里是脏数据时不抛异常（画布不能因此挂掉）', () => {
    window.localStorage.setItem('gamepilot.node-positions:/repo/projects/default:dev', '{{{ 不是 JSON');
    expect(loadStoredPositions('dev')).toEqual({});

    window.localStorage.setItem(
      'gamepilot.node-positions:/repo/projects/default:dev',
      JSON.stringify({ n1: { x: 'oops' }, n2: { x: 5, y: 6 } }),
    );
    expect(loadStoredPositions('dev')).toEqual({ n2: { x: 5, y: 6 } });
  });

  it('positionsOf 只取 id 与坐标', () => {
    expect(positionsOf(graph([{ id: 'n1', x: 7, y: 8 }]))).toEqual({ n1: { x: 7, y: 8 } });
    expect(positionsOf(undefined)).toEqual({});
  });

  it('localStorage 写入失败（隐私模式）不抛异常', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => storePositions('dev', graph([{ id: 'n1', x: 1, y: 1 }]))).not.toThrow();
    setItem.mockRestore();
  });
});
