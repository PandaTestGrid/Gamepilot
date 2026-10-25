/** 工作区列表（文件夹 › 工作流）。添加工作区用 native-dialog 或手输路径；⌘O/⌘F/Esc 见契约 v4 §3.2。 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileDown,
  FileUp,
  Folder,
  FolderMinus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
} from 'lucide-react';

import { pickDirectoryResult } from '@/features/library/native-dialog';
import {
  downloadWorkflowJson,
  parseWorkflowJson,
  pickWorkflowJsonFile,
} from '@/features/library/workflow-io';
import { useWorkspaceDrop } from '@/features/library/use-workspace-drop';
import { WorkflowNameForm } from '@/features/library/WorkflowNameForm';
import {
  baseName,
  isAbsolutePath,
  relativeTime,
  searchWorkflows,
  searchWorkspaces,
} from '@/features/library/workspace-tree';
import { devLog, graphGet, graphSave } from '@/lib/rpc';
import { useGraphStore } from '@/stores/graph.store';
import { cn } from '@/lib/utils';
import type { WorkflowSummary, WorkspaceSummary } from '@/lib/rpc';
import { RunLiveDot } from '@/features/graph/flow/RunBusySpinner';
import { RunTargetList, RunTargetsTrigger } from '@/features/graph/flow/RunTargetsMenu';
import { useLiveWorkflow, useRunningDevicesForWorkflow } from '@/lib/useLiveWorkflow';
import { useEngineStore } from '@/stores/engine.store';
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
/** 行内表单的按钮：主按钮撑满 + 取消固定宽（同 `RecordOverlay` 的「保存 / 取消」）。
 *  组合宽度小于内容时**按钮自己不会被压**（`shrink-0`）—— 之前「取 / 消」被压成竖排两个字就是这么来的。 */
const PRIMARY_BUTTON =
  'h-6 min-w-0 flex-1 truncate rounded-sm bg-brand px-2 text-badge font-medium text-[#0b0d12] hover:opacity-90 disabled:opacity-50';
const CANCEL_BUTTON =
  'h-6 shrink-0 rounded-sm border border-line px-2 text-badge text-dim hover:bg-raised hover:text-fg';

/** 添加工作区：`pick` = 正在挑目录（原生对话框拿不到时那里就是手输兜底） */
type AddStep = 'closed' | 'pick';

