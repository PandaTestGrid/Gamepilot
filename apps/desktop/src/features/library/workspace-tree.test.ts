/**
 * 工作区树的收窄与选择（纯函数）—— v4 只有两层：**工作区 › 工作流**。
 *
 * 这层存在的唯一理由：引擎返回的东西是**外部数据**（测试里 mock 的 invoke 就回 `{}`，
 * 引擎也可能少字段）。界面不能崩在一句 `.length` 上，也不能显示 `undefined/undefined`，
 * 所以这里把"脏数据 → 干净数据"的规则全部钉死。
 */
import { describe, expect, it } from 'vitest';

import {
  baseName,
  hasAnyWorkflow,
  isAbsolutePath,
  matchesQuery,
  parentDir,
  relativeTime,
  searchWorkflows,
  searchWorkspaces,
  toModified,
  toMutationTree,
  toTree,
  toWorkflow,
  toWorkflowItems,
  toWorkspace,
  toWorkspaceList,
  toWorkspaces,
} from '@/features/library/workspace-tree';

const ROOT = '/Users/me/game-bot';
const TREE = {
  root: ROOT,
  workflows: [
    {
      name: '斗技',
      root: `${ROOT}/斗技`,
      nodes: 3,
      edges: 2,
      recognizers: 4,
      templates: 5,
      modified: 1760000000,
    },
    { name: '御魂', root: `${ROOT}/御魂`, nodes: 5, edges: 4, recognizers: 2, templates: 2, modified: 0 },
  ],
};

describe('收窄引擎返回的树（v4：root + workflows）', () => {
  it('workspace.tree：工作区根 + 工作流摘要原样收进来（含 modified）', () => {
    const tree = toTree(TREE);

    expect(tree.root).toBe(ROOT);
    expect(tree.workflows.map((item) => item.name)).toEqual(['斗技', '御魂']);
    expect(tree.workflows[0]?.templates).toBe(5);
    expect(tree.workflows[0]?.modified).toBe(1760000000);
  });

  it('空对象 / null / 数组 / 少 workflows：一律降级成空树，不抛', () => {
    for (const dirty of [{}, null, undefined, [], 'nope', { workflows: 'x' }]) {
      const tree = toTree(dirty);
      expect(tree.root).toBe('');
      expect(tree.workflows).toEqual([]);
    }
  });

  it('工作流少字段：补成 0/空串（界面不会显示 undefined）；脏项被过滤', () => {
    expect(toWorkflow({ name: '新工作流' })).toEqual({
      name: '新工作流',
      root: '',
      nodes: 0,
      edges: 0,
      recognizers: 0,
      templates: 0,
      modified: 0,
    });
    expect(toWorkflow(null)).toBeNull();
    expect(toTree({ root: ROOT, workflows: [{ name: 'a' }, null, 42, 'x'] }).workflows).toHaveLength(1);
  });

  it('modified：只认正数，非法/负数一律归 0（= 不知道，不显示时间）', () => {
    expect(toModified(1760000000)).toBe(1760000000);
    expect(toModified(1760000000.9)).toBe(1760000000);
    expect(toModified(0)).toBe(0);
    expect(toModified(-5)).toBe(0);
    expect(toModified(Number.NaN)).toBe(0);
    expect(toModified('1760000000')).toBe(0);
  });

  it('workspace.add / remove 的返回：树在 tree 里嵌套一层', () => {
    expect(toMutationTree({ root: ROOT, name: 'x', tree: TREE }).workflows).toHaveLength(2);
    expect(toMutationTree({}).workflows).toEqual([]);
  });

  it('workflow.*：收 { items }（每项是一个工作流）', () => {
    const items = toWorkflowItems({ items: [TREE.workflows[0], null, 7] });

    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe('斗技');
  });
});

describe('工作区（v4：可以有多个，名字是用户输的）', () => {
  it('workspace.list：active/recommended/trashRoot/items 都收窄；active 缺失 = null', () => {
    const result = toWorkspaceList({
      active: '/w/a',
      recommended: '/repo/workspaces/默认',
      trashRoot: '/config/.trash',
      items: [
        { name: '我的工作区', root: '/w/a', active: true, exists: true },
        { name: 'game-b', root: '/w/b', active: false, exists: false },
      ],
    });

    expect(result.active).toBe('/w/a');
    expect(result.recommended).toBe('/repo/workspaces/默认');
    expect(result.trashRoot).toBe('/config/.trash');
    expect(result.items.map((item) => item.name)).toEqual(['我的工作区', 'game-b']);
    expect(result.items[1]?.exists).toBe(false);

    // 空配置（还没选过工作区）与脏数据都要能降级
    expect(toWorkspaceList({ active: null, items: [] }).active).toBeNull();
    expect(toWorkspaceList({}).active).toBeNull();
    expect(toWorkspaceList(null).items).toEqual([]);
    expect(toWorkspaceList({ active: '', items: [{ root: '/w/c' }] }).active).toBeNull();
  });

  it('工作区条目：name 缺失用目录名兜底；exists 缺字段当"存在"（老引擎不报它）', () => {
    const bare = toWorkspace({ root: '/Users/me/game-a' });
    expect(bare).toEqual({ name: 'game-a', root: '/Users/me/game-a', active: false, exists: true });
    // 非对象项被过滤掉（items 里混进 null/字符串也不炸）
    expect(toWorkspaces({ items: [null, 'x', { root: '/w/a' }] })).toHaveLength(1);
  });
});

