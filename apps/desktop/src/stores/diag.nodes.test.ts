/**
 * 诊断（临时）：拖动 / 右键建节点之后，界面里的节点为什么会消失。
 *
 * 同时盯三处：界面 store 的节点数、引擎 `graph.get` 的节点数、磁盘上的 graph.json ——
 * 分清"界面显示丢了"和"数据真丢了"。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { graphGet, type GraphPayload } from '@/lib/rpc';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';

type NotificationHandler = (event: { payload: { method: string; params: Record<string, unknown> } }) => void;

class Bridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<NotificationHandler>();
  frameRequests = 0;

  start(projectDir: string): void {
    const engineDir = path.resolve(process.cwd(), '..', '..', 'engine');
    const child = spawn(path.join(engineDir, '.venv', 'bin', 'python'), ['-m', 'gamepilot.rpc'], {
      cwd: engineDir,
      env: { ...process.env, GAMEPILOT_LOG_LEVEL: 'WARNING', GAMEPILOT_PROJECT_DIR: projectDir },
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === 'number') {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          waiter?.reject(new Error(JSON.stringify(message.error)));
        } else {
          waiter?.resolve(message.result);
        }
        return;
      }
      if (message.method === 'engine.event') {
        for (const listener of this.listeners) {
          listener({ payload: message.params as { method: string; params: Record<string, unknown> } });
        }
      }
    });
  }

  stop(): void {
    this.child?.kill();
  }

  invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
    if (command === 'engine_frame') {
      this.frameRequests += 1;
      return Promise.resolve(new ArrayBuffer(0));
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

const bridge = vi.hoisted(() => ({ current: null as unknown as Bridge }));
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
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  throw new Error('等待条件超时');
}

describe('诊断：节点消失', () => {
  let projectDir = '';

  const ui = (): Record<string, unknown> => {
    const graph = useGraphStore.getState().graphs[DEVICE_ID];
    return {
      uiNodes: graph?.nodes.length ?? -1,
      uiIds: (graph?.nodes ?? []).map((n) => n.id).join(','),
      uiRecs: graph?.recognizers.length ?? -1,
      rawNodes: (useGraphStore.getState().raws[DEVICE_ID]?.nodes ?? []).length,
      hasGraph: Boolean(graph),
    };
  };

  const disk = (): Record<string, unknown> => {
    try {
      const payload = JSON.parse(readFileSync(path.join(projectDir, 'graph.json'), 'utf-8')) as GraphPayload;
      return {
        diskNodes: (payload.nodes ?? []).length,
        diskIds: (payload.nodes ?? []).map((n) => n.id).join(','),
      };
    } catch (error) {
      return { diskError: String(error) };
    }
  };

  const engine = async (): Promise<Record<string, unknown>> => {
    const payload = await graphGet(DEVICE_ID);
    return {
      engineNodes: (payload.nodes ?? []).length,
      engineIds: (payload.nodes ?? []).map((n) => n.id).join(','),
    };
  };

  const report = async (tag: string): Promise<void> => {
    console.log(tag, JSON.stringify({ ...ui(), ...disk(), ...(await engine()) }));
  };

  beforeAll(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'gamepilot-diag-'));
    const instance = new Bridge();
    bridge.current = instance;
    instance.start(projectDir);
    await useSessionStore.getState().init();
    await useDeviceStore.getState().scan();
    await waitFor(() => useDeviceStore.getState().devices.some((item) => item.id === DEVICE_ID), 15000);
    await useSessionStore.getState().connect(DEVICE_ID, DEVICE_URI);
    await waitFor(() => useSessionStore.getState().isReady(DEVICE_ID));
  });

  afterAll(() => {
    bridge.current?.stop();
  });

  it('拖动（moveNode）后节点是否还在', { timeout: 30000 }, async () => {
    const store = useGraphStore.getState();
    const created = await store.createNode(DEVICE_ID, '界面A');
    await report('1) 建第一个节点后:');
    expect(useGraphStore.getState().graphs[DEVICE_ID]?.nodes.length).toBeGreaterThan(0);

    const first = useGraphStore.getState().graphs[DEVICE_ID]?.nodes[0]?.id ?? '';
    store.moveNode(DEVICE_ID, created ?? first, 320, 200);
    await report('2) 拖动（moveNode）后:');

    // 等一会儿：引擎事件/帧都进来了再看
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await report('3) 等 1.5s 后:');

    const second = await useGraphStore.getState().createNode(DEVICE_ID, '界面B');
    await report('4) 建第二个节点后:');
    expect(second).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 1500));
    await report('5) 再等 1.5s 后:');

    expect(useGraphStore.getState().graphs[DEVICE_ID]?.nodes.length).toBe(2);
  });
});
