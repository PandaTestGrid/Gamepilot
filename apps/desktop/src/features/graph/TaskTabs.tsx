/**
 * 任务标签栏：一个工作区里可以有多个任务，**一个任务 = 一张状态图**。
 *
 * 直接用标签展示/切换/新建，比藏在脚本菜单里直观：
 * - 每个标签 = 一个任务（脚本目录：graph.json + templates/）
 * - 点标签 = 切任务（引擎热重载所有已连接设备的状态图，运行中不丢当前节点）
 * - ＋ = 在当前工作区里新建任务（空图 + 空 templates）
 */
import { type ReactNode, useEffect, useState } from 'react';

import { devLog, projectCreate, projectList, type ProjectSummary } from '@/lib/rpc';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session.store';

export function TaskTabs(): ReactNode {
  const project = useSessionStore((state) => state.project);
  const switchProject = useSessionStore((state) => state.switchProject);
  const refreshProject = useSessionStore((state) => state.refreshProject);
  const [tasks, setTasks] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState(false);

  const root = project?.root ?? '';
  const base = root.replace(/\/[^/]+$/, '');

  useEffect(() => {
    if (!base) {
      return;
    }
    void projectList(base)
      .then((result) => setTasks(result.items))
      .catch((error: unknown) => devLog(`任务列表失败: ${String(error)}`));
  }, [base, root]);

  if (!root || tasks.length === 0) {
    return null;
  }

  const add = (): void => {
    const name = window.prompt('新任务名字（一个任务 = 一张状态图）');
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
        title="在这个工作区里新建任务（一张新的空状态图）"
        className="ml-0.5 rounded-sm border border-line px-1.5 py-0.5 text-badge text-dim hover:bg-raised hover:text-fg disabled:opacity-40"
      >
        ＋ 任务
      </button>
    </div>
  );
}
