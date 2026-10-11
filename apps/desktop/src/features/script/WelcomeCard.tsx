/**
 * 欢迎卡片：**没有项目时**给新用户明确的出路（照 IDE 欢迎页的意思）。
 *
 * 层级关系（重要）：项目 › **工作区** › 状态图；**状态图 = 任务**，
 * 工作区是状态图的上一级、管理它下面的所有状态图（任务）。
 */
import { type ReactNode, useEffect, useState } from 'react';

import { devLog, projectCreate, workspaceCreate, workspaceMkdir, workspaceTree } from '@/lib/rpc';
import { useSessionStore } from '@/stores/session.store';

export function WelcomeCard(): ReactNode {
  const switchProject = useSessionStore((state) => state.switchProject);
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof workspaceTree>>['projects']>([]);

  const load = async (): Promise<void> => {
    try {
      setProjects((await workspaceTree()).projects);
    } catch (error: unknown) {
      devLog(`目录树失败: ${String(error)}`);
    }
  };

  useEffect(() => {
    void Promise.resolve().then(load);
  }, []);

  const ask = (title: string, fallback = ''): string | null => {
    const value = window.prompt(title, fallback);
    return value && value.trim() ? value.trim() : null;
  };

  const createProject = (): void => {
    const name = ask('新项目名字（最外层，例如「游戏自动化」）');
    if (name) {
      void (async () => {
        try {
          await workspaceCreate(name);
          await load();
        } catch (reason) {
          devLog(`新建项目失败: ${String(reason)}`);
        }
      })();
    }
  };

  const createWorkspace = (): void => {
    const target = projects[0];
    const name = ask('新工作区名字（一个游戏/一个空间，例如「阴阳师」）');
    if (name && target) {
      void (async () => {
        try {
          await workspaceMkdir(target.root, name);
          await load();
        } catch (reason) {
          devLog(`新建工作区失败: ${String(reason)}`);
        }
      })();
    }
  };

  const createTask = (): void => {
    const ws = projects[0]?.workspaces[0];
    const name = ask('新任务名字（玩法，例如「斗技」）—— 一个任务 = 一张状态图');
    if (name && ws) {
      void (async () => {
        try {
          await projectCreate(name, ws.root);
          await load();
        } catch (reason) {
          devLog(`新建任务失败: ${String(reason)}`);
        }
      })();
    }
  };

  const recent = projects.flatMap((item) =>
    item.workspaces.flatMap((ws) =>
      ws.tasks.map((task) => ({
        key: task.root,
        label: `${item.name} › ${ws.name} › ${task.name}`,
        sub: `${task.nodes} 界面 · ${task.edges} 步`,
        root: task.root,
      })),
    ),
  );

  const actions: ReadonlyArray<{ title: string; hint: string; onClick: () => void }> = [
    { title: '＋ 新建项目', hint: '最外层，例如「游戏自动化」', onClick: createProject },
    { title: '＋ 新建工作区', hint: '项目 › 工作区，例如「阴阳师」', onClick: createWorkspace },
    { title: '＋ 新建任务', hint: '工作区 › 任务（= 一张状态图）', onClick: createTask },
  ];

  return (
    <div className="flex h-full flex-col gap-1.5 overflow-auto p-3">
      <div className="text-body text-fg">{projects.length === 0 ? '还没有项目' : '项目 › 工作区 › 任务'}</div>
      <div className="text-badge text-faint">
        层级：<span className="text-fg">项目</span> › <span className="text-fg">工作区</span>
        （管理它下面所有状态图）› <span className="text-fg">任务 = 状态图</span>
      </div>

      {actions.map((item) => (
        <button
          key={item.title}
          type="button"
          onClick={item.onClick}
          className="flex flex-col items-start gap-0.5 rounded-sm border border-line bg-canvas px-2 py-1.5 text-left hover:border-brand hover:bg-raised"
        >
          <span className="text-body text-fg">{item.title}</span>
          <span className="text-badge text-faint">{item.hint}</span>
        </button>
      ))}

      {recent.length > 0 && (
        <div className="mt-1">
          <div className="mb-0.5 text-badge text-faint">最近的（点一下直接进）</div>
          {recent.slice(0, 8).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => void switchProject(item.root)}
              className="flex w-full items-center gap-2 px-1 py-0.5 text-left text-badge hover:bg-raised"
            >
              <span className="min-w-0 flex-1 truncate text-fg">{item.label}</span>
              <span className="text-faint">{item.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
