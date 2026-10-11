/**
 * 前端 ↔ 引擎 的真实联调测试（无 GUI）。
 *
 * 做法：把 Tauri 的两个 IPC 入口（`invoke` / `listen`）替换成"直连真实的 Python 引擎子进程"，
 * 再跑**真实的前端 store 代码**：session store 订阅帧与事件，device/graph/event store 跟着更新。
 *
 * 等价于在没有窗口的情况下验证 GUI 之外的全部链路：
 *   store → lib/rpc → (Tauri 桥的等价物) → stdio JSON-RPC → 引擎 → Mock 设备 → 反向推帧
 * 用 Mock 设备，所以 CI 里不需要真机。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  graphSave,
  projectCreate,
  projectDelete,
  projectList,
  projectRename,
  type GraphPayload,
} from '@/lib/rpc';
import { useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import type { RecordDraft } from '@/types';

type NotificationHandler = (event: { payload: { method: string; params: Record<string, unknown> } }) => void;

class EngineBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners = new Set<NotificationHandler>();
  /** 模拟 Rust 侧的帧缓存：engine_frame 命令从这里取原始字节 */
  private frames = new Map<string, Uint8Array>();
  frameRequests = 0;
  streamRequests = 0;

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
        if (!waiter) {
          return;
        }
        if (message.error) {
          waiter.reject(new Error(JSON.stringify(message.error)));
        } else {
          waiter.resolve(message.result);
        }
        return;
      }
      const method = String(message.method);
      const params = (message.params ?? {}) as Record<string, unknown>;
      // 和 Rust 桥一致：帧存进本地缓存，并从事件里剥掉 jpeg（前端按需拉原始字节）
      if (method === 'engine.frame') {
        const jpeg = typeof params.jpeg === 'string' ? params.jpeg : null;
        const deviceId = typeof params.deviceId === 'string' ? params.deviceId : null;
        if (jpeg && deviceId) {
          this.frames.set(deviceId, Uint8Array.from(Buffer.from(jpeg, 'base64')));
        }
        delete params.jpeg;
      }
      const payload = { method, params };
      for (const listener of this.listeners) {
        listener({ payload });
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
    if (command === 'engine_frame') {
      this.frameRequests += 1;
      const rawId = (args ?? {}).deviceId;
      const deviceId = typeof rawId === 'string' ? rawId : '';
      const bytes = this.frames.get(deviceId);
      return Promise.resolve(bytes ? bytes.slice().buffer : new ArrayBuffer(0));
    }
    if (command !== 'engine_rpc') {
      return Promise.reject(new Error(`未知命令: ${command}`));
    }
    const { method, params } = (args ?? {}) as { method: string; params: Record<string, unknown> };
    if (method === 'device.stream') {
      this.streamRequests += 1;
    }
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
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  throw new Error('等待条件超时');
}

