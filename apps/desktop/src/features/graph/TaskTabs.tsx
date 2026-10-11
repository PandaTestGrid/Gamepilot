/**
 * 三级切换：**项目 › 工作区 › 任务**（任务 = 一张状态图）。
 *
 * 例子：项目「游戏自动化」> 工作区「阴阳师」> 任务「斗技 / 百鬼」。
 * 切换项目 → 换工作区列表；切换工作区 → 换任务标签；点任务标签 → 换状态图。
 *
 * 目录树由引擎的 workspace.tree 给出（它会兼容"库根下直接是脚本"的老布局）。
 */
import { Component, type ReactNode, useEffect, useState } from 'react';

import { devLog, projectCreate, workspaceTree, type TreeProject, type TreeWorkspace } from '@/lib/rpc';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session.store';

const SELECT = 'h-5 rounded-sm border border-line bg-canvas px-1 text-badge text-fg';

/**
 * 兜底：这条栏拉不到目录树（引擎没起来、测试环境没有引擎）时**什么都不显示**，
 * 绝不把异常抛给上层 —— 之前就是它抛错连累了 3 个已有测试和一个真实场景。
 */
class SafeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    devLog(`任务标签栏出错（已忽略）: ${String(error)}`);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function TaskTabs(): ReactNode {
  return (
    <SafeBoundary>
      <TaskTabsInner />
    </SafeBoundary>
  );
}

function TaskTabsInner(): ReactNode {
  const project = useSessionStore((state) => state.project);
  const switchProject = useSessionStore((state) => state.switchProject);
  const refreshProject = useSessionStore((state) => state.refreshProject);
  const [projects, setProjects] = useState<TreeProject[]>([]);
  const [busy, setBusy] = useState(false);

  const root = project?.root ?? '';

  const load = async (): Promise<void> => {
    try {
      setProjects((await workspaceTree()).projects);
    } catch (error: unknown) {
      devLog(`目录树失败: ${String(error)}`);
    }
  };

  useEffect(() => {
    // 异步拉：不要同步 setState（会触发级联渲染，lint 会拦）
    void Promise.resolve().then(load);
    // 依赖 root：引擎握手完成或切换任务后再拉一次
  }, [root]);

  /** 当前所在的 项目 / 工作区（由当前任务目录反推，避免另存一份状态）。 */
  const currentProject =
    projects.find((item) =>
      item.workspaces.some((ws) => root === ws.root || root.startsWith(`${ws.root}/`)),
    ) ?? projects[0];
  const currentWorkspace =
    currentProject?.workspaces.find((ws) => root === ws.root || root.startsWith(`${ws.root}/`)) ??
    currentProject?.workspaces[0];

  if (!root || !currentProject || (currentProject.workspaces ?? []).length === 0) {
    return null;
  }

  const go = (dir: string | undefined): void => {
    if (!dir || dir === root) {
      return;
    }
    void switchProject(dir);
  };

  const addTask = (): void => {
    const name = window.prompt('新任务名字（一个任务 = 一张状态图）');
    if (!name || !currentWorkspace) {
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        await projectCreate(name, currentWorkspace.root);
        await refreshProject();
        await load();
      } catch (reason) {
        devLog(`新建任务失败: ${String(reason)}`);
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="flex items-center gap-0.5">
      {/* 一级：项目 */}
      <select
        value={currentProject.name}
        title="项目：最外层（比如「游戏自动化」）"
        onChange={(event) => {
          const next = projects.find((item) => item.name === event.target.value);
          go(next?.workspaces[0]?.tasks[0]?.root);
        }}
        className={SELECT}
      >
        {projects.map((item) => (
          <option key={item.name} value={item.name}>
            项目：{item.name}
          </option>
        ))}
      </select>

      {/* 二级：工作区 */}
      <select
        value={currentWorkspace?.name ?? ''}
        title="工作区：一个游戏/一个空间（比如「阴阳师」「王者荣耀」）"
        onChange={(event) => {
          const next: TreeWorkspace | undefined = currentProject.workspaces.find(
            (item) => item.name === event.target.value,
          );
          go(next?.tasks[0]?.root);
        }}
        className={SELECT}
      >
        {(currentProject.workspaces ?? []).map((item) => (
          <option key={item.name} value={item.name}>
            工作区：{item.name}
          </option>
        ))}
      </select>

      <span className="mx-1 h-3 w-px bg-line" />

      {/* 三级：任务 = 状态图（标签） */}
      {(currentWorkspace?.tasks ?? []).map((item) => {
        const active = item.root === root;
        return (
          <button
            key={item.root}
            type="button"
            title={`${item.root}\n${item.nodes} 界面 · ${item.edges} 步 · ${item.recognizers} 识别器`}
            onClick={() => go(item.root)}
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
        onClick={addTask}
        title="在当前工作区里新建任务（一张新的空状态图）"
        className="ml-0.5 rounded-sm border border-line px-1.5 py-0.5 text-badge text-dim hover:bg-raised hover:text-fg disabled:opacity-40"
      >
        ＋ 任务
      </button>
    </div>
  );
}
