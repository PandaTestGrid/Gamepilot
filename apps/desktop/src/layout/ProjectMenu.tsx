/**
 * 工作流菜单（顶栏）：手动切目录 + 列**当前工作区里的工作流**（v4 只有两层）。
 *
 * 一个工作流 = 一个目录：`graph.json`（状态图真源）+ `templates/`（录制下来的模板截图）。
 * 切换目录时引擎会热重载所有已连接设备的状态图，所以"换个游戏/换个账号的工作流"就是点一下。
 *
 * 工作区由右栏的工作区面板管（可以有多个），这里**没有工作区下拉**；
 * 新建工作流走内联表单（`WorkflowNameForm`，**要输名字**），不用 浏览器原生 prompt
 * （Tauri 的 webview 里弹不出来）。
 */
import { type ReactNode, useEffect, useState } from 'react';

import { FolderOpen } from 'lucide-react';

import { WorkflowNameForm } from '@/features/library/WorkflowNameForm';
import { baseName, parentDir, toTree } from '@/features/library/workspace-tree';
import { GhostButton } from '@/layout/PanelShell';
import { devLog, workflowCreate, workspaceTree, type WorkflowSummary } from '@/lib/rpc';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session.store';

export function ProjectMenu(): ReactNode {
  const project = useSessionStore((state) => state.project);
  const refreshProject = useSessionStore((state) => state.refreshProject);
  const switchProject = useSessionStore((state) => state.switchProject);
  const [open, setOpen] = useState(false);
  // null = 用户还没改过 → 直接跟随当前目录（派生值，不用 effect 同步）
  const [edited, setEdited] = useState<string | null>(null);
  /** 当前工作区里的工作流（点一下切换流程图） */
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  /** 内联新建工作流表单是否打开 */
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 增删改之后 +1，触发列表重拉 */
  const [reload, setReload] = useState(0);

  const root = project?.root ?? '';
  const draft = edited ?? root;
  /** 当前工作区（当前工作流的上一级目录）——「＋ 新建工作流」建在它下面 */
  const workspaceName = baseName(parentDir(root)) || '未加载';

  useEffect(() => {
    // 菜单没打开就不发 RPC（这个组件常驻顶栏，别让它一直打引擎）
    if (!open) {
      return;
    }
    let alive = true;
    // workspace.tree 给的就是"当前工作区里的工作流"（v4：没有项目那一层了）
    void workspaceTree()
      .then((result) => {
        if (alive) {
          setWorkflows([...toTree(result).workflows]);
        }
      })
      .catch((error: unknown) => {
        devLog(`工作流列表失败: ${String(error)}`);
        if (alive) {
          setWorkflows([]);
        }
      });
    return () => {
      alive = false;
    };
  }, [open, root, reload]);

  const name = baseName(root) || '未加载';

  const apply = async (dir: string): Promise<void> => {
    setBusy(true);
    await switchProject(dir);
    setBusy(false);
    setOpen(false);
  };

  const create = async (workflowName: string): Promise<void> => {
    setBusy(true);
    try {
      // 建在当前工作区根下（引擎侧决定），建完自动切过去
      await workflowCreate(workflowName);
      await refreshProject();
      setCreating(false);
      setReload((value) => value + 1);
    } catch (reason) {
      devLog(`新建工作流失败: ${String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <GhostButton
        active={open}
        onClick={() => setOpen((value) => !value)}
        title={root ? `工作流目录: ${root}` : '工作流目录还没加载'}
      >
        <FolderOpen className="size-3" />
        {name}
        {project && (
          <span className="text-faint">
            · {project.nodes} 节点/{project.recognizers} 识别器
          </span>
        )}
      </GhostButton>

      {open && (
        <div className="absolute top-7 left-0 z-30 w-[440px] rounded-sm border border-line bg-panel p-2 shadow-lg">
          <div className="mb-1 text-badge text-faint">
            切工作流（一个工作流 = 一张流程图：graph.json + templates/）
            <button
              type="button"
              className="ml-2 hover:text-fg"
              onClick={() => {
                void refreshProject();
                setReload((value) => value + 1);
              }}
            >
              刷新
            </button>
          </div>

          <div className="mb-2 flex items-center gap-1">
            <input
              value={draft}
              onChange={(event) => setEdited(event.target.value)}
              spellCheck={false}
              className="h-6 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1.5 text-badge text-fg"
              placeholder="~/Desktop/my-workflow 或任意绝对路径"
            />
            <button
              type="button"
              disabled={busy || draft.trim().length === 0}
              onClick={() => void apply(draft.trim())}
              className="h-6 shrink-0 rounded-sm bg-brand px-2 text-badge font-medium text-[#0b0d12] hover:opacity-90 disabled:opacity-50"
            >
              {busy ? '切换中…' : '切换到此目录'}
            </button>
          </div>

          <div className="mb-1 flex items-center gap-2 text-badge text-faint">
            工作区：<span className="text-dim">{workspaceName}</span>
            <button type="button" className="hover:text-fg" onClick={() => setCreating((value) => !value)}>
              ＋ 新建工作流
            </button>
          </div>

          {creating && (
            <div className="mb-1">
              <WorkflowNameForm
                title="新建工作流（建完自动切过去）"
                submitLabel="创建"
                onSubmit={(workflowName) => void create(workflowName)}
                onCancel={() => setCreating(false)}
              />
            </div>
          )}

          <div className="max-h-40 overflow-auto">
            {workflows.length === 0 && (
              <div className="px-1 py-1 text-badge text-faint">（这个工作区里还没有工作流）</div>
            )}
            {workflows.map((item) => (
              <button
                key={item.root}
                type="button"
                onClick={() => void apply(item.root)}
                className={cn(
                  'flex w-full items-center gap-2 px-1 py-0.5 text-left text-badge hover:bg-raised',
                  item.root === root && 'text-brand',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="text-faint">
                  {item.nodes} 节点 · {item.edges} 边 · {item.recognizers} 识别器
                </span>
              </button>
            ))}
          </div>

          <div className="mt-1 text-badge text-faint">
            切换后引擎会热重载所有已连接设备的状态图，运行中也不会丢当前节点。
          </div>
        </div>
      )}
    </div>
  );
}