describe('前端 ↔ 引擎 联调（真实子进程 + Mock 设备）', () => {
  let projectDir = '';

  beforeAll(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'gamepilot-ui-'));
    const instance = new EngineBridge();
    bridge.current = instance;
    instance.start(projectDir);

    await useSessionStore.getState().init();
    // 设备列表启动时是空的（界面空态引导用户去扫描），这里模拟"打开设备面板"触发扫描
    await useDeviceStore.getState().scan();
    await waitFor(() => useDeviceStore.getState().devices.some((item) => item.id === DEVICE_ID), 15000);
  });

  afterAll(() => {
    bridge.current?.stop();
  });

  it('连接设备后：设备状态、状态图、实时帧都进了 store', { timeout: 20000 }, async () => {
    await useSessionStore.getState().connect(DEVICE_ID, DEVICE_URI);

    const device = useDeviceStore.getState().devices.find((item) => item.id === DEVICE_ID);
    expect(device?.status).toBe('connected');
    expect(device?.resolution).toEqual([320, 180]);
    expect(useSessionStore.getState().isReady(DEVICE_ID)).toBe(true);

    await waitFor(() => Boolean(useSessionStore.getState().frames[DEVICE_ID]));
    // 画面走"前端按需拉取原始字节"：拿到的是 blob URL（不再是 base64 塞在事件里）
    await waitFor(
      () => (useSessionStore.getState().frames[DEVICE_ID]?.imageUrl ?? '').startsWith('blob:'),
      8000,
    );
    const frame = useSessionStore.getState().frames[DEVICE_ID];
    expect(frame?.imageUrl.startsWith('blob:')).toBe(true);
    expect(frame?.resolution).toEqual([320, 180]);
    expect((bridge.current as unknown as { frameRequests: number }).frameRequests).toBeGreaterThan(0);
    // 引擎默认不推帧：连接后前端应当主动告诉它"我要 10fps"，否则永远收不到画面
    expect((bridge.current as unknown as { streamRequests: number }).streamRequests).toBeGreaterThan(0);

    // 首帧时 fps 还没算出来（引擎从第 2 帧起才有 fps），等它涨起来
    await waitFor(() => (useSessionStore.getState().frames[DEVICE_ID]?.fps ?? 0) > 0);
    expect(useSessionStore.getState().frames[DEVICE_ID]?.fps).toBeGreaterThan(0);
  });

  it(
    '脚本库（多状态图）：create → list → rename → delete 全部落到真实磁盘目录',
    { timeout: 20000 },
    async () => {
      // 用一个**独立**的库根：系统临时目录里可能还躺着别的残留脚本，
      // 混在一起会让"删掉当前脚本之后切到谁"变得不可预测
      const libraryRoot = mkdtempSync(path.join(tmpdir(), 'gamepilot-lib-'));

      // 新建：会在库根下建目录（graph.json + templates/），并切过去
      const created = await projectCreate('日常任务', libraryRoot);
      const createdItem = created.items.find((item) => item.name === '日常任务');
      expect(createdItem?.root).toBe(path.join(libraryRoot, '日常任务'));
      expect(created.current).toBe(createdItem?.root);
      expect(existsSync(path.join(libraryRoot, '日常任务', 'graph.json'))).toBe(true);
      expect(existsSync(path.join(libraryRoot, '日常任务', 'templates'))).toBe(true);

      // 列表：库里就这一个脚本（库根是独立的）
      const listed = await projectList(libraryRoot);
      expect(listed.items.map((item) => item.name)).toEqual(['日常任务']);

      // 重命名：目录真的改名了，且当前脚本跟着走
      const renamed = await projectRename(createdItem!.root, '日常任务2');
      const renamedItem = renamed.items.find((item) => item.name === '日常任务2');
      expect(renamedItem?.root).toBe(path.join(libraryRoot, '日常任务2'));
      expect(renamed.current).toBe(renamedItem?.root);
      expect(existsSync(createdItem!.root)).toBe(false);

      // 删除 = 移到 .trash/（可恢复），不是真删
      const deleted = await projectDelete(renamedItem!.root);
      expect(deleted.items.map((item) => item.name)).not.toContain('日常任务2');
      expect(existsSync(renamedItem!.root)).toBe(false);
      const trash = path.join(libraryRoot, '.trash');
      expect(existsSync(trash)).toBe(true);
      expect(readdirSync(trash).some((name) => name.startsWith('日常任务2-'))).toBe(true);

      // 库操作会把"当前脚本"切走，后面的用例要用回本用例自己的目录。
      // 切回来之后要**等通知落地**：project.changed 是异步推来的，不等就可能被上一条覆盖
      await useSessionStore.getState().switchProject(projectDir);
      await waitFor(() => useSessionStore.getState().project?.root === projectDir);
      expect(useSessionStore.getState().project?.root).toBe(projectDir);
    },
  );

  it('非法脚本名：引擎拒绝并给出可直接显示的中文原因', { timeout: 20000 }, async () => {
    await expect(projectCreate('日常/任务', projectDir)).rejects.toThrow(/不能包含/);
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
    // 录制写的是"当前脚本目录"，先确认它真的回到了本用例的目录（上一条库用例会切走）
    expect(useSessionStore.getState().project?.root).toBe(projectDir);
    await useSessionStore.getState().record(DEVICE_ID, draft);

    expect(existsSync(path.join(projectDir, 'templates', 'logo.png'))).toBe(true);
    const graph = useGraphStore.getState().graphs[DEVICE_ID];
    expect(graph?.recognizers.map((item) => item.label)).toContain('logo');
    expect(graph?.nodes.map((item) => item.id)).toContain('main');

    // 引擎持续推帧：识别器面板的分数应当被真实数据刷新
    await waitFor(() => {
      const recognizer = useGraphStore
        .getState()
        .graphs[DEVICE_ID]?.recognizers.find((item) => item.label === 'logo');
      return Boolean(recognizer && recognizer.score > 0.8);
    });
  });

  it('运行状态机：引擎事件进入事件栏，且真的产生了点击动作', async () => {
    const saved = JSON.parse(readFileSync(path.join(projectDir, 'graph.json'), 'utf-8')) as GraphPayload;
    const withEdge: GraphPayload = {
      ...saved,
      edges: [
        {
          id: 'e_tap',
          from: 'main',
          when: 'logo',
          cooldown_ms: 300,
          action: { type: 'click', target: 'logo' },
        },
      ],
    };
    // 走前端的 RPC 路径写回（等价于画布上连线后保存）
    await graphSave(DEVICE_ID, withEdge);

    await useSessionStore.getState().startRun(DEVICE_ID);
    expect(useSessionStore.getState().running[DEVICE_ID]).toBe(true);

    await waitFor(() =>
      (useEventStore.getState().events[DEVICE_ID] ?? []).some((item) => item.type === 'action_executed'),
    );

    const types = (useEventStore.getState().events[DEVICE_ID] ?? []).map((item) => item.type);
    expect(types).toContain('node_entered');
    expect(types).toContain('edge_matched');
    expect(types).toContain('action_executed');

    await useSessionStore.getState().stopRun(DEVICE_ID);
    expect(useSessionStore.getState().running[DEVICE_ID]).toBe(false);
  });

  it('断开设备后：连接态归零', async () => {
    await useSessionStore.getState().disconnect(DEVICE_ID);

    const device = useDeviceStore.getState().devices.find((item) => item.id === DEVICE_ID);
    expect(device?.status).toBe('discovered');
    expect(useSessionStore.getState().isReady(DEVICE_ID)).toBe(false);
  });
});
