/**
 * 中间栏的开始页（没有打开的工作流时）。
 *
 * 布局参照 IDE 欢迎页：上面三张卡（打开工作区 / 新建工作流 / 导入工作流），
 * 下面「最近」列工作区、「历史」列打开过的图。
 *
 * **没有 SSH**：这是本机自动化工作台，设备走 adb / iOS / 本机窗口，
 * 不存在远程仓库那一套连接方式。
 *
 * 数据：
 * - 「最近」= `workspace.list`（用户登记过的工作区，点一行 = 切过去）；
 * - 「历史」= 打开过的图（`ui.store.workflowHistory`，关标签/重启都还在）；
 *   点它时如果不在当前工作区，先把父目录登记成工作区再切过去。
 */
import { FilePlus2, FileUp, FolderOpen } from 'lucide-react';
import { type ReactNode, useCallback, useState } from 'react';

import { WorkflowNameForm } from '@/features/library/WorkflowNameForm';
import { pickDirectoryResult } from '@/features/library/native-dialog';
import {
  parseWorkflowJson,
  pickWorkflowJsonFileNamed,
  suggestedWorkflowName,
} from '@/features/library/workflow-io';
import { baseName, parentDir, relativeTime } from '@/features/library/workspace-tree';
import { taskName } from '@/features/graph/task-name';
import type { GraphPayload, WorkspaceSummary } from '@/lib/rpc';
import { AppMark } from '@/layout/AppMark';
import { cn } from '@/lib/utils';
import { useLibraryStore } from '@/stores/library.store';
import { useUiStore } from '@/stores/ui.store';

const CARD =
  'group flex items-center gap-2.5 rounded-sm border border-line bg-panel px-3 py-2.5 text-left text-body text-fg transition-colors hover:border-brand/50 hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50';
const CARD_ICON =
  'grid size-8 shrink-0 place-items-center rounded-sm bg-raised text-dim group-hover:text-brand';
const LIST_ROW =
  'flex h-[28px] w-full min-w-0 items-center gap-2 rounded-sm px-1.5 text-left text-badge text-dim hover:bg-raised hover:text-fg';

type Form = 'closed' | 'create' | 'import';