describe('路径、相对时间与搜索（面板用）', () => {
  it('parentDir / baseName：认 / 与 \\，容忍结尾斜杠', () => {
    expect(parentDir('/a/b/c')).toBe('/a/b');
    expect(parentDir('/a/b/')).toBe('/a');
    expect(parentDir('/a')).toBe('');
    expect(parentDir('C:\\ws\\默认\\斗技')).toBe('C:\\ws\\默认');
    expect(baseName('/a/b/c')).toBe('c');
    expect(baseName('/Users/me/game-bot')).toBe('game-bot');
    expect(baseName('/a/b/')).toBe('b');
    expect(baseName('')).toBe('');
  });

  it('isAbsolutePath：只认绝对路径或 ~ 开头（相对路径前端先拦一道）', () => {
    expect(isAbsolutePath('/Users/me/game-a')).toBe(true);
    expect(isAbsolutePath('~/game-a')).toBe(true);
    expect(isAbsolutePath('C:\\Users\\me\\game-a')).toBe(true);
    expect(isAbsolutePath('  /Users/me/game-a  ')).toBe(true);
    expect(isAbsolutePath('./game-a')).toBe(false);
    expect(isAbsolutePath('game-a')).toBe(false);
    expect(isAbsolutePath('')).toBe(false);
  });

  it('相对时间：刚刚 / N 分钟 / N 小时 / N 天 / N 个月；0（不知道）不显示', () => {
    const now = 1_760_000_000_000; // 毫秒
    const at = (secondsAgo: number): string => relativeTime(now / 1000 - secondsAgo, now);

    expect(relativeTime(0, now)).toBe('');
    expect(relativeTime(Number.NaN, now)).toBe('');
    expect(at(5)).toBe('刚刚');
    expect(at(59)).toBe('刚刚');
    expect(at(60)).toBe('1 分钟');
    expect(at(600)).toBe('10 分钟');
    expect(at(2 * 3600)).toBe('2 小时');
    expect(at(15 * 86400)).toBe('15 天');
    expect(at(40 * 86400)).toBe('1 个月');
    expect(at(400 * 86400)).toBe('13 个月');
    // 时钟漂移（modified 在未来）也当"刚刚"，不显示负数
    expect(relativeTime(now / 1000 + 500, now)).toBe('刚刚');
  });

  it('相对时间的档位边界：59/60 秒、59/60 分钟、23/24 小时、29/30 天', () => {
    const now = 1_760_000_000_000;
    const at = (secondsAgo: number): string => relativeTime(now / 1000 - secondsAgo, now);

    expect(at(59)).toBe('刚刚');
    expect(at(60)).toBe('1 分钟');
    expect(at(59 * 60)).toBe('59 分钟');
    expect(at(60 * 60)).toBe('1 小时');
    expect(at(23 * 3600)).toBe('23 小时');
    expect(at(24 * 3600)).toBe('1 天');
    expect(at(29 * 86400)).toBe('29 天');
    expect(at(30 * 86400)).toBe('1 个月');
    // 不显示"年"：再老也是月
    expect(at(3650 * 86400)).toBe('121 个月');
  });

  it('搜索：空词全命中、大小写不敏感、工作区与工作流各过滤各的', () => {
    const workflows = toTree(TREE).workflows;
    const workspaces = [
      { name: 'game-a', root: '/w/a', active: true, exists: true },
      { name: 'Game-B', root: '/w/b', active: false, exists: true },
    ];

    expect(matchesQuery('game-a', '  ')).toBe(true);
    expect(matchesQuery('Game-B', 'game')).toBe(true);
    expect(searchWorkspaces(workspaces, 'game').map((item) => item.name)).toEqual(['game-a', 'Game-B']);
    expect(searchWorkspaces(workspaces, 'b').map((item) => item.name)).toEqual(['Game-B']);
    expect(searchWorkflows(workflows, '斗').map((item) => item.name)).toEqual(['斗技']);
    expect(searchWorkflows(workflows, '不存在')).toEqual([]);
  });

  it('hasAnyWorkflow：有没有任何一个工作流（欢迎卡片的显示条件）', () => {
    expect(hasAnyWorkflow([])).toBe(false);
    expect(hasAnyWorkflow(toTree(TREE).workflows)).toBe(true);
  });
});
