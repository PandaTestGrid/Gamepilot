/**
 * 样本数据（**仅供布局与交互验证**）。
 *
 * 明确约定：这里的一切在 M1 之后都由引擎提供 ——
 * 设备来自 `device.list`，状态图来自 `graph.get`，事件来自 `engine.event` 通知，
 * 识别器分数来自 `engine.frame` 通知。本文件届时删除或只保留"演示模式"用途。
 */
import type { DeviceRuntime, GraphData, RecognizerView, TraceEventView } from '@/types';

export const MOCK_DEVICES: readonly DeviceRuntime[] = [
  {
    id: 'dev-a',
    name: 'SM-G9980',
    uri: 'Android:///?serial=SM-G9980',
    kind: 'android',
    status: 'connected',
    resolution: [1440, 3200],
    fps: 11,
  },
  {
    id: 'dev-b',
    name: 'MuMu Player 12',
    uri: 'Android:///?serial=127.0.0.1:7555',
    kind: 'emulator',
    status: 'connected',
    resolution: [1280, 720],
    fps: 9,
  },
  {
    id: 'dev-c',
    name: 'Unity Window (Game.exe)',
    uri: 'Windows:///?title_re=Game.*',
    kind: 'windows',
    status: 'discovered',
    resolution: [1920, 1080],
    fps: 0,
  },
  {
    id: 'dev-d',
    name: 'Mock 合成设备',
    uri: 'Mock:///?width=1280&height=720',
    kind: 'mock',
    status: 'discovered',
    resolution: [1280, 720],
    fps: 0,
  },
  {
    id: 'dev-e',
    name: 'ZPFA BE5D17',
    uri: 'Android:///?serial=ZPFA5BE5D17',
    kind: 'android',
    status: 'failed',
    resolution: [1080, 1920],
    fps: 0,
    error: '未授权：设备上未确认 USB 调试',
    suggestedFix: '在手机上确认「允许 USB 调试」，然后重新检测',
  },
];

function recognizers(): RecognizerView[] {
  return [
    {
      label: 'main_start',
      type: 'template',
      score: 0.93,
      threshold: 0.82,
      roi: [0.38, 0.4, 0.24, 0.1],
      samples: 3,
      state: 'confirmed',
    },
    {
      label: 'main_shop',
      type: 'template',
      score: 0.88,
      threshold: 0.82,
      roi: [0.38, 0.54, 0.24, 0.1],
      samples: 3,
      state: 'confirmed',
    },
    {
      label: 'battle_hp',
      type: 'color',
      score: 0.71,
      threshold: 0.6,
      roi: [0.1, 0.12, 0.5, 0.035],
      samples: 1,
      state: 'pending',
    },
    {
      label: 'battle_settle',
      type: 'template',
      score: 0.64,
      threshold: 0.82,
      roi: [0.7, 0.8, 0.22, 0.1],
      samples: 2,
      state: 'idle',
    },
    {
      label: 'popup_close',
      type: 'template',
      score: 0.0,
      threshold: 0.8,
      roi: [0.58, 0.6, 0.18, 0.09],
      samples: 2,
      state: 'idle',
    },
  ];
}

export function mockGraph(deviceId: string): GraphData {
  return {
    deviceId,
    nodes: [
      { id: 'main', name: '主界面', enter: ['main_start', 'main_shop'], x: 80, y: 60, visits: 128 },
      { id: 'battle', name: '战斗中', enter: ['battle_hp'], x: 380, y: 60, visits: 96, note: 'timeout 20s' },
      { id: 'shop', name: '商店', enter: ['shop_back'], x: 80, y: 220, visits: 12 },
      { id: 'result', name: '结算', enter: ['battle_settle'], x: 380, y: 220, visits: 94 },
    ],
    edges: [
      {
        id: 'e_start',
        from: 'main',
        to: 'battle',
        when: 'main_start',
        kind: 'normal',
        priority: 10,
        minScore: 0.82,
        cooldownMs: 0,
        retries: 2,
        action: 'click',
      },
      {
        id: 'e_shop',
        from: 'main',
        to: 'shop',
        when: 'main_shop',
        kind: 'normal',
        priority: 5,
        minScore: 0.82,
        cooldownMs: 0,
        retries: 1,
        action: 'click',
      },
      {
        id: 'e_back',
        from: 'shop',
        to: 'main',
        when: 'shop_back',
        kind: 'normal',
        priority: 10,
        minScore: 0.82,
        cooldownMs: 0,
        retries: 1,
        action: 'click',
      },
      {
        id: 'e_settle',
        from: 'battle',
        to: 'result',
        when: 'battle_settle',
        kind: 'normal',
        priority: 10,
        minScore: 0.82,
        cooldownMs: 0,
        retries: 3,
        action: 'click',
      },
      {
        id: 'e_result_back',
        from: 'result',
        to: 'main',
        when: 'battle_settle',
        kind: 'normal',
        priority: 5,
        minScore: 0.82,
        cooldownMs: 1500,
        retries: 1,
        action: 'click',
      },
      {
        id: 'r_popup',
        from: null,
        to: null,
        when: 'popup_close',
        kind: 'recovery',
        priority: 100,
        minScore: 0.8,
        cooldownMs: 800,
        retries: 1,
        action: 'click',
      },
    ],
    recognizers: recognizers(),
    activeNodeId: 'main',
    pendingNodeId: 'battle',
  };
}

export function mockEvents(deviceId: string): TraceEventView[] {
  const rows: Array<[TraceEventView['type'], string | null, string | null, string]> = [
    ['device_reconnected', null, null, '心跳恢复，已重连'],
    ['node_entered', 'main', null, '进入 主界面 (score=0.930)'],
    ['edge_matched', 'main', 'e_start', 'main_start → battle'],
    ['action_executed', 'main', 'e_start', 'click(0.500, 0.450)'],
    ['node_entered', 'battle', null, '进入 战斗中 (score=0.710)'],
    ['recovery_matched', 'battle', 'r_popup', '中断: popup_close'],
    ['recovery_done', 'battle', 'r_popup', '中断已解除 → 战斗中'],
    ['transition_failed', 'battle', 'e_settle', '进入 result 超时'],
    ['node_entered', 'result', null, '进入 结算 (score=0.880)'],
    ['device_lost', null, null, 'adb 连接中断'],
  ];
  const now = Math.floor(Date.now() / 1000);
  return rows.map(([type, node, edge, message], index) => ({
    seq: index + 1,
    ts: now - (rows.length - index) * 3,
    type,
    deviceId,
    node,
    edge,
    message,
  }));
}
