/**
 * 脚本目录（工程）菜单。
 *
 * 一个目录 = 一个脚本：`graph.json`（状态图真源）+ `templates/`（录制下来的模板截图）。
 * 切换目录时引擎会热重载所有已连接设备的状态图，所以"换个游戏/换个账号的脚本"就是点一下。
 */
import { type ReactNode, useEffect, useState } from 'react';

import { FolderOpen } from 'lucide-react';

import { GhostButton } from '@/layout/PanelShell';
import {
  devLog,
  projectCreate,
  projectList,
  type ProjectSummary,
  workspaceCreate,
  workspaceList,
  type WorkspaceSummary,
} from '@/lib/rpc';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session.store';

export function ProjectMenu(): ReactNode {
  const project = useSessionStore((state) => state.project);
  const refreshProject = useSessionStore((state) => state.refreshProject);
  const switchProject = useSessionStore((state) => state.switchProject);
  const [open, setOpen] = useState(false);
  // null = 用户还没改过 → 直接跟随当前目录（派生值，不用 effect 同步）
  const [edited, setEdited] = useState<string | null>(null);
  const [siblings, setSiblings] = useState<ProjectSummary[]>([]);
  // 工作区（库根）与其中的任务（脚本）
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const root = project?.root ?? '';
  const draft = edited ?? root;

  useEffect(() => {
    if (!root) {
      return; // 引擎还没回话（或测试里的空响应）：别拿 undefined 当路径用
    }
    // 工作区列表（库根）+ 当前工作区里的任务
    void workspaceList()
      .then((result) => {
        setWorkspaces(result.items);
        const parent = root.replace(/\/[^/]+$/, '');
        const matched = result.items.find((item) => item.root === parent) ?? result.items[0];
        setPicked((current) => current ?? matched?.name ?? null);
        const base = result.items.find((item) => item.name === (picked ?? matched?.name))?.root ?? parent;
        return projectList(base);
      })
      .then((result) => setSiblings(result.items))
      .catch((error: unknown) => devLog(`工作区/任务列表失败: ${String(error)}`));
  }, [root, open, picked]);

  const name = root ? (root.split('/').filter(Boolean).pop() ?? root) : '未加载';

  const apply = async (dir: string): Promise<void> => {
    setBusy(true);
    await switchProject(dir);
    setBusy(false);
    setOpen(false);
  };

  return (
    <div className="relative">
      <GhostButton
        active={open}
        onClick={() => setOpen((value) => !value)}
        title={root ? `脚本目录: ${root}` : '脚本目录还没加载'}
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
            工作区 &gt; 任务（任务 = 一个脚本目录：graph.json + templates/）
            <button type="button" className="ml-2 hover:text-fg" onClick={() => void refreshProject()}>
              刷新
            </button>
          </div>

          <div className="mb-2 flex items-center gap-1">
            <input
              value={draft}
              onChange={(event) => setEdited(event.target.value)}
              spellCheck={false}
              className="h-6 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1.5 text-badge text-fg"
              placeholder="~/Desktop/my-script 或任意绝对路径"
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

          <div className="mb-2 flex items-center gap-1 text-badge text-faint">
            工作区
            <select
              value={picked ?? ''}
              onChange={(event) => setPicked(event.target.value)}
              className="h-6 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
            >
              {workspaces.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              title="新建工作区（workspaces/<名字>/）"
              onClick={() => {
                const name = window.prompt('新工作区名字');
                if (!name) {
                  return;
                }
                void (async () => {
                  try {
                    const result = await workspaceCreate(name);
                    setWorkspaces(result.items);
                    setPicked(name);
                  } catch (reason) {
                    devLog(`新建工作区失败: ${String(reason)}`);
                  }
                })();
              }}
              className="h-6 rounded-sm border border-line px-1.5 hover:text-fg"
            >
              ＋ 新建工作区
            </button>
          </div>

          <div className="max-h-40 overflow-auto">
            <div className="mb-0.5 flex items-center gap-2 text-badge text-faint">
              这个工作区里的任务（点一下切换状态图）
              <button
                type="button"
                className="hover:text-fg"
                onClick={() => {
                  const name = window.prompt('新任务名字');
                  if (!name) {
                    return;
                  }
                  const base = workspaces.find((item) => item.name === picked)?.root;
                  void (async () => {
                    try {
                      await projectCreate(name, base);
                      await refreshProject();
                      setSiblings((await projectList(base)).items);
                    } catch (reason) {
                      devLog(`新建任务失败: ${String(reason)}`);
                    }
                  })();
                }}
              >
                ＋ 新建任务
              </button>
            </div>
            {siblings.length === 0 && (
              <div className="px-1 py-1 text-badge text-faint">（这个工作区里还没有任务）</div>
            )}
            {siblings.map((item) => (
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
