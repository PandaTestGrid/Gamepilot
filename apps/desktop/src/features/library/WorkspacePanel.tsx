/**
 * 工作区区域（**右侧区域的本体内容**，不是浮层、不是弹框）：契约 v4 §3.2。
 *
 * 形态（用户原话："就像 deepseek 侧边栏一样，在工作区下面添加一个会话"）：
 *   头部「工作区」+ 搜索 + 设置 + ＋（添加工作区 ⌘O）
 *   列表 = **工作区（文件夹）› 会话（= 一张状态图）**：
 *     工作区行：箭头（展开/收起）+ 文件夹 + 名字（**点名字 = 切到这个工作区**）+ 悬停的 ＋（新建会话）
 *     会话行：圆点 + 名字 + 相对时间（点名字切过去，悬停出 改 / 复 / 删）
 *
 * **不要在这个区域里再画一遍同样的列表**（曾经有一个「树」组件和它并排渲染，重复且混乱 —— 已经删掉）。
 *
 * 几条硬规矩：
 * - **工作区 = 电脑上的一个文件夹**（任意位置，引擎 `workspace.add` 不往里面写任何东西）；
 * - **＋/⌘O 添加工作区是一步**：挑文件夹 → 直接登记（显示名默认取文件夹名，之后可改）。
 *   挑文件夹用原生对话框（`native-dialog.ts`）；**拿不到就退回手输绝对路径**（浏览器 / vitest
 *   里必须能验证，绝不允许"点＋没反应"），并在日志里记一行说明为什么退化了；
 * - **从 Finder 拖一个文件夹进来 = 同一个动作**（webview 的拖拽事件给的是真实路径）；
 * - **＋ 新建会话不弹输入框**：自动命名（「新会话」「新会话2」…，引擎侧 `auto_name`），建完直接进去；
 * - 移除工作区两个入口都要有：**移到回收站（可恢复）** 与 **只从列表移除（不动文件）**，
 *   都走**行内二次确认**；文案显示回收站路径，且**不许出现"永久删除"**（我们不做真删除）；
 * - 一律不用 浏览器原生 prompt / confirm（Tauri 的 webview 里弹不出来，踩过两次）；
 * - ⌘O = 添加工作区；⌘F = 聚焦搜索框；Esc = 收起行内表单。
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import {
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
} from 'lucide-react';

import { pickDirectory } from '@/features/library/native-dialog';
import { useWorkspaceDrop } from '@/features/library/use-workspace-drop';
import { WorkflowNameForm } from '@/features/library/WorkflowNameForm';
import {
  baseName,
  isAbsolutePath,
  relativeTime,
  searchWorkflows,
  searchWorkspaces,
} from '@/features/library/workspace-tree';
import { devLog } from '@/lib/rpc';
import { cn } from '@/lib/utils';
import type { WorkflowSummary, WorkspaceSummary } from '@/lib/rpc';
import { useLibraryStore } from '@/stores/library.store';
import { useSessionStore } from '@/stores/session.store';

const ICON = 'grid size-6 shrink-0 place-items-center rounded-sm text-dim hover:bg-raised hover:text-fg';
/** 列表里的一行：行高与树里的行一致（h-[26px]、gap-1.5、px-2），列表看起来才是一套 */
const LIST_ROW = 'flex h-[26px] w-full min-w-0 items-center gap-1.5 px-2 text-left text-badge';
/** 工作流行：左边缩进到工作区名字之后；当前那条给一层**低对比**的深灰底（不整行变蓝） */
const WORKFLOW_ROW = 'flex h-[26px] w-full min-w-0 items-center gap-1.5 pr-2 pl-7 text-badge';
/** 工作流行悬停出来的小图标按钮 */
const ROW_ICON = 'rounded-sm text-faint hover:bg-raised hover:text-fg';
const CONFIRM_BUTTON =
  'shrink-0 rounded-sm border border-line px-1.5 py-0.5 text-badge text-dim hover:bg-raised hover:text-fg';