export function WorkspacePanel(): ReactNode {
  const workspaces = useLibraryStore((state) => state.workspaces);
  const workflows = useLibraryStore((state) => state.workflows);
  const workspaceRoot = useLibraryStore((state) => state.workspaceRoot);

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
  const [exportNotice, setExportNotice] = useState('');
  useEffect(() => {
    const onExport = (event: Event): void => {
      const message = (event as CustomEvent<string>).detail;
      setExportNotice(message);
      window.setTimeout(() => setExportNotice(''), 4000);
    };
    window.addEventListener('gamepilot:workflow-exported', onExport);
    return () => window.removeEventListener('gamepilot:workflow-exported', onExport);
  }, []);
  /** 有文件夹正拖在侧栏上方（松手即添加），用来给个明确的落点提示 */
  const [dropping, setDropping] = useState(false);
  /** 正在起名字的那个工作区（'' = 没在起名）；＋ 之后弹表单，提交才 `workflow.create` */
  const [sessionIn, setSessionIn] = useState('');
  /** 正在改显示名的那个工作区 root（'' = 没在改名） */
  const [renamingWs, setRenamingWs] = useState('');
  /** 行内二次确认：'' | 'delete:<root>' | 'unlist:<root>' */
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
   * 无原生对话框时退回手输路径并写日志。
   */
  const beginAdd = useCallback((): void => {
    setConfirming('');
    setSettingsOpen(false);
    setAddStep('pick');
    setDir('');
    void pickDirectoryResult().then((picked) => {
      if (picked.kind === 'picked') {
        void addDirectory(picked.path);
        setAddStep('closed');
        return;
      }
      if (picked.kind === 'cancelled') {
        // 用户自己点了取消：收起表单，不要弹一句"选择器不可用"
        setAddStep('closed');
        devLog('系统文件夹选择器：用户取消');
        return;
      }
      // 真的拿不到选择器：保留手输路径的表单（契约 v4 的兜底）
      devLog(`系统文件夹选择器不可用（${picked.reason}）：改成手输目录路径（拖文件夹进来也行）`);
    });
  }, [addDirectory]);

  /**
   * 工作区行尾的 ＋ = 在这个工作区里新建工作流：**先弹输入框让你起名**，提交了才建。
   *
   * 为什么不是"点一下直接建"：名字是你自己认这张图的方式（用户明确要"点完让我输名字"）。
   */
  const beginSession = useCallback(
    async (root: string, workspaceName: string, isCurrent: boolean): Promise<void> => {
      // 不是当前工作区就先切过去（幂等），否则新工作流会建到别的目录里
      // （先拿返回值再弹表单：切失败时表单会挂在一个切不过去的目录上）
      if (!isCurrent) {
        setBusy(true);
        const ok = await addWorkspace(root, workspaceName);
        setBusy(false);
        if (!ok) {
          return;
        }
      }
      setSessionIn(root);
    },
    [addWorkspace],
  );

  /** 表单提交（两个入口共用）：建完收起表单 */
  const submitSession = useCallback(
    (name: string, description?: string): void => {
      setSessionIn('');
      void createWorkflow(name, description);
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
  /** 移除工作区：deleteFiles=true → **真删除**（连目录里的工作流）；false → 只从列表移除 */
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

  // 引擎就绪后拉一次列表（别让用户自己点刷新；引擎没起来时拉会留下「引擎未启动」的假错误）
  const engineStatus = useEngineStore((state) => state.status);
  useEffect(() => {
    if (engineStatus !== 'ready') {
      return;
    }
    void refreshWorkspaces();
  }, [engineStatus, refreshWorkspaces]);

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
        setRenamingWs('');
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
      {exportNotice && (
        <div role="status" className="shrink-0 border-b border-line bg-raised px-2 py-1 text-[10px] text-confirmed">
          {exportNotice}
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
          title="工作区设置（路径、重命名、刷新列表）"
          className={cn(ICON, settingsOpen && 'bg-raised text-fg')}
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
          {/* 路径输入框独占一行：右栏最窄能拖到 16%（几百像素），跟按钮挤一行时路径只剩几个字 */}
          <input
            autoFocus
            value={dir}
            onChange={(event) => setDir(event.target.value)}
            spellCheck={false}
            placeholder="/Users/me/Documents/game-a"
            className={cn(
              'mt-1 h-6 w-full rounded-sm border bg-canvas px-1.5 text-badge text-fg',
              dirProblem ? 'border-failed' : 'border-line',
            )}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !dirProblem) {
                event.preventDefault();
                void addDirectory(dir);
              }
            }}
          />
          {dirProblem && dir.trim().length > 0 && (
            <div className="mt-0.5 text-badge text-failed">{dirProblem}</div>
          )}
          {/* 动作单独一行：主按钮撑满 + 取消，取消是**按钮**（以前是行末一个裸文字，还被挤成竖排） */}
          <div className="mt-1 flex items-center gap-1">
            <button
              type="button"
              disabled={busy || Boolean(dirProblem) || dir.trim().length === 0}
              onClick={() => void addDirectory(dir)}
              className={PRIMARY_BUTTON}
            >
              添加这个工作区
            </button>
            <button type="button" onClick={() => setAddStep('closed')} className={CANCEL_BUTTON}>
              取消
            </button>
          </div>
          <div className="mt-0.5 text-badge text-faint">
            没弹出文件夹选择器？直接贴绝对路径，也可以把文件夹拖进列表。
          </div>
        </div>
      )}

      {/* 工作区设置：查看/复制路径、修改工作区显示名、刷新目录列表、切换全部展开/折叠 */}
      {settingsOpen && (
        <div className="space-y-1.5 border-b border-line bg-raised px-2 py-2 text-badge">
          {current ? (
            <>
              <div className="flex items-center justify-between gap-1">
                <span className="font-medium text-fg">当前工作区：{currentName || baseName(current)}</span>
                <button
                  type="button"
                  disabled={busy}
                  title="重新扫描磁盘上的工作区与工作流"
                  onClick={() => {
                    void refreshWorkspaces();
                    void useLibraryStore.getState().refresh();
                  }}
                  className="inline-flex items-center gap-1 rounded-sm border border-line bg-canvas px-1.5 py-0.5 text-[10px] text-dim hover:bg-panel hover:text-fg"
                >
                  <RefreshCw className="size-2.5" />
                  刷新列表
                </button>
              </div>
              <div className="flex items-center gap-1">
                <input
                  readOnly
                  value={current}
                  title={current}
                  className="h-5 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1.5 font-mono text-[10px] text-faint focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(current);
                  }}
                  className="h-5 shrink-0 rounded-sm border border-line bg-canvas px-1.5 text-[10px] text-dim hover:bg-panel hover:text-fg"
                >
                  复制路径
                </button>
              </div>
              <div className="flex items-center gap-1 pt-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setRenamingWs(renamingWs === current ? '' : current);
                    setSettingsOpen(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-sm border border-line bg-canvas px-1.5 py-0.5 text-[10px] text-dim hover:bg-panel hover:text-fg"
                >
                  <Pencil className="size-2.5" />
                  修改工作区名称
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (collapsed.size > 0) {
                      setCollapsed(new Set());
                    } else {
                      setCollapsed(new Set(rows.map((r) => r.root)));
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-sm border border-line bg-canvas px-1.5 py-0.5 text-[10px] text-dim hover:bg-panel hover:text-fg"
                >
                  {collapsed.size > 0 ? '全部展开' : '全部收起'}
                </button>
              </div>
            </>
          ) : (
            <div className="text-faint">还没有当前工作区</div>
          )}
        </div>
      )}

      <div className="max-h-72 overflow-auto py-1" data-testid="workspace-list">
        {rows.map((workspace) => {
          const active = workspace.active || workspace.root === current;
          const unlinking = confirming === `unlist:${workspace.root}`;
          const deletingWs = confirming === `delete:${workspace.root}`;
          /** 折叠：只有当前工作区有工作流可折（别的行展开也是空的，箭头照样显示，点了有意义） */
          const folded = collapsed.has(workspace.root);
          const workflowCount = active ? visibleWorkflows.length : 0;
          return (
            <div key={workspace.root}>
              {/* 工作区行（= 一个文件夹）：箭头管展开/收起，**点名字 = 切到这个工作区**
                    （已经在这个工作区里 → 点名字就是展开/收起，和 IDE 一样）；
                    行尾悬停出：＋（新建工作流）、改名、从列表移除、删除工作区目录。 */}
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
                  <span className="shrink-0 text-faint group-hover:hidden">{workflowCount} 个工作流</span>
                )}
                {!workspace.exists && <span className="shrink-0 text-failed">目录不存在</span>}
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-0.5',
                    'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
                  )}
                >
                  {workspace.exists && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        title={`在「${workspace.name}」里新建工作流`}
                        data-testid="workspace-new-session"
                        onClick={() => void beginSession(workspace.root, workspace.name, active)}
                        className="rounded-sm p-0.5 text-dim hover:bg-raised hover:text-fg disabled:opacity-50"
                      >
                        <Plus className="size-3" />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        title={`重命名工作区「${workspace.name}」`}
                        onClick={() => {
                          setConfirming('');
                          setRenamingWs(renamingWs === workspace.root ? '' : workspace.root);
                        }}
                        className="rounded-sm p-0.5 text-faint hover:bg-raised hover:text-fg disabled:opacity-50"
                      >
                        <Pencil className="size-3" />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    title="只从列表移除（保留磁盘上的文件夹与工作流）"
                    data-testid="workspace-row-unlist"
                    onClick={() => {
                      setRenamingWs('');
                      setConfirming(unlinking ? '' : `unlist:${workspace.root}`);
                    }}
                    className="rounded-sm p-0.5 text-faint hover:bg-raised hover:text-fg disabled:opacity-50"
                  >
                    <FolderMinus className="size-3" />
                  </button>
                  {workspace.exists && (
                    <button
                      type="button"
                      disabled={busy}
                      title="删除工作区（连同磁盘目录一起删除，不可恢复）"
                      data-testid="workspace-row-delete"
                      onClick={() => {
                        setRenamingWs('');
                        setConfirming(deletingWs ? '' : `delete:${workspace.root}`);
                      }}
                      className="rounded-sm p-0.5 text-faint hover:bg-raised hover:text-failed disabled:opacity-50"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </span>
              </div>

              {/* 工作区重命名表单 */}
              {renamingWs === workspace.root && (
                <WorkflowNameForm
                  title={`修改工作区「${workspace.name}」显示名称`}
                  initial={workspace.name}
                  submitLabel="保存"
                  onSubmit={(nextName) => {
                    setRenamingWs('');
                    void addWorkspace(workspace.root, nextName);
                  }}
                  onCancel={() => setRenamingWs('')}
                />
              )}

              {/* 工作区行内二次确认：从列表移除 / 彻底删除工作区目录 */}
              {unlinking && (
                <div className="border-b border-line bg-raised px-2 py-1.5 text-badge">
                  <div className="text-dim">只把工作区「{workspace.name}」从列表移除？</div>
                  <div className="mt-0.5 text-faint">磁盘上的文件一个都不会动，随时可以再添加回来。</div>
                  <div className="mt-1 flex items-center gap-1">
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
                </div>
              )}

              {deletingWs && (
                <div className="border-b border-line bg-raised px-2 py-1.5 text-badge">
                  <div className="text-dim">把工作区「{workspace.name}」整个删除？</div>
                  <div className="mt-0.5 text-faint">目录和里面的工作流都会被删掉。</div>
                  <div className="mt-0.5 font-medium text-failed">删除后不可恢复。</div>
                  <div className="mt-1 flex items-center gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(workspace.root, true)}
                      className="shrink-0 rounded-sm border border-failed px-1.5 py-0.5 text-failed hover:bg-raised"
                    >
                      确认删除
                    </button>
                    <button type="button" className={CONFIRM_BUTTON} onClick={() => setConfirming('')}>
                      取消
                    </button>
                  </div>
                </div>
              )}

              {/* ＋ 之后的起名表单：挂在**那个工作区行下面**，提交才建 */}
              {sessionIn === workspace.root && (
                <WorkflowNameForm
                  title={`在「${workspace.name}」里新建工作流`}
                  submitLabel="创建"
                  showDescription
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

              {/* 目录被用户在 Finder 里删了：提供显式文字入口"从列表移除" */}
              {!workspace.exists && !unlinking && (
                <button
                  type="button"
                  className="px-2 py-0.5 pl-7 text-badge text-dim hover:text-fg"
                  onClick={() => setConfirming(`unlist:${workspace.root}`)}
                >
                  从列表移除
                </button>
              )}
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
              新建工作流
            </button>
          </div>
        )}

        {/* 一个工作区都没有：主按钮添加（**手输表单已经开着时不再重复摆一个蓝色按钮**） */}
        {workspaces.length === 0 && addStep === 'closed' && (
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
  const currentWorkflowRoot = useSessionStore((state) => state.currentWorkflow?.root ?? '');
  const switchWorkflow = useSessionStore((state) => state.switchWorkflow);
  const renameWorkflow = useLibraryStore((state) => state.renameWorkflow);
  const duplicateWorkflow = useLibraryStore((state) => state.duplicateWorkflow);
  const removeWorkflow = useLibraryStore((state) => state.removeWorkflow);
  const syncCurrentWorkflow = useSessionStore((state) => state.syncCurrentWorkflow);

  /** '' | 'rename' | 'delete' —— 行内表单/确认，不用浏览器 prompt */
  const [form, setForm] = useState('');
  const [runOpen, setRunOpen] = useState(false);
  const isCurrent = workflow.root === currentWorkflowRoot;
  const live = useLiveWorkflow(workflow.root);
  const runners = useRunningDevicesForWorkflow(workflow.root);

  // 没有设备在跑时菜单直接收起：用派生值而不是 effect 里 setState（会触发级联渲染）
  const runMenuOpen = runOpen && runners.length > 0;
  const run = (task: Promise<boolean>): void => {
    setForm('');
    void task;
  };

  const exportJson = async (): Promise<void> => {
    if (!isCurrent) {
      await switchWorkflow(workflow.root);
    }
    const graph = await graphGet();
    downloadWorkflowJson(workflow.name, graph);
    window.dispatchEvent(new CustomEvent('gamepilot:workflow-exported', { detail: `已导出「${workflow.name}.json」到浏览器默认下载文件夹` }));
  };

  const importJson = async (): Promise<void> => {
    if (!isCurrent) {
      await switchWorkflow(workflow.root);
    }
    const text = await pickWorkflowJsonFile();
    if (!text) {
      return;
    }
    const graph = parseWorkflowJson(text);
    await graphSave(graph);
    await useGraphStore.getState().refresh();
    await syncCurrentWorkflow();
  };

  return (
    <div data-testid="workspace-workflow-row" aria-current={isCurrent ? 'true' : undefined}>
      <div className={cn(WORKFLOW_ROW, 'group', isCurrent ? 'bg-active text-dim' : 'text-dim')}>
        {live ? (
          <RunLiveDot />
        ) : (
          <span
            data-testid="workflow-dot"
            data-current={isCurrent ? 'true' : 'false'}
            aria-hidden="true"
            className={cn('shrink-0 text-[10px] leading-none', isCurrent ? 'text-brand' : 'text-faint')}
          >
            {isCurrent ? '•' : '·'}
          </span>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (live && runners.length > 0) {
              setRunOpen((open) => !open);
              return;
            }
            void switchWorkflow(workflow.root);
          }}
          title={
            workflow.error
              ? `${workflow.root}\n${workflow.error}`
              : live
                ? runners.length
                  ? `${workflow.root}\n运行中 · ${runners.map((runner) => runner.name).join('、')}`
                  : `${workflow.root}\n运行中`
                : workflow.root
          }
          className={cn('min-w-0 flex-1 truncate text-left', live ? 'text-brand' : undefined)}
        >
          {workflow.name}
        </button>
        {workflow.error ? (
          /* 读不回来的工作流要**看得见**：计数是 0，别让人以为它是空图 */
          <span
            data-testid="workflow-error"
            title={workflow.error}
            className="shrink-0 text-failed group-hover:hidden"
          >
            ⚠ 读不了
          </span>
        ) : live && runners.length > 0 ? (
          <RunTargetsTrigger
            runners={runners}
            open={runMenuOpen}
            onToggle={() => setRunOpen((open) => !open)}
          />
        ) : live ? (
          <span className="shrink-0 text-brand">运行中</span>
        ) : (
          <span className="shrink-0 text-faint group-hover:hidden">{relativeTime(workflow.modified)}</span>
        )}
        {live ? null : (
          <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
            <button
              type="button"
              title="导出 graph.json"
              className={ROW_ICON}
              disabled={busy}
              onClick={() => void exportJson()}
            >
              <FileDown className="size-3" />
            </button>
            <button
              type="button"
              title="从 JSON 导入（覆盖当前工作流图）"
              className={ROW_ICON}
              disabled={busy}
              onClick={() => void importJson()}
            >
              <FileUp className="size-3" />
            </button>
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
              title="删除（真删除，不可恢复）"
              className={cn(ROW_ICON, 'hover:text-failed')}
              onClick={() => setForm(form === 'delete' ? '' : 'delete')}
            >
              <Trash2 className="size-3" />
            </button>
          </span>
        )}
      </div>
      {runMenuOpen && live ? (
        <div className="border-b border-line bg-raised/60 pl-5" data-testid="workflow-run-targets">
          <RunTargetList workflowRoot={workflow.root} runners={runners} />
        </div>
      ) : null}

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
            删除「{workflow.name}」？连同目录里的模板一起删掉，
            <span className="text-failed">删除后不可恢复</span>。
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
