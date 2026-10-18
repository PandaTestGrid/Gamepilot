/**
 * 工作区（v4：**工作区 › 工作流**）端到端：真实引擎子进程 + 真实临时目录，把契约 §4.4 走完。
 *
 * 为什么放在前端仓库里：这一串是"前端调用的 RPC + 磁盘结果"的联合验收 ——
 * `workspace.add` 的名字与幂等、空文件夹不被塞东西、删除是真删、重启后记得列表与当前工作流，
 * 任何一处对不上，界面在真机上就是坏的。所以它跑真引擎、不 mock。
 *
 * 隔离：每个用例自己起一个引擎进程，`GAMEPILOT_CONFIG_DIR` 一律指向临时目录
 * （绝不读写用户真实的 `~/Library/Application Support/gamepilot/config.json`）。
 *
 * 引擎侧正在并行从 v3（项目层）改名到 v4（工作流层）：下面 `beforeAll` 会先探测方法表，
 * 没有 `workflow.*` 就**跳过并吵一声**（console.warn）—— 不许静默跳过，也不许假称验证过。
 */
import { existsSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { EngineProcess, type EngineOptions } from '@/test/engine-process';

interface WorkspaceItem {
  name: string;
  root: string;
  active: boolean;
  exists: boolean;
}

interface WorkspaceList {
  active: string | null;
  recommended: string;
  items: WorkspaceItem[];
}

interface Workflow {
  name: string;
  root: string;
  nodes: number;
  edges: number;
  recognizers: number;
  templates: number;
  modified: number;
}

interface WorkspaceTree {
  root: string;
  workflows: Workflow[];
}

interface WorkflowLibrary {
  created?: string;
  root?: string;
  removed?: string;
  current: string;
  items: Workflow[];
}

interface ProjectInfo {
  root: string;
  graphPath: string;
  nodes: number;
  edges: number;
}

const running: EngineProcess[] = [];
/** v4 的方法表在不在（引擎侧并行改名中；不在就跳过，但绝不静默） */
let engineV4 = false;

/**
 * 临时目录一律返回 **realpath**。
 *
 * 引擎的 `workspace.normalize_dir()` 按契约返回"解析过符号链接的绝对路径"
 * （macOS 上 `/var` → `/private/var`），所以期望值也必须 realpath，否则比的是两条等价路径。
 */
function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

function start(options: EngineOptions): EngineProcess {
  const engine = new EngineProcess(options);
  running.push(engine);
  return engine;
}

afterEach(() => {
  for (const engine of running.splice(0)) {
    engine.stop();
  }
});

beforeAll(async () => {
  // 探一次真实引擎的方法表：v4 需要 workflow.*（工作流层）
  const probe = start({ configDir: tempDir('gp-probe-') });
  const info = await probe.call<{ methods: string[] }>('engine.info');
  engineV4 = info.methods.includes('workflow.create') && info.methods.includes('workflow.delete');
  if (!engineV4) {
    console.warn(
      '[workspace.engine.test] 引擎还没有 v4 的 workflow.* 方法（当前方法表：' +
        `${info.methods.filter((m) => m.startsWith('workflow.') || m.startsWith('script.')).join(', ') || '无'}` +
        '）—— 工作区 v4 端到端用例被跳过；引擎落地后重跑即可，不用改测试。',
    );
  }
  expect(info.methods).toContain('workspace.tree');
});

describe('工作区 v4 端到端（真实引擎 + 临时目录）', () => {
  it('空配置：workspace.list 的 active 为 null、items 为空', async ({ skip }) => {
    if (!engineV4) {
      skip();
      return;
    }
    const configDir = tempDir('gp-cfg-empty-');
    const engine = start({ configDir });

    const list = await engine.call<WorkspaceList>('workspace.list');
    expect(list.active).toBeNull();
    expect(list.items.filter((item) => item.active)).toEqual([]);
    expect(list.recommended.endsWith(path.join('workspaces', '默认'))).toBe(true);
  });

  it('workspace.add 空目录 + 名字：磁盘上**一个文件都没有**，列表里是用户输的名字', async ({ skip }) => {
    if (!engineV4) {
      skip();
      return;
    }
    const configDir = tempDir('gp-cfg-add-');
    const workspaceDir = tempDir('gp-ws-');
    const engine = start({ configDir });

    const added = await engine.call<{
      root: string;
      name: string;
      current: string;
      tree: WorkspaceTree;
      items: WorkspaceItem[];
    }>('workspace.add', { dir: workspaceDir, name: '我的工作区' });

    expect(added.root).toBe(workspaceDir);
    expect(added.name).toBe('我的工作区');
    // v4：空文件夹保持空着（连默认目录都不建）
    expect(readdirSync(workspaceDir)).toEqual([]);
    expect(added.tree.workflows).toEqual([]);
    expect(added.current).toBe('');

    const list = await engine.call<WorkspaceList>('workspace.list');
    expect(list.active).toBe(workspaceDir);
    expect(list.items.map((item) => item.name)).toEqual(['我的工作区']);

    // 没有当前工作流 → project.get 的 root 是空串（一等状态，不许伪造路径）
    const info = await engine.call<ProjectInfo>('project.get');
    expect(info.root).toBe('');
  });

  it('同一个目录再加一次 = 幂等，而且名字更新成这次传的', async ({ skip }) => {
    if (!engineV4) {
      skip();
      return;
    }
    const configDir = tempDir('gp-cfg-idem-');
    const workspaceDir = tempDir('gp-ws-idem-');
    const engine = start({ configDir });
    await engine.call('workspace.add', { dir: workspaceDir, name: '旧名字' });

    const again = await engine.call<{ name: string; items: WorkspaceItem[] }>('workspace.add', {
      dir: workspaceDir,
      name: '新名字',
    });

    expect(again.name).toBe('新名字');
    expect(again.items).toHaveLength(1);
    expect(again.items[0]?.name).toBe('新名字');
    expect(again.items[0]?.active).toBe(true);
    expect(readdirSync(workspaceDir)).toEqual([]);
  });

  it('相对路径被拦下：workspace.add 只接受绝对路径或 ~', async ({ skip }) => {
    if (!engineV4) {
      skip();
      return;
    }
    const engine = start({ configDir: tempDir('gp-cfg-rel-') });

    await expect(engine.call('workspace.add', { dir: './relative', name: 'x' })).rejects.toThrow(/绝对路径/);
  });

  it('工作流全流程：建两个 → 切换 → 改名 → 复制 → 删（真删除）；删光后没有当前工作流', async ({ skip }) => {
    if (!engineV4) {
      skip();
      return;
    }
    const configDir = tempDir('gp-cfg-flow-');
    const workspaceDir = tempDir('gp-ws-flow-');
    const engine = start({ configDir });
    await engine.call('workspace.add', { dir: workspaceDir, name: '我的工作区' });

    // workflow.create 名字必填，建完切过去
    const first = await engine.call<WorkflowLibrary>('workflow.create', { name: '斗技' });
    const firstRoot = path.join(workspaceDir, '斗技');
    expect(first.created).toBe(firstRoot);
    expect(first.current).toBe(firstRoot);
    expect(existsSync(path.join(firstRoot, 'graph.json'))).toBe(true);
    expect(existsSync(path.join(firstRoot, 'templates'))).toBe(true);

    const second = await engine.call<WorkflowLibrary>('workflow.create', { name: '御魂' });
    expect(second.current).toBe(path.join(workspaceDir, '御魂'));
    expect(second.items.map((item) => item.name)).toHaveLength(2);
    expect(existsSync(path.join(workspaceDir, 'graph.json'))).toBe(false); // 工作流只在子目录里

    // 切换（project.set 语义不变）
    await engine.call('project.set', { dir: firstRoot });
    expect((await engine.call<ProjectInfo>('project.get')).root).toBe(firstRoot);

    // 改名：目录真的改名，current 跟着走，返回的 root 是新路径
    const renamed = await engine.call<WorkflowLibrary>('workflow.rename', {
      dir: firstRoot,
      name: '斗技2',
    });
    const renamedRoot = path.join(workspaceDir, '斗技2');
    expect(renamed.root).toBe(renamedRoot);
    expect(renamed.current).toBe(renamedRoot);
    expect(existsSync(renamedRoot)).toBe(true);
    expect(existsSync(firstRoot)).toBe(false);

    // 复制：新目录 + 切过去
    const copy = await engine.call<WorkflowLibrary>('workflow.duplicate', {
      dir: renamedRoot,
      name: '斗技2-副本',
    });
    const copyRoot = path.join(workspaceDir, '斗技2-副本');
    expect(copy.created).toBe(copyRoot);
    expect(copy.current).toBe(copyRoot);
    expect(existsSync(path.join(copyRoot, 'graph.json'))).toBe(true);

    // 树：工作流摘要带 modified（面板的相对时间靠它）
    const tree = await engine.call<WorkspaceTree>('workspace.tree');
    expect(tree.root).toBe(workspaceDir);
    expect(tree.workflows.map((item) => item.name)).toEqual(
      expect.arrayContaining(['斗技2', '御魂', '斗技2-副本']),
    );
    expect(tree.workflows[0]?.modified).toBeGreaterThan(0);

    // 删工作流 → **真删除**（没有回收站了）
    const removed = await engine.call<WorkflowLibrary>('workflow.delete', { dir: copyRoot });
    expect(removed.items.map((item) => item.name)).not.toContain('斗技2-副本');
    expect(existsSync(copyRoot)).toBe(false);
    expect(existsSync(removed.removed ?? '')).toBe(false);
    expect(existsSync(path.join(workspaceDir, '.trash'))).toBe(false);
    expect(removed.items.map((item) => item.root)).toContain(removed.current);

    // 删光：没有当前工作流也不崩（root 空串）
    await engine.call('workflow.delete', { dir: path.join(workspaceDir, '斗技2') });
    await engine.call('workflow.delete', { dir: path.join(workspaceDir, '御魂') });
    const empty = await engine.call<ProjectInfo>('project.get');
    expect(empty.root).toBe('');
    expect((await engine.call<WorkspaceTree>('workspace.tree')).workflows).toEqual([]);
  });

  it('workspace.remove deleteFiles:true → 目录**真删除**；false → 磁盘一个字节不动', async ({ skip }) => {
    if (!engineV4) {
      skip();
      return;
    }
    const configDir = tempDir('gp-cfg-rm-');
    const keepDir = tempDir('gp-ws-keep-');
    const dropDir = tempDir('gp-ws-drop-');
    const engine = start({ configDir });
    await engine.call('workspace.add', { dir: keepDir, name: '保留' });
    await engine.call('workspace.add', { dir: dropDir, name: '移走' });

    // 只从列表移除：磁盘一个字节不动
    const unlisted = await engine.call<{ items: WorkspaceItem[]; removed: string }>('workspace.remove', {
      dir: keepDir,
      deleteFiles: false,
    });
    expect(existsSync(keepDir)).toBe(true);
    expect(readdirSync(keepDir)).toEqual([]);
    expect(unlisted.removed).toBe('');
    expect(unlisted.items.map((item) => item.root)).not.toContain(keepDir);

    // 连文件一起删 = **真删除**（没有回收站兜底，界面负责二次确认）
    const removed = await engine.call<WorkspaceList & { removed: string; current: string }>(
      'workspace.remove',
      { dir: dropDir, deleteFiles: true },
    );
    expect(existsSync(dropDir)).toBe(false);
    expect(existsSync(path.join(configDir, '.trash'))).toBe(false);
    expect(existsSync(removed.removed)).toBe(false);
    // 列表空了 → active 归 null
    expect(removed.items).toEqual([]);
    expect(removed.active).toBeNull();
    expect((await engine.call<WorkspaceList>('workspace.list')).active).toBeNull();
  });

  it('重启引擎进程后：列表、名字、active、当前工作流都还记得', async ({ skip }) => {
    if (!engineV4) {
      skip();
      return;
    }
    const configDir = tempDir('gp-cfg-restart-');
    const firstDir = tempDir('gp-ws-r1-');
    const secondDir = tempDir('gp-ws-r2-');
    const first = start({ configDir });
    await first.call('workspace.add', { dir: firstDir, name: '第一个' });
    await first.call('workspace.add', { dir: secondDir, name: '第二个' });
    const created = await first.call<WorkflowLibrary>('workflow.create', { name: '斗技' });
    expect(created.current).toBe(path.join(secondDir, '斗技'));
    first.stop();

    const restarted = start({ configDir });
    const list = await restarted.call<WorkspaceList>('workspace.list');
    expect(list.active).toBe(secondDir);
    // 顺序 = 登记顺序（**不按最近使用重排**：用户明确要求别把文件挪到最上面）；名字是用户输的
    expect(list.items.map((item) => item.name)).toEqual(['第一个', '第二个']);
    expect(list.items.every((item) => item.active === (item.root === secondDir))).toBe(true);
    // 当前工作流也记得
    const info = await restarted.call<ProjectInfo>('project.get');
    expect(info.root).toBe(path.join(secondDir, '斗技'));
  });

  it('GAMEPILOT_WORKSPACE_DIR 仍然能覆盖配置（旧逃生口不变，测试/开发用）', async ({ skip }) => {
    if (!engineV4) {
      skip();
      return;
    }
    const configDir = tempDir('gp-cfg-env-');
    const forcedDir = tempDir('gp-ws-forced-');
    const engine = start({ configDir, workspaceDir: forcedDir });

    const list = await engine.call<WorkspaceList>('workspace.list');
    expect(list.active).toBe(forcedDir);
    expect((await engine.call<WorkspaceTree>('workspace.tree')).root).toBe(forcedDir);
    // 逃生口模式不写配置：另一个进程（没有这个环境变量）看不到它
    const other = await start({ configDir }).call<WorkspaceList>('workspace.list');
    expect(other.active).not.toBe(forcedDir);
  });
});