/** 添加工作区：`pick` = 正在挑目录（原生对话框拿不到时那里就是手输兜底） */
type AddStep = 'closed' | 'pick';

export function WorkspacePanel(): ReactNode {
  const workspaces = useLibraryStore((state) => state.workspaces);
  const workflows = useLibraryStore((state) => state.workflows);
  const workspaceRoot = useLibraryStore((state) => state.workspaceRoot);
  const trashRoot = useLibraryStore((state) => state.trashRoot);
  const addWorkspace = useLibraryStore((state) => state.addWorkspace);
  const removeWorkspace = useLibraryStore((state) => state.removeWorkspace);
  const refreshWorkspaces = useLibraryStore((state) => state.refreshWorkspaces);
  const createWorkflow = useLibraryStore((state) => state.createWorkflow);

  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addStep, setAddStep] = useState<AddStep>('closed');
  /** 手输兜底的目录（'' = 还没输） */
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  /** 有文件夹正拖在侧栏上方（松手即添加），用来给个明确的落点提示 */
  const [dropping, setDropping] = useState(false);
  /** 正在起名字的那个工作区（'' = 没在起名）；＋ 之后弹表单，提交才 `workflow.create` */
  const [sessionIn, setSessionIn] = useState('');
  /** 行内二次确认：'' | 'trash' | 'unlist'（当前工作区）| 'unlist:<root>'（列表里某一项） */
  const [confirming, setConfirming] = useState('');
  /**
   * 折叠的工作区（**只有当前工作区默认展开**，别的行点开也没有内容 —— 像树一样能折起来）。
   * 切到别的工作区时自动展开它、把上一个折起来：`useEffect` 里对比上一次的 root。
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const lastCurrent = useRef('');

  const dirProblem = dir.trim() === '' || isAbsolutePath(dir) ? '' : '要绝对路径（或 ~ 开头）';

  /**
   * 添加工作区：**一步到位** —— 挑中的文件夹直接登记，显示名默认取文件夹名（之后可改）。
   *
   * 同一个目录再加一次是幂等的（引擎语义）：所以"点名字切工作区""拖进来""⌘O 又选一遍"
   * 这些路径可以放心复用这一个动作。
   */
  const addDirectory = useCallback(
    async (picked: string): Promise<boolean> => {
      const trimmed = picked.trim();
      if (!trimmed) {
        return false;
      }
      setBusy(true);
      const ok = await addWorkspace(trimmed);
      setBusy(false);
      if (ok) {
        setAddStep('closed');
        setDir('');
      }
      return ok;
    },
    [addWorkspace],
  );

  /** 一次加多个（拖一堆文件夹进来）：逐个登记，最后一个成为当前 */
  const addDirectories = useCallback(
    async (paths: readonly string[]): Promise<void> => {
      const folders = paths.map((item) => item.trim()).filter(Boolean);
      if (folders.length === 0) {
        return;
      }
      setBusy(true);
      for (const folder of folders) {
        await addWorkspace(folder);
      }
      setBusy(false);
    },
    [addWorkspace],
  );

  /**
   * 开始"添加工作区"：先试**系统文件夹选择器**，选中就直接加。
   * 拿不到原生对话框（浏览器 / 权限没给）时，手输框已经显示出来了 —— 顺手记一行日志，
   * 免得用户以为"点了没反应"（这是我们踩过的坑）。
   */
  const beginAdd = useCallback((): void => {
    setConfirming('');
    setSettingsOpen(false);
    setAddStep('pick');
    setDir('');
    void pickDirectory().then((picked) => {
      if (picked) {
        void addDirectory(picked);
        return;
      }
      devLog('系统文件夹选择器不可用：改成手输目录路径（拖文件夹进来也行）');
    });
  }, [addDirectory]);

  /**
   * 工作区行尾的 ＋ = 在这个工作区里新建会话：**先弹输入框让你起名**，提交了才建。
   *
   * 为什么不是"点一下直接建"：名字是你自己认这张图的方式（用户明确要"点完让我输名字"）。
   */
  const beginSession = useCallback(
    async (root: string, workspaceName: string, isCurrent: boolean): Promise<void> => {
      // 不是当前工作区就先切过去（幂等），否则新会话会建到别的目录里
      if (!isCurrent) {
        setBusy(true);
        await addWorkspace(root, workspaceName);
        setBusy(false);
      }
      setSessionIn(root);
    },
    [addWorkspace],
  );

  /** 表单提交（两个入口共用）：建完收起表单 */
  const submitSession = useCallback(
    (name: string): void => {
      setSessionIn('');
      void createWorkflow(name);
    },
    [createWorkflow],
  );

  // 从 Finder 拖文件夹进来 = 添加工作区（webview 事件给的是真实路径）
  useWorkspaceDrop({
    onEnter: () => setDropping(true),
    onLeave: () => setDropping(false),
    onDrop: (paths) => {
      setDropping(false);
      void addDirectories(paths);
    },
  });
  /** 移除工作区：deleteFiles=true → 移到回收站；false → 只从列表移除 */
  const remove = useCallback(
    async (target: string, deleteFiles: boolean): Promise<void> => {
      setBusy(true);
      setConfirming('');
      await removeWorkspace(target, deleteFiles);
      setBusy(false);
    },
    [removeWorkspace],
  );

  // ⌘O = 添加工作区（面板没打开也能按），⌘F = 打开并聚焦搜索
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'o') {
        event.preventDefault();
        beginAdd();
      } else if (key === 'f') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [beginAdd]);

  // 区域一挂载就拉一次列表（别让用户自己点刷新）
  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  /** 展开/收起一个工作区（点箭头，或点"已经在当前工作区"的名字）。 */
  const toggle = useCallback((root: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(root)) {
        next.delete(root);
      } else {
        next.add(root);
      }
      return next;
    });
  }, []);

  /**
   * 点工作区名字 = **切到这个工作区**（`workspace.add` 幂等：再加一次就是切过去）；
   * 已经在这个工作区里了 → 当成展开/收起（树的手感，和 IDE 一样）。
   */
  const openWorkspace = useCallback(
    (root: string, workspaceName: string, isCurrent: boolean): void => {
      if (isCurrent) {
        toggle(root);
        return;
      }
      void addWorkspace(root, workspaceName);
    },
    [addWorkspace, toggle],
  );

  // Esc = 收起正在进行的行内表单（区域常驻，不"关面板"）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setAddStep('closed');
        setConfirming('');
        setSessionIn('');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const visibleWorkspaces = searchWorkspaces(workspaces, query);
  /** 当前工作区里的工作流（搜索词也会过滤它） */
  const visibleWorkflows = searchWorkflows(workflows, query);
  const currentWorkspace = workspaces.find((item) => item.active || item.root === workspaceRoot);
  const current = currentWorkspace?.root ?? workspaceRoot;
  const currentName = currentWorkspace?.name ?? '';
  /**
   * 工作流行挂在"当前工作区行"下面，而那一行来自 `workspace.list`。
   * `workspace.list` 挂了但 `workspace.tree` 好着的时候（老引擎/临时错误），
   * 用 `workspace.tree` 的 root 兜一行出来，别让工作流凭空消失。
   */
  const listFailedButTreeOk = !currentWorkspace && current.length > 0;
  const fallbackRow: WorkspaceSummary | null = listFailedButTreeOk
    ? { name: baseName(current), root: current, active: true, exists: true }
    : null;
  /**
   * 搜索词命中了工作流、但没命中工作区名字时，把"当前工作区"这一行也带上 ——
   * 否则匹配到的工作流没有行可以挂（搜「斗技」应该能看到它）。
   */
  const rows =
    fallbackRow !== null
      ? [fallbackRow, ...visibleWorkspaces]
      : currentWorkspace && visibleWorkflows.length > 0 && !visibleWorkspaces.includes(currentWorkspace)
        ? [currentWorkspace, ...visibleWorkspaces]
        : visibleWorkspaces;
  /**
   * 「有工作区、但一个工作流都没有」时给一条明确的出路（契约 §3.3）：
   * 加了工作区却空着，用户得知道下一步是「＋ 工作流」（不是对着空列表发呆）。
   */
  const emptyRegion = rows.length > 0 && workflows.length === 0 && current.length > 0;
  // 切工作区（含首次加载出 root）：把折叠状态重置成"只有它自己展开"
  useEffect(() => {
    if (current && current !== lastCurrent.current) {
      lastCurrent.current = current;
      setCollapsed(new Set());
    }
  }, [current]);

  /** 回收站路径：引擎给了就显示绝对路径，拿不到就降级说明（都不许说"永久删除"） */
  const trashLabel = trashRoot || '全局回收站（配置目录下的 .trash/）';

  return (
    <div
      className={cn(
        'relative flex h-full min-h-0 w-full flex-col',
        dropping && 'ring-1 ring-brand ring-inset',
      )}
      data-testid="workspace-region"
    >
      {dropping && (
        <div
          data-testid="workspace-drop-hint"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-brand px-2 py-0.5 text-center text-badge font-medium text-[#0b0d12]"
        >
          松手就把它添加为工作区
        </div>
      )}
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="text-body text-fg">工作区</span>
        <span className="flex-1" />
        <button
          type="button"
          title="搜索工作区与工作流（⌘F）"
          className={ICON}
          onClick={() => setSearchOpen((value) => !value)}
        >
          <Search className="size-3.5" />
        </button>
        <button
          type="button"
          title="设置（移除当前工作区）"
          className={ICON}
          onClick={() => {
            setSettingsOpen((value) => !value);
            setConfirming('');
          }}
        >
          <Settings className="size-3.5" />
        </button>
        {/* 添加入口做成**看得见的文字按钮**（只放一个 ＋ 图标时用户找不到它） */}
        <button
          type="button"
          title="添加工作区（选文件夹 + 起名字）⌘O"
          data-testid="workspace-add"
          onClick={beginAdd}
          disabled={busy}
          className="ml-1 flex h-5 shrink-0 items-center gap-1 rounded-sm border border-line px-1.5 text-badge text-dim hover:bg-raised hover:text-fg disabled:opacity-50"
        >
          <Plus className="size-3" />
          添加
        </button>
      </div>

      {searchOpen && (
        <div className="border-b border-line px-2 py-1">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            spellCheck={false}
            placeholder="搜索工作区 / 工作流"
            className="h-6 w-full rounded-sm border border-line bg-canvas px-1.5 text-badge text-fg"
          />
        </div>
      )}

      {/* 添加工作区的手输兜底：原生对话框拿不到时在这里输绝对路径，**输了就直接加** */}
      {addStep === 'pick' && (
        <div className="border-b border-line bg-raised px-2 py-1.5">
          <div className="text-badge text-dim">添加工作区 · 选文件夹</div>
          <div className="mt-1 flex items-center gap-1">
            <input
              autoFocus
              value={dir}
              onChange={(event) => setDir(event.target.value)}
              spellCheck={false}
              placeholder="/Users/me/Documents/game-a"
              className={cn(
                'h-6 min-w-0 flex-1 rounded-sm border bg-canvas px-1.5 text-badge text-fg',
                dirProblem ? 'border-failed' : 'border-line',
              )}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !dirProblem) {
                  event.preventDefault();
                  void addDirectory(dir);
                }
              }}
            />
            <button
              type="button"
              disabled={busy || Boolean(dirProblem) || dir.trim().length === 0}
              onClick={() => void addDirectory(dir)}
              className="h-6 shrink-0 rounded-sm bg-brand px-2 text-badge font-medium text-[#0b0d12] hover:opacity-90 disabled:opacity-50"
            >
              添加这个工作区
            </button>
          </div>
          {dirProblem && dir.trim().length > 0 && (
            <div className="mt-0.5 text-badge text-failed">{dirProblem}</div>
          )}
          <div className="mt-1 flex items-center gap-2 text-badge text-faint">
            <span>系统文件夹选择器没弹出来？直接贴路径，或者把文件夹拖进这个列表</span>
            <span className="flex-1" />
            <button type="button" className="hover:text-fg" onClick={() => setAddStep('closed')}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 设置：移除当前工作区（两个入口都要有，差别必须看得见） */}
      {settingsOpen && (
        <div className="border-b border-line bg-raised px-2 py-1.5 text-badge">
          {current ? (
            confirming === 'trash' ? (
              <div>
                <div className="text-dim">把工作区「{currentName || '当前'}」整个移到回收站？</div>
                <div className="mt-0.5 text-faint">位置：{trashLabel}</div>
                <div className="mt-0.5 text-faint">移到那里之后可以恢复。</div>
                <div className="mt-1 flex items-center gap-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(current, true)}
                    className="shrink-0 rounded-sm border border-failed px-1.5 py-0.5 text-failed hover:bg-raised"
                  >
                    确认移入回收站
                  </button>
                  <button type="button" className={CONFIRM_BUTTON} onClick={() => setConfirming('')}>
                    取消
                  </button>
                </div>
              </div>
            ) : confirming === 'unlist' ? (
              <div>
                <div className="text-dim">只把工作区「{currentName || '当前'}」从列表移除？</div>
                <div className="mt-0.5 text-faint">磁盘上的文件一个都不会动，随时可以再添加回来。</div>
                <div className="mt-1 flex items-center gap-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(current, false)}
                    className="shrink-0 rounded-sm border border-line px-1.5 py-0.5 text-dim hover:bg-raised hover:text-fg"
                  >
                    确认移除
                  </button>
                  <button type="button" className={CONFIRM_BUTTON} onClick={() => setConfirming('')}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <div className="text-dim">
                  当前工作区：{currentName || current}
                  <span className="text-faint">（{current}）</span>
                </div>
                <button
                  type="button"
                  className="flex items-center gap-1 text-left text-failed hover:underline"
                  onClick={() => setConfirming('trash')}
                >
                  <Trash2 className="size-3" />
                  移到回收站（可以恢复）
                </button>
                <button
                  type="button"
                  className="text-left text-dim hover:text-fg"
                  onClick={() => setConfirming('unlist')}
                >
                  只从列表移除（不动文件）
                </button>
              </div>
            )
          ) : (
            <div className="text-faint">还没有当前工作区</div>
          )}
        </div>
      )}

      <div className="max-h-72 overflow-auto py-1" data-testid="workspace-list">
        {rows.map((workspace) => {
          const active = workspace.active || workspace.root === current;
          const unlinking = confirming === `unlist:${workspace.root}`;
          /** 折叠：只有当前工作区有工作流可折（别的行展开也是空的，箭头照样显示，点了有意义） */
          const folded = collapsed.has(workspace.root);
          const workflowCount = active ? visibleWorkflows.length : 0;
          return (
            <div key={workspace.root}>
              {/* 工作区行（= 一个文件夹）：箭头管展开/收起，**点名字 = 切到这个工作区**
                    （已经在这个工作区里 → 点名字就是展开/收起，和 IDE 一样）；
                    行尾悬停的 ＋ = 在这个工作区里新建一个会话（= 一张状态图，自动命名）。
                    行本身恒为白字 + 灰文件夹图标，当前那个不加背景不变蓝（"当前"靠子行体现）。 */}
              <div
                data-testid="workspace-row"
                data-active={active ? 'true' : 'false'}
                className={cn(LIST_ROW, 'group text-fg hover:bg-raised')}
              >
                <button
                  type="button"
                  aria-expanded={!folded}
                  data-testid="workspace-disclosure"
                  title={folded ? '展开' : '收起'}
                  onClick={() => toggle(workspace.root)}
                  className="shrink-0 text-faint hover:text-fg"
                >
                  {folded ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                </button>
                <Folder className="size-3.5 shrink-0 text-faint" />
                <button
                  type="button"
                  title={`${workspace.root}\n点一下切到这个工作区`}
                  data-testid="workspace-switch"
                  onClick={() => openWorkspace(workspace.root, workspace.name, active)}
                  className="min-w-0 flex-1 truncate text-left"
                >
                  {workspace.name}
                </button>
                {folded && workflowCount > 0 && (
                  <span className="shrink-0 text-faint">{workflowCount} 个工作流</span>
                )}
                {!workspace.exists && <span className="shrink-0 text-failed">目录不存在</span>}
                {workspace.exists && (
                  <button
                    type="button"
                    disabled={busy}
                    title={`在「${workspace.name}」里新建一个会话（= 一张状态图）`}
                    data-testid="workspace-new-session"
                    onClick={() => void beginSession(workspace.root, workspace.name, active)}
                    className={cn(
                      'shrink-0 rounded-sm px-1 text-dim hover:bg-raised hover:text-fg disabled:opacity-50',
                      'opacity-0 group-hover:opacity-100 focus:opacity-100',
                    )}
                  >
                    <Plus className="size-3" />
                  </button>
                )}
              </div>

              {/* ＋ 之后的起名表单：挂在**那个工作区行下面**，提交才建 */}
              {sessionIn === workspace.root && (
                <WorkflowNameForm
                  title={`在「${workspace.name}」里新建会话`}
                  submitLabel="创建"
                  onSubmit={submitSession}
                  onCancel={() => setSessionIn('')}
                />
              )}

              {/* 当前工作区下面挂它的工作流（相对时间来自 workspace.tree 的 modified）：
                    圆点 + 名字 + 右对齐时间；当前那条圆点是**蓝色实心**、整行深灰底（文字不整体变蓝）；
                    悬停出「改 / 复 / 删」三个小图标（点名字 = 切过去）。
                    折叠时整段不渲染（`aria-expanded=false` 在那个箭头上）。 */}
              {workspace.root === current &&
                !folded &&
                visibleWorkflows.map((workflow) => (
                  <WorkflowRow key={workflow.root} workflow={workflow} busy={busy} />
                ))}

              {/* 目录被用户在 Finder 里删了：只能"从列表移除"（不动文件，也没文件可动） */}
              {!workspace.exists &&
                (unlinking ? (
                  <div className="flex items-center gap-1 bg-raised px-2 py-1 text-badge">
                    <span className="min-w-0 flex-1 truncate text-dim">从列表移除「{workspace.name}」？</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(workspace.root, false)}
                      className={CONFIRM_BUTTON}
                    >
                      确认移除
                    </button>
                    <button type="button" className={CONFIRM_BUTTON} onClick={() => setConfirming('')}>
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="px-2 py-0.5 pl-7 text-badge text-dim hover:text-fg"
                    onClick={() => setConfirming(`unlist:${workspace.root}`)}
                  >
                    从列表移除
                  </button>
                ))}
            </div>
          );
        })}

        {rows.length === 0 && (
          <div className="px-2 py-2 text-badge text-faint">
            {workspaces.length === 0 ? '还没有工作区' : '没有匹配的工作区'}
          </div>
        )}

        {/* 有工作区但一个工作流都没有 → 给一条明确出路：输名字建第一个工作流（契约 §3.3） */}
        {emptyRegion && (
          <div className="px-2 pb-1">
            <div className="py-1 text-badge text-faint">这个工作区还没有工作流</div>
            <button
              type="button"
              disabled={busy}
              onClick={() => setSessionIn(current)}
              className="flex w-full items-center gap-1.5 rounded-sm border border-line px-2 py-1 text-badge text-dim hover:bg-raised hover:text-fg disabled:opacity-50"
            >
              <Plus className="size-3" />
              新建会话（= 一张状态图）
            </button>
          </div>
        )}

        {/* 一个工作区都没有：主按钮添加 + 次按钮用默认（底部那一项就是次按钮） */}
        {workspaces.length === 0 && (
          <div className="px-2 pb-1">
            <button
              type="button"
              disabled={busy}
              onClick={beginAdd}
              className="flex w-full items-center gap-1.5 rounded-sm bg-brand px-2 py-1 text-badge font-medium text-[#0b0d12] hover:opacity-90 disabled:opacity-50"
            >
              <Plus className="size-3" />
              添加工作区…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 工作流行：`• 名字 ……… 时间` + 悬停的「改 / 复 / 删」。
 *
 * 这些操作以前在另一个「树」组件里（和这个区域并排重复渲染同一份列表，已删掉），
 * 现在挂在**这一行**上：点名字切过去、铅笔改名（内联表单）、复制、删除（行内二次确认）。
 */
function WorkflowRow({
  workflow,
  busy,
}: {
  readonly workflow: WorkflowSummary;
  readonly busy: boolean;
}): ReactNode {
  const currentWorkflowRoot = useSessionStore((state) => state.project?.root ?? '');
  const switchProject = useSessionStore((state) => state.switchProject);
  const renameWorkflow = useLibraryStore((state) => state.renameWorkflow);
  const duplicateWorkflow = useLibraryStore((state) => state.duplicateWorkflow);
  const removeWorkflow = useLibraryStore((state) => state.removeWorkflow);

  /** '' | 'rename' | 'delete' —— 行内表单/确认，不用浏览器 prompt */
  const [form, setForm] = useState('');
  const isCurrent = workflow.root === currentWorkflowRoot;
  const run = (task: Promise<boolean>): void => {
    setForm('');
    void task;
  };

  return (
    <div data-testid="workspace-workflow-row" aria-current={isCurrent ? 'true' : undefined}>
      <div className={cn(WORKFLOW_ROW, 'group', isCurrent ? 'bg-active text-dim' : 'text-dim')}>
        <span
          data-testid="workflow-dot"
          data-current={isCurrent ? 'true' : 'false'}
          aria-hidden="true"
          className={cn('shrink-0 text-[10px] leading-none', isCurrent ? 'text-brand' : 'text-faint')}
        >
          {isCurrent ? '•' : '·'}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void switchProject(workflow.root)}
          title={workflow.root}
          className="min-w-0 flex-1 truncate text-left"
        >
          {workflow.name}
        </button>
        <span className="shrink-0 text-faint group-hover:hidden">{relativeTime(workflow.modified)}</span>
        <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
          <button
            type="button"
            title="重命名"
            className={ROW_ICON}
            onClick={() => setForm(form === 'rename' ? '' : 'rename')}
          >
            <Pencil className="size-3" />
          </button>
          <button
            type="button"
            title="复制一份"
            className={ROW_ICON}
            disabled={busy}
            onClick={() => run(duplicateWorkflow(workflow.root, `${workflow.name}-副本`))}
          >
            <Copy className="size-3" />
          </button>
          <button
            type="button"
            title="删除（移到工作区根的 .trash/，可恢复）"
            className={cn(ROW_ICON, 'hover:text-failed')}
            onClick={() => setForm(form === 'delete' ? '' : 'delete')}
          >
            <Trash2 className="size-3" />
          </button>
        </span>
      </div>

      {form === 'rename' && (
        <WorkflowNameForm
          title={`重命名「${workflow.name}」`}
          initial={workflow.name}
          submitLabel="重命名"
          onSubmit={(next) => run(renameWorkflow(workflow.root, next))}
          onCancel={() => setForm('')}
        />
      )}

      {form === 'delete' && (
        <div className="flex items-center gap-1 border-b border-line bg-raised px-2 py-1 text-badge">
          <span className="min-w-0 flex-1 truncate text-dim">
            删除「{workflow.name}」？会移到工作区根的 .trash/，可以恢复。
          </span>
          <button
            type="button"
            disabled={busy}
            className="shrink-0 rounded-sm border border-failed px-1.5 py-0.5 text-failed hover:bg-raised"
            onClick={() => run(removeWorkflow(workflow.root))}
          >
            确认删除
          </button>
          <button type="button" className={CONFIRM_BUTTON} onClick={() => setForm('')}>
            取消
          </button>
        </div>
      )}
    </div>
  );
}
