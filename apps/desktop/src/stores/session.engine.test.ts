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
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  graphSave,
  projectSet,
  workflowCreate,
  workflowDelete,
  workflowDuplicate,
  workflowRename,
  workspaceTree,
  type GraphPayload,
} from '@/lib/rpc';
import { enginePython } from '@/test/engine-process';
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

  /**
   * 起一个真实引擎进程。
   *
   * 三个环境变量都钉在**临时目录**里（契约 v3 §1 的逃生口）：
   *   - `GAMEPILOT_PROJECT_DIR` → 当前脚本（录制/运行都落在这里）
   *   - `GAMEPILOT_WORKSPACE_DIR` → 当前工作区（project.* / script.* 都在这下面）
   *   - `GAMEPILOT_CONFIG_DIR` → 配置目录（**绝不能读/写用户真实的 config.json**）
   */
  start(projectDir: string, workspaceDir: string, configDir: string): void {
    const engineDir = path.resolve(process.cwd(), '..', '..', 'engine');
    const child = spawn(enginePython(engineDir), ['-m', 'gamepilot.rpc'], {
      cwd: engineDir,
      env: {
        ...process.env,
        GAMEPILOT_LOG_LEVEL: 'WARNING',
        GAMEPILOT_PROJECT_DIR: projectDir,
        GAMEPILOT_WORKSPACE_DIR: workspaceDir,
        GAMEPILOT_CONFIG_DIR: configDir,
        GAMEPILOT_TEST_SYNTHETIC: '1',
      },
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

const DEVICE_ID = 'synthetic:test-1';
const DEVICE_URI = 'Synthetic:///?serial=test-1&width=320&height=180';

async function waitFor(condition: () => boolean, timeout = 15000, step = 50): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  throw new Error('等待条件超时');
}

describe('前端 ↔ 引擎 联调（真实子进程 + Synthetic 测试设备）', () => {
  let projectDir = '';
  /** v4：当前工作区也是一个临时目录（工作流那一段直接建在它下面） */
  let workspaceDir = '';
  /** 引擎侧并行改名中：方法表里有没有 v4 的 workflow.*（没有就跳过那一条，但会吵一声） */
  let engineV4 = false;

  beforeAll(async () => {
    // realpath：引擎按契约返回解析过符号链接的路径（macOS /var → /private/var），
    // 期望值也要用同一条路径，否则比的是两个等价写法
    projectDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'gamepilot-ui-')));
    workspaceDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'gamepilot-ws-')));
    const configDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'gamepilot-cfg-')));
    const instance = new EngineBridge();
    bridge.current = instance;
    instance.start(projectDir, workspaceDir, configDir);

    // v4 的方法表探一次：引擎还没落地 workflow.* 时，只跳过工作流那一条用例
    const info = (await bridge.current.invoke('engine_rpc', {
      method: 'engine.info',
      params: {},
    })) as { methods?: string[] };
    engineV4 = info?.methods?.includes('workflow.create') === true;
    if (!engineV4) {
      console.warn(
        '[session.engine.test] 引擎还没有 v4 的 workflow.* 方法 —— 工作流联调用例被跳过（引擎落地后重跑即可）',
      );
    }

    await useSessionStore.getState().init();
    // 设备列表启动时是空的（界面空态引导用户去扫描），这里模拟"打开设备面板"触发扫描
    await useDeviceStore.getState().scan();
    // Mock 不再出现在扫描结果里（界面不展示合成设备）；下面直接用 URI 连它，
    // `markConnectedWith` 会把设备补进列表。
    expect(useDeviceStore.getState().devices.some((item) => item.id === DEVICE_ID)).toBe(false);
  }, 60000);

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

  // 「界面重载后扫描结果报 connected」原先靠 Mock 出现在扫描列表里来联调；
  // Mock 移出扫描后，这条逻辑改由引擎单测 `test_device_list_reports_live_sessions_as_connected` 覆盖。

  it(
    '工作流（工作区 › 工作流）：建/切换/改名/复制/删除 全部落到真实磁盘（v4 只有两层）',
    { timeout: 30000 },
    async ({ skip }) => {
      if (!engineV4) {
        skip();
        return;
      }
      /*
       * 这一条走的是**新契约**（docs/WORKSPACE-CONTRACT.md v4 §2）：
       *   工作区 = 用户选的文件夹；工作流 = 它下面一个含 graph.json 的直接子目录。
       * 「项目」那一层已经取消，工作流建在**当前工作区根**下。
       * 当前工作区就是本用例的临时目录（GAMEPILOT_WORKSPACE_DIR）。
       */
      const workspace = await workspaceTree();
      expect(workspace.root).toBe(workspaceDir);
      expect(workspace.workflows).toEqual([]);

      // 建两个工作流：建完切过去
      const first = await workflowCreate('斗技');
      const firstRoot = path.join(workspaceDir, '斗技');
      expect(first.created).toBe(firstRoot);
      expect(first.current).toBe(firstRoot);
      expect(existsSync(path.join(firstRoot, 'graph.json'))).toBe(true);
      expect(existsSync(path.join(firstRoot, 'templates'))).toBe(true);

      const second = await workflowCreate('御魂');
      const secondRoot = path.join(workspaceDir, '御魂');
      expect(second.current).toBe(secondRoot);
      expect(second.items.map((item) => item.name)).toEqual(expect.arrayContaining(['斗技', '御魂']));
      expect(second.items).toHaveLength(2);

      // 重命名**当前**工作流：目录真的改名，current 跟着走，返回的 root 是新路径
      const renamed = await workflowRename(secondRoot, '御魂2');
      const renamedRoot = path.join(workspaceDir, '御魂2');
      expect(renamed.root).toBe(renamedRoot);
      expect(renamed.current).toBe(renamedRoot);
      expect(existsSync(renamedRoot)).toBe(true);
      expect(existsSync(secondRoot)).toBe(false);

      // 树：工作流摘要带 modified（面板的相对时间、前端树都读它）
      const tree = await workspaceTree();
      expect(tree.workflows.map((item) => item.name)).toEqual(expect.arrayContaining(['斗技', '御魂2']));
      expect(tree.workflows[0]?.modified).toBeGreaterThan(0);

      // 复制另一个工作流：新目录（含 graph.json）并切过去
      const copy = await workflowDuplicate(firstRoot, '斗技-副本');
      const copyRoot = path.join(workspaceDir, '斗技-副本');
      expect(copy.current).toBe(copyRoot);
      expect(existsSync(path.join(copyRoot, 'graph.json'))).toBe(true);

      // 删除工作流 = **真删除**（连目录一起，没有回收站）；删的是当前工作流 → 切到剩下的一个
      const removed = await workflowDelete(copyRoot);
      expect(removed.items.map((item) => item.name)).not.toContain('斗技-副本');
      expect(existsSync(copyRoot)).toBe(false);
      expect(existsSync(removed.removed)).toBe(false);
      expect(existsSync(path.join(workspaceDir, '.trash'))).toBe(false);
      expect(removed.items.map((item) => item.root)).toContain(removed.current);
      expect(existsSync(removed.current)).toBe(true);

      // 删光所有工作流：没有当前工作流是一等状态（root 空串，不崩）
      await workflowDelete(renamedRoot);
      await workflowDelete(firstRoot);
      await useSessionStore.getState().refreshCurrentWorkflow();
      expect(useSessionStore.getState().currentWorkflow?.root ?? '').toBe('');
      expect((await workspaceTree()).workflows).toEqual([]);

      // 工作流操作会把"当前工作流"切走，后面的用例要用回本用例自己的目录。
      // v4 是两层：`projectDir` 是**脚本目录**（逃生口 pin 的那个），不在工作区列表里，
      // 所以不能走 switchWorkflow（它先查工作区列表、查不到就关标签）；
      // 直接 project.set 回到它（create 默认 true，会补齐 graph.json 供后面的录制用例用）。
      await projectSet(projectDir, true);
      await useSessionStore.getState().refreshCurrentWorkflow();
      await waitFor(() => useSessionStore.getState().currentWorkflow?.root === projectDir);
      expect(useSessionStore.getState().currentWorkflow?.root).toBe(projectDir);
    },
  );

  it('非法工作流名：引擎拒绝并给出可直接显示的中文原因', { timeout: 20000 }, async ({ skip }) => {
    if (!engineV4) {
      skip();
      return;
    }
    await expect(workflowCreate('日常/任务')).rejects.toThrow(/不能包含/);
  });

  it('录制模板：真裁剪落盘 + 识别器注册 + 步骤链不建状态图节点', { timeout: 30000 }, async () => {
    const draft: RecordDraft = {
      rect: [0.6, 0.3, 0.16, 0.12], // Mock 画面里的棋盘格 LOGO（有纹理 → 走模板匹配）
      label: 'logo',
      threshold: 0.8,
      score: 0,
      asEnter: true,
      asActionTarget: true,
      search: 'region',
      targetMode: 'new',
      targetNodeId: null,
      newNodeName: '主界面',
      // 只是界面侧的占位：真实 id 由**引擎分配**（界面这个序号重启就重号，
      // 传下去会撞上老界面 —— 见 session.store.record 的 allocateNodeId）
      newNodeId: 'node_1',
    };
    await useSessionStore.getState().switchWorkflow(projectDir);
    await waitFor(() => useSessionStore.getState().currentWorkflow?.root === projectDir);
    await graphSave({
      version: 1,
      defaults: {},
      nodes: [],
      edges: [],
      recognizers: {},
      flow: { steps: [{ id: 'trigger', type: 'manual', params: {} }] },
    });
    await useGraphStore.getState().refresh(DEVICE_ID);
    await useSessionStore.getState().record(DEVICE_ID, draft);

    expect(existsSync(path.join(projectDir, 'templates', 'logo.png'))).toBe(true);
    const graph = useGraphStore.getState().graphs[DEVICE_ID];
    expect(graph?.recognizers.map((item) => item.label)).toContain('logo');
    expect(graph?.nodes ?? []).toEqual([]);
    expect(graph?.flow?.steps?.length).toBeGreaterThan(0);

    // 引擎持续推帧：识别器面板的分数应当被真实数据刷新
    await waitFor(() => {
      const recognizer = useGraphStore
        .getState()
        .graphs[DEVICE_ID]?.recognizers.find((item) => item.label === 'logo');
      return Boolean(recognizer && recognizer.score > 0.8);
    });
  });

  it('运行步骤链：引擎事件进入事件栏，且真的产生了点击动作', { timeout: 30000 }, async () => {
    const saved = JSON.parse(readFileSync(path.join(projectDir, 'graph.json'), 'utf-8')) as GraphPayload;
    const withClick: GraphPayload = {
      ...saved,
      nodes: [],
      edges: [],
      flow: {
        steps: [
          { id: 'trigger', type: 'manual', params: {} },
          { id: 's_click', type: 'click', params: { by: 'recognizer', rec: 'logo' } },
        ],
      },
    };
    await graphSave(withClick, DEVICE_ID);
    await useGraphStore.getState().refresh(DEVICE_ID);

    await useSessionStore.getState().startRun(DEVICE_ID);
    expect(useSessionStore.getState().running[DEVICE_ID]).toBe(true);

    await waitFor(() =>
      (useEventStore.getState().events[DEVICE_ID] ?? []).some((item) => item.type === 'action_executed'),
    );

    const types = (useEventStore.getState().events[DEVICE_ID] ?? []).map((item) => item.type);
    expect(types).toContain('step_started');
    expect(types).toContain('action_executed');

    await useSessionStore.getState().stopRun(DEVICE_ID);
    expect(useSessionStore.getState().running[DEVICE_ID]).toBe(false);
  });

  it('识别器改名：引用被级联改掉（磁盘 + 界面图 + 引擎热重载后继续出分）', { timeout: 20000 }, async () => {
    const graphPath = path.join(projectDir, 'graph.json');
    const before = JSON.parse(readFileSync(graphPath, 'utf-8')) as GraphPayload;
    expect(Object.keys(before.recognizers)).toContain('logo');
    expect(before.flow?.steps?.some((step) => (step.params as { rec?: string })?.rec === 'logo')).toBe(true);

    const result = await useSessionStore.getState().renameRecognizer(DEVICE_ID, 'logo', '游戏标题');

    expect(result).not.toBeNull();
    expect((result?.refs as { flowSteps?: number }).flowSteps ?? 0).toBeGreaterThanOrEqual(1);

    // 界面里的图：新名字在、旧名字没了（改名不能留下两个）
    const labels = useGraphStore.getState().graphs[DEVICE_ID]?.recognizers.map((item) => item.label) ?? [];
    expect(labels).toContain('游戏标题');
    expect(labels).not.toContain('logo');

    const saved = JSON.parse(readFileSync(graphPath, 'utf-8')) as GraphPayload;
    expect(Object.keys(saved.recognizers)).toContain('游戏标题');
    expect(Object.keys(saved.recognizers)).not.toContain('logo');
    const clickStep = saved.flow?.steps?.find((step) => step.id === 's_click');
    expect((clickStep?.params as { rec?: string })?.rec).toBe('游戏标题');

    // 模板文件不跟着改名（spec 里存的是相对路径，文件叫什么对匹配没影响）
    expect(existsSync(path.join(projectDir, 'templates', 'logo.png'))).toBe(true);

    // 引擎热重载：新标签继续按真实帧出分（不然画面上会一直显示旧名字 0.00）
    await waitFor(() => {
      const item = useGraphStore
        .getState()
        .graphs[DEVICE_ID]?.recognizers.find((recognizer) => recognizer.label === '游戏标题');
      return Boolean(item && item.score > 0.8);
    });

    // 事件栏留一条痕（用户能回看"什么时候改的名"）
    const types = (useEventStore.getState().events[DEVICE_ID] ?? []).map((item) => item.type);
    expect(types).toContain('recognizer_renamed');
  });

  it('删除识别器：被引用时拒绝并说清被谁用了；没人用才真删（连模板文件）', { timeout: 20000 }, async () => {
    const graphPath = path.join(projectDir, 'graph.json');
    // 上一条用例改成"游戏标题"了，步骤链里的 click 仍引用它
    const before = JSON.parse(readFileSync(graphPath, 'utf-8')) as GraphPayload;
    expect(Object.keys(before.recognizers)).toContain('游戏标题');

    // 被引用 → 拒绝：原因里要能看出"被谁用了"（界面把它显示在错误条 + 事件栏）
    const refused = await useSessionStore.getState().removeRecognizer(DEVICE_ID, '游戏标题');
    expect(refused).toBe(false);
    expect(useSessionStore.getState().error).toMatch(/还在被使用/);
    const stillThere = JSON.parse(readFileSync(graphPath, 'utf-8')) as GraphPayload;
    expect(Object.keys(stillThere.recognizers)).toContain('游戏标题');

    // 再录两个**没人引用**的识别器（不建节点/边），它们就该删得掉
    const draft = (label: string, rect: readonly [number, number, number, number]): RecordDraft => ({
      rect,
      label,
      threshold: 0.8,
      score: 0,
      asEnter: false,
      asActionTarget: false,
      search: 'region',
      targetMode: 'new',
      targetNodeId: null,
      newNodeName: '临时',
      newNodeId: 'tmp',
    });
    // 纯色区域 → 引擎自动降级成颜色识别器，但录制照样留下素材（templates/ 是"录过什么"的台账）；
    // 删除时必须连它一起清掉（否则用户会看到 templates/ 里还留着，像没删干净）
    await useSessionStore.getState().record(DEVICE_ID, draft('lonely_color', [0.1, 0.1, 0.12, 0.1]));
    expect(existsSync(path.join(projectDir, 'templates', 'lonely_color.png'))).toBe(true);
    // 有纹理的区域 → 模板识别器：文件真的落盘，删除时必须跟着走
    await useSessionStore.getState().record(DEVICE_ID, draft('lonely_tpl', [0.6, 0.3, 0.16, 0.12]));
    expect(existsSync(path.join(projectDir, 'templates', 'lonely_tpl.png'))).toBe(true);

    expect(await useSessionStore.getState().removeRecognizer(DEVICE_ID, 'lonely_color')).toBe(true);
    expect(await useSessionStore.getState().removeRecognizer(DEVICE_ID, 'lonely_tpl')).toBe(true);

    // 图 + 磁盘 + 模板文件三处都干净了
    const labels = useGraphStore.getState().graphs[DEVICE_ID]?.recognizers.map((item) => item.label) ?? [];
    expect(labels).not.toContain('lonely_color');
    expect(labels).not.toContain('lonely_tpl');
    const saved = JSON.parse(readFileSync(graphPath, 'utf-8')) as GraphPayload;
    expect(Object.keys(saved.recognizers)).not.toContain('lonely_color');
    expect(Object.keys(saved.recognizers)).not.toContain('lonely_tpl');
    // 两个识别器的素材文件都被清掉了（颜色识别器那个尤其容易漏 —— 它的 spec 里没有 template）
    expect(existsSync(path.join(projectDir, 'templates', 'lonely_color.png'))).toBe(false);
    expect(existsSync(path.join(projectDir, 'templates', 'lonely_tpl.png'))).toBe(false);

    const types = (useEventStore.getState().events[DEVICE_ID] ?? []).map((item) => item.type);
    expect(types).toContain('recognizer_removed');
  });

  it('断开设备后：连接态归零', { timeout: 20000 }, async () => {
    await useSessionStore.getState().disconnect(DEVICE_ID);

    const device = useDeviceStore.getState().devices.find((item) => item.id === DEVICE_ID);
    expect(device?.status).toBe('discovered');
    expect(useSessionStore.getState().isReady(DEVICE_ID)).toBe(false);
  });
});
