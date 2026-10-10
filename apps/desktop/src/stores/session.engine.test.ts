/**
 * 前端 ↔ 引擎 的真实联调测试（无 GUI）。
 *
 * 做法：把 Tauri 的两个 IPC 入口（`invoke` / `listen`）替换成"直连真实的 Python 引擎子进程"，
 * 然后跑**真实的前端 store 代码**：session store 订阅帧与事件、device/graph/event store 更新。
 *
 * 这样能验证 GUI 之外的所有链路：
 *   store → lib/rpc → (Tauri 桥的等价物) → stdio JSON-RPC → 引擎 → Mock 设备 → 反向推帧
 * 用 Mock 设备，所以 CI 里不需要真机。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { RecordDraft } from '@/types';

type NotificationHandler = (event: { payload: { method: string; params: Record<string, unknown> } }) => void;

class EngineBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners = new Set<NotificationHandler>();

  start(projectDir: string): void {
    const engineDir = path.resolve(process.cwd(), '..', '..', 'engine');
    this.child = spawn(path.join(engineDir, '.venv', 'bin', 'python'), ['-m', 'gamepilot.rpc'], {
      cwd: engineDir,
      env: { ...process.env, GAMEPILOT_LOG_LEVEL: 'WARNING', GAMEPILOT_PROJECT_DIR: projectDir },
    }) as ChildProcessWithoutNullStreams;

    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === 'number') {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!waiter) return;
        if (message.error) {
          waiter.reject(new Error(JSON.stringify(message.error)));
        } else {
          waiter.resolve(message.result);
        }
        return;
      }
      for (const listener of this.listeners) {
        listener({
          payload: {
            method: String(message.method),
            params: (message.params ?? {}) as Record<string, unknown>,
          },
        });
      }
    });
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }

  invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
    if (command === 'engine_start') {
      return Promise.resolve('started');
    }
    if (command === 'engine_stop') {
      this.stop();
      return Promise.resolve(undefined);
    }
    if (command !== 'engine_rpc') {
      return Promise.reject(new Error(`未知命令: ${command}`));
    }
    const { method, params } = (args ?? {}) as { method: string; params: Record<string, unknown> };
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  listen(_event: string, handler: NotificationHandler): Promise<() => void> {
    this.listeners.add(handler);
    return Promise.resolve(() => this.listeners.delete(handler));
  }
}

const bridge = vi.hoisted(() => ({ current: null as unknown as EngineBridge }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: Record<string, unknown>) => bridge.current.invoke(command, args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: NotificationHandler) => bridge.current.listen(event, handler),
}));

const DEVICE_ID = 'mock:mock-1';
const DEVICE_URI = 'Mock:///?width=320&height=180';

async function waitFor(condition: () => boolean, timeout = 8000, step = 50): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  throw new Error('等待条件超时');
}

describe('前端 ↔ 引擎 联调（真实子进程 + Mock 设备）', () => {
  let projectDir = '';
  let sessionStore: typeof import('@/stores/session.store').useSessionStore;
  let deviceStore: typeof import('@/stores/device.store').useDeviceStore;
  let graphStore: typeof import('@/stores/graph.store').useGraphStore;
  let eventStore: typeof import('@/stores/event.store').useEventStore;

  beforeAll(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'gamepilot-ui-'));
    const instance = new EngineBridge();
    bridge.current = instance;
    instance.start(projectDir);

    ({ useSessionStore: sessionStore } = await import('@/stores/session.store'));
    ({ useDeviceStore: deviceStore } = await import('@/stores/device.store'));
    ({ useGraphStore: graphStore } = await import('@/stores/graph.store'));
    ({ useEventStore: eventStore } = await import('@/stores/event.store'));

    await sessionStore.getState().init();
    await waitFor(() => sessionStore.getState().isReady(DEVICE_ID) === false); // 引擎已起来
    await deviceStore.getState().scan(); // UI 打开设备面板时会扫描
    await waitFor(() => deviceStore.getState().devices.some((item) => item.id === DEVICE_ID));
  });

  afterAll(() => {
    bridge.current?.stop();
  });

  it('连接设备后：设备状态、状态图、实时帧都进了 store', async () => {
    await sessionStore.getState().connect(DEVICE_ID, DEVICE_URI);

    const device = deviceStore.getState().devices.find((item) => item.id === DEVICE_ID);
    expect(device?.status).toBe('connected');
    expect(device?.resolution).toEqual([320, 180]);
    expect(sessionStore.getState().isReady(DEVICE_ID)).toBe(true);

    await waitFor(() => Boolean(sessionStore.getState().frames[DEVICE_ID]));
    const frame = sessionStore.getState().frames[DEVICE_ID];
    expect(frame?.imageUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(frame?.resolution).toEqual([320, 180]);

    // 首帧时 fps 还没算出来（引擎在第 2 帧才有 fps），等它涨起来
    await waitFor(() => (sessionStore.getState().frames[DEVICE_ID]?.fps ?? 0) > 0);
    expect(sessionStore.getState().frames[DEVICE_ID]?.fps).toBeGreaterThan(0);
  });

  it('录制模板：真裁剪落盘 + 识别器进状态图 + 后续帧带出分数', async () => {
    const draft: RecordDraft = {
      rect: [0.6, 0.3, 0.16, 0.12], // Mock 画面里的棋盘格 LOGO（有纹理 → 走模板匹配）
      label: 'logo',
      threshold: 0.8,
      score: 0,
      asEnter: true,
      asActionTarget: true,
      targetMode: 'new',
      targetNodeId: null,
      newNodeName: '主界面',
      newNodeId: 'main',
    };
    await sessionStore.getState().record(DEVICE_ID, draft);

    expect(existsSync(path.join(projectDir, 'templates', 'logo.png'))).toBe(true);
    const graph = graphStore.getState().graphs[DEVICE_ID];
    expect(graph?.recognizers.map((item) => item.label)).toContain('logo');
    expect(graph?.nodes.map((item) => item.id)).toContain('main');

    // 引擎会持续推帧：识别器面板的分数应当被真实数据刷新
    await waitFor(() => {
      const recognizer = graphStore
        .getState()
        .graphs[DEVICE_ID]?.recognizers.find((item) => item.label === 'logo');
      return Boolean(recognizer && recognizer.score > 0.8);
    });
  });

  it('运行状态机：引擎事件进入事件栏，且真的产生了点击动作', async () => {
    const saved = JSON.parse(readFileSync(path.join(projectDir, 'graph.json'), 'utf-8')) as {
      edges: unknown[];
    };
    saved.edges = [
      {
        id: 'e_tap',
        from: 'main',
        when: 'logo',
        cooldown_ms: 300,
        action: { type: 'click', target: 'logo' },
      },
    ];
    // 走前端 store 的 RPC 路径写回（等价于画布上连线后保存）
    const { graphSave } = await import('@/lib/rpc');
    await graphSave(DEVICE_ID, saved as never);

    await sessionStore.getState().startRun(DEVICE_ID);
    expect(sessionStore.getState().running[DEVICE_ID]).toBe(true);

    await waitFor(() =>
      (eventStore.getState().events[DEVICE_ID] ?? []).some((item) => item.type === 'action_executed'),
    );

    const types = (eventStore.getState().events[DEVICE_ID] ?? []).map((item) => item.type);
    expect(types).toContain('node_entered');
    expect(types).toContain('edge_matched');
    expect(types).toContain('action_executed');

    await sessionStore.getState().stopRun(DEVICE_ID);
    expect(sessionStore.getState().running[DEVICE_ID]).toBe(false);
  });

  it('断开设备后：连接态归零', async () => {
    await sessionStore.getState().disconnect(DEVICE_ID);

    const device = deviceStore.getState().devices.find((item) => item.id === DEVICE_ID);
    expect(device?.status).toBe('discovered');
    expect(sessionStore.getState().isReady(DEVICE_ID)).toBe(false);
  });
});
