/**
 * 任务标签栏：一个工作区里可以有多个任务，**一个任务 = 一张状态图**。
 *
 * 直接用标签展示/切换/新建，比藏在脚本菜单里直观：
 * - 每个标签 = 一个任务（脚本目录：graph.json + templates/）
 * - 点标签 = 切任务（引擎热重载所有已连接设备的状态图，运行中不丢当前节点）
 * - ＋ = 在当前工作区里新建任务（空图 + 空 templates）
 */
import { type ReactNode, useEffect, useState } from 'react';

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

export function TaskTabs(): ReactNode {
  const project = useSessionStore((state) => state.project);
  const switchProject = useSessionStore((state) => state.switchProject);
  const refreshProject = useSessionStore((state) => state.refreshProject);
  const [tasks, setTasks] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState(false);
  // 工作区 = 上一级目录：切工作区 = 换一批脚本（状态图）
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspace, setWorkspace] = useState<string>('');

  const root = project?.root ?? '';
  const base = root.replace(/\/[^/]+$/, '');

  useEffect(() => {
    void workspaceList()
      .then((result) => {
        setWorkspaces(result.items);
        // 当前工作区 = 当前脚本所在的那个库根
        const matched = result.items.find((item) => item.root === root.replace(/\/[^/]+$/, ''));
        setWorkspace(matched?.name ?? result.items[0]?.name ?? '');
      })
      .catch((error: unknown) => devLog(`工作区列表失败: ${String(error)}`));
    // 依赖 root：引擎握手完成、或切换脚本后再拉一次（挂载时引擎可能还没起来，踩过）
  }, [root]);

  useEffect(() => {
    if (!base) {
      return;
    }
    void projectList(base)
      .then((result) => setTasks(result.items))
      .catch((error: unknown) => devLog(`脚本列表失败: ${String(error)}`));
  }, [base, root]);

  if (!root || tasks.length === 0) {
    return null;
  }

  const add = (): void => {
    const name = window.prompt('新脚本名字（一个脚本 = 一张状态图）');
    if (!name) {
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        await projectCreate(name, base);
        await refreshProject();
        setTasks((await projectList(base)).items);
      } catch (reason) {
        devLog(`新建任务失败: ${String(reason)}`);
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-1 py-0.5">
      {/* 一级：工作区（换工作区 = 换下面这一批脚本/状态图） */}
      <select
        value={workspace}
        title="工作区：一个工作区里放多个脚本（脚本 = 一张状态图）"
        onChange={(event) => {
          const picked = workspaces.find((item) => item.name === event.target.value);
          if (!picked) {
            return;
          }
          setWorkspace(picked.name);
          void (async () => {
            try {
              const items = await projectList(picked.root);
              setTasks(items.items);
              const first = items.items[0];
              if (first) {
                await switchProject(first.root);
              }
            } catch (reason) {
              devLog(`切工作区失败: ${String(reason)}`);
            }
          })();
        }}
        className="h-5 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
      >
        {workspaces.map((item) => (
          <option key={item.name} value={item.name}>
            工作区：{item.name}
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
              setWorkspace(name);
            } catch (reason) {
              devLog(`新建工作区失败: ${String(reason)}`);
            }
          })();
        }}
        className="rounded-sm border border-line px-1.5 py-0.5 text-badge text-dim hover:bg-raised hover:text-fg"
      >
        ＋工作区
      </button>
      <span className="mx-1 h-3 w-px bg-line" />

      {tasks.map((item) => {
        const active = item.root === root;
        return (
          <button
            key={item.root}
            type="button"
            title={`${item.root}\n${item.nodes} 界面 · ${item.edges} 步 · ${item.recognizers} 识别器`}
            onClick={() => {
              if (!active) {
                void switchProject(item.root);
              }
            }}
            className={cn(
              'flex items-center gap-1 rounded-t-sm border border-b-0 px-2 py-0.5 text-badge',
              active
                ? 'border-line bg-raised text-fg'
                : 'border-transparent text-dim hover:bg-raised hover:text-fg',
            )}
          >
            {item.name}
            <span className="text-faint">
              {item.nodes}/{item.edges}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        disabled={busy}
        onClick={add}
        title="在这个工作区里新建脚本（一张新的空状态图）"
        className="ml-0.5 rounded-sm border border-line px-1.5 py-0.5 text-badge text-dim hover:bg-raised hover:text-fg disabled:opacity-40"
      >
        ＋脚本
      </button>
    </div>
  );
}