export function GraphStartPage({ onOpen }: { onOpen: (root: string) => void }): ReactNode {
  const workspaces = useLibraryStore((state) => state.workspaces);
  const workflows = useLibraryStore((state) => state.workflows);
  const workspaceRoot = useLibraryStore((state) => state.workspaceRoot);
  const addWorkspace = useLibraryStore((state) => state.addWorkspace);
  const createWorkflow = useLibraryStore((state) => state.createWorkflow);
  const importWorkflow = useLibraryStore((state) => state.importWorkflow);
  const history = useUiStore((state) => state.workflowHistory);

  const [form, setForm] = useState<Form>('closed');
  const [manualPath, setManualPath] = useState('');
  const [importName, setImportName] = useState('');
  const [importGraph, setImportGraph] = useState<GraphPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const openWorkflow = useCallback(
    (root: string): void => {
      if (!root) {
        return;
      }
      onOpen(root);
    },
    [onOpen],
  );

  /** 添加工作区：先走系统文件夹选择器；拿不到就露出下面的手输框（契约 v4 的兜底）。 */
  const addDirectory = useCallback(
    async (dir: string): Promise<void> => {
      const trimmed = dir.trim();
      if (!trimmed) {
        return;
      }
      setBusy(true);
      const ok = await addWorkspace(trimmed);
      setBusy(false);
      if (ok) {
        setManualPath('');
        setNote('');
      }
    },
    [addWorkspace],
  );

  const openWorkspace = useCallback(async (): Promise<void> => {
    setNote('');
    setBusy(true);
    const picked = await pickDirectoryResult();
    if (picked.kind === 'cancelled') {
      setBusy(false);
      return;
    }
    if (picked.kind === 'unavailable') {
      setBusy(false);
      setNote(`没有弹出文件夹选择器（${picked.reason}）：粘贴一个绝对路径，或者把文件夹拖进窗口。`);
      return;
    }
    const ok = await addWorkspace(picked.path);
    setBusy(false);
    if (!ok) {
      setNote('这个目录添加失败，原因见右栏工作区。');
    }
  }, [addWorkspace]);

  const openManualPath = useCallback((): void => {
    setNote('');
    void addDirectory(manualPath);
  }, [addDirectory, manualPath]);

  const beginImport = useCallback(async (): Promise<void> => {
    setNote('');
    if (!workspaceRoot) {
      setNote('先「打开工作区」选一个文件夹，再导入工作流。');
      return;
    }
    const picked = await pickWorkflowJsonFileNamed();
    if (!picked) {
      return;
    }
    try {
      const graph = parseWorkflowJson(picked.text);
      setImportGraph(graph);
      setImportName(suggestedWorkflowName(picked.name));
      setForm('import');
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  }, [workspaceRoot]);

  /** 点历史：不在当前工作区就先登记它的父目录（幂等），再切工作流。 */
  const openHistory = useCallback(
    async (root: string): Promise<void> => {
      const parent = parentDir(root);
      if (parent && parent !== workspaceRoot) {
        setBusy(true);
        await addWorkspace(parent);
        setBusy(false);
      }
      openWorkflow(root);
    },
    [addWorkspace, openWorkflow, workspaceRoot],
  );

  const recent = workspaces.slice(0, 10);
  const knownRoots = new Set(workspaces.map((item) => item.root.toLowerCase()));
  const historic = history.slice(0, 12);

  /** 点「最近」里的一行：不是当前工作区就切过去（引擎会自动选里面第一个工作流）；
   *  已经是当前工作区就直接开第一个工作流 —— 否则点了没有任何反应。 */
  const openRecentWorkspace = useCallback(
    (workspace: WorkspaceSummary): void => {
      if (workspace.root !== workspaceRoot) {
        void addWorkspace(workspace.root, workspace.name);
        return;
      }
      const first = [...workflows].sort((left, right) => right.modified - left.modified)[0];
      if (first) {
        openWorkflow(first.root);
      } else {
        setNote('这个工作区里还没有工作流：点上面的「新建工作流」起一个。');
      }
    },
    [addWorkspace, openWorkflow, workspaceRoot, workflows],
  );

  return (
    <div className="absolute inset-0 z-10 flex flex-col overflow-auto bg-canvas">
      <div className="m-auto w-full max-w-[720px] shrink-0 px-6 py-8">
        <div className="flex items-center gap-3">
          <AppMark size={30} monochrome />
          <div>
            <div className="font-serif text-[22px] leading-none tracking-[-0.025em] text-brand">
              GamePilot
            </div>
            <div className="mt-1 font-mono text-[9px] tracking-[0.12em] text-dim">
              FIELDNOTES / AUTOMATION
            </div>
          </div>
        </div>

        <p className="mt-5 text-[13px] text-dim">
          选一个工作区开始，或者把已有的 <span className="font-mono text-faint">graph.json</span> 导进来。
        </p>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <button type="button" className={CARD} onClick={() => void openWorkspace()} disabled={busy}>
            <span className={CARD_ICON}>
              <FolderOpen className="size-4" strokeWidth={1.75} />
            </span>
            <span className="min-w-0">
              <span className="block truncate">打开工作区</span>
              <span className="block truncate text-badge text-faint">选一个文件夹</span>
            </span>
          </button>
          <button
            type="button"
            className={CARD}
            onClick={() => {
              if (!workspaceRoot) {
                setNote('先「打开工作区」选一个文件夹，再新建工作流。');
                return;
              }
              setForm(form === 'create' ? 'closed' : 'create');
            }}
            disabled={busy}
          >
            <span className={CARD_ICON}>
              <FilePlus2 className="size-4" strokeWidth={1.75} />
            </span>
            <span className="min-w-0">
              <span className="block truncate">新建工作流</span>
              <span className="block truncate text-badge text-faint">从空白开始</span>
            </span>
          </button>
          <button
            type="button"
            className={CARD}
            onClick={() => void beginImport()}
            disabled={busy || !workspaceRoot}
            title={workspaceRoot ? '选一个 graph.json 导入为新工作流' : '先把一个文件夹添加为工作区'}
          >
            <span className={CARD_ICON}>
              <FileUp className="size-4" strokeWidth={1.75} />
            </span>
            <span className="min-w-0">
              <span className="block truncate">导入工作流</span>
              <span className="block truncate text-badge text-faint">从 graph.json</span>
            </span>
          </button>
        </div>

        {note && <div className="mt-2 text-badge text-pending">{note}</div>}
        {note && (
          <div className="mt-2 flex items-center gap-1">
            <input
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
              spellCheck={false}
              placeholder="粘贴工作区绝对路径，例如 S:\\game\\games"
              className="h-7 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-2 font-mono text-[11px] text-fg"
            />
            <button
              type="button"
              disabled={busy || !manualPath.trim()}
              onClick={() => void openManualPath()}
              className="h-7 shrink-0 rounded-sm bg-brand px-2.5 text-badge font-medium text-[#0b0d12] hover:opacity-90 disabled:opacity-50"
            >
              添加
            </button>
          </div>
        )}

        {form === 'create' && (
          <div className="mt-3 overflow-hidden rounded-sm border border-line">
            <WorkflowNameForm
              title={`在「${baseName(workspaceRoot) || '当前工作区'}」里新建工作流`}
              submitLabel="新建"
              showDescription
              onSubmit={(name, description) => {
                setForm('closed');
                void createWorkflow(name, description).then((ok) => {
                  // 建好就进图（开始页只负责"从哪儿开始"，不是编辑器）
                  if (ok) {
                    useUiStore.getState().hideStartPage();
                  }
                });
              }}
              onCancel={() => setForm('closed')}
            />
          </div>
        )}

        {form === 'import' && importGraph && (
          <div className="mt-3 overflow-hidden rounded-sm border border-line">
            <div className="bg-raised px-2 py-1.5 text-badge leading-5 text-faint">
              只导入 graph.json。识别器模板图在 <span className="font-mono">templates/</span> 里，
              不在这个文件里；导入后带模板的识别器会识别不到，需要重新框选录制。
            </div>
            <WorkflowNameForm
              title={`导入为「${baseName(workspaceRoot) || '当前工作区'}」里的新工作流`}
              initial={importName}
              submitLabel="导入"
              onSubmit={(name) => {
                setForm('closed');
                setBusy(true);
                void importWorkflow(name, importGraph).then((ok) => {
                  setBusy(false);
                  if (ok) {
                    useUiStore.getState().hideStartPage();
                  } else {
                    setNote('导入失败，原因见右栏工作区。');
                  }
                });
              }}
              onCancel={() => {
                setForm('closed');
                setImportGraph(null);
              }}
            />
          </div>
        )}

        <section className="mt-7">
          <div className="flex items-baseline gap-2 border-b border-line pb-1">
            <h2 className="text-panelhead font-medium text-fg">最近</h2>
            <span className="text-badge text-faint">
              {recent.length > 0 ? `${workspaces.length} 个工作区` : '还没有工作区'}
            </span>
          </div>
          {recent.length > 0 ? (
            <ul className="mt-1">
              {recent.map((workspace) => (
                <WorkspaceRow
                  key={workspace.root}
                  workspace={workspace}
                  onClick={() => openRecentWorkspace(workspace)}
                />
              ))}
            </ul>
          ) : (
            <p className="px-1 py-2 text-badge text-faint">点上面的「打开工作区」选一个文件夹。</p>
          )}
        </section>

        <section className="mt-6">
          <div className="flex items-baseline gap-2 border-b border-line pb-1">
            <h2 className="text-panelhead font-medium text-fg">历史</h2>
            <span className="text-badge text-faint">打开过的图（关掉标签也还在）</span>
          </div>
          {historic.length > 0 ? (
            <ul className="mt-1">
              {historic.map((entry) => (
                <li key={entry.root}>
                  <button
                    type="button"
                    onClick={() => void openHistory(entry.root)}
                    title={entry.root}
                    className={LIST_ROW}
                  >
                    <span className="min-w-0 flex-1 truncate">{taskName(entry.root)}</span>
                    {!knownRoots.has(parentDir(entry.root).toLowerCase()) && (
                      <span className="shrink-0 text-[10px] text-faint">不在当前工作区</span>
                    )}
                    <span className="max-w-[40%] shrink-0 truncate font-mono text-[10px] text-faint">
                      {parentDir(entry.root)}
                    </span>
                    <span className="w-14 shrink-0 text-right text-faint">
                      {relativeTime(Math.floor(entry.at / 1000))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-1 py-2 text-badge text-faint">还没有打开过工作流。</p>
          )}
        </section>
      </div>
    </div>
  );
}

function WorkspaceRow({
  workspace,
  onClick,
}: {
  workspace: WorkspaceSummary;
  onClick: () => void;
}): ReactNode {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        title={workspace.root}
        className={cn(LIST_ROW, workspace.active && 'text-fg')}
      >
        <FolderOpen className="size-3 shrink-0 text-faint" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
        {!workspace.exists && <span className="shrink-0 text-failed">目录不存在</span>}
        <span className="max-w-[45%] shrink-0 truncate font-mono text-[10px] text-faint">
          {parentDir(workspace.root)}
        </span>
        <span className="w-14 shrink-0 text-right text-faint">{workspace.active ? '当前' : ''}</span>
      </button>
    </li>
  );
}
