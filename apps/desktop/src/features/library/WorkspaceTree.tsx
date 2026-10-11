/**
 * 右栏「工作区」树（照 Cursor 侧边栏的结构）：
 *
 *   工作区「游戏自动化」            ← 顶部标题（可切换）
 *   ▾ 项目「阴阳师」  2 张状态图    [＋状态图]
 *       ● 斗技  3 界面 · 5 步       ← 点一下 = 切到那张状态图
 *   ▸ 项目「王者荣耀」
 *   [＋项目] … [＋工作区]
 *
 * 层级：**工作区 > 项目 > 状态图**（状态图 = 一个脚本目录）。
 */
import { type ReactNode, useEffect, useState } from 'react';

import {
  devLog,
  projectCreate,
  workspaceCreate,
  workspaceMkdir,
  workspaceTree,
  type TreeProject,
} from '@/lib/rpc';
import { useLibraryStore } from '@/stores/library.store';
import { useSessionStore } from '@/stores/session.store';

export function WorkspaceTree(): ReactNode {
  const currentRoot = useSessionStore((state) => state.project?.root ?? '');
  const switchProject = useSessionStore((state) => state.switchProject);
  const [groups, setGroups] = useState<TreeProject[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const busy = useLibraryStore((state) => state.loading);
  const duplicate = useLibraryStore((state) => state.duplicate);
  const rename = useLibraryStore((state) => state.rename);
  const remove = useLibraryStore((state) => state.remove);

  const load = async (): Promise<void> => {
    try {
      const result = await workspaceTree();
      setGroups(result?.projects ?? []);
    } catch (error: unknown) {
      devLog(`工作区树失败: ${String(error)}`);
      setGroups([]);
    }
  };

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [currentRoot]);

  const prompt2 = (title: string): string | null => {
    const value = window.prompt(title);
    return value && value.trim() ? value.trim() : null;
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto text-badge">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1">
        <span className="text-body text-fg">工作区</span>
        <button
          type="button"
          title="新建工作区（最外层，例如「游戏自动化」）"
          onClick={() => {
            const name = prompt2('新工作区名字（最外层，例如「游戏自动化」）');
            if (name) {
              void (async () => {
                try {
                  await workspaceCreate(name);
                  await load();
                } catch (reason) {
                  devLog(`新建工作区失败: ${String(reason)}`);
                }
              })();
            }
          }}
          className="ml-auto rounded-sm border border-line px-1.5 py-0.5 text-dim hover:bg-raised hover:text-fg"
        >
          ＋工作区
        </button>
      </div>

      {groups.map((workspace) => (
        <div key={workspace.name}>
          <div className="mt-1 px-2 text-faint">{workspace.name}</div>
          {(workspace.workspaces ?? []).map((project) => {
            const folded = collapsed[project.root] === true;
            return (
              <div key={project.root}>
                <div className="flex items-center gap-1 px-1 py-0.5 hover:bg-raised">
                  <button
                    type="button"
                    onClick={() => setCollapsed((current) => ({ ...current, [project.root]: !folded }))}
                    className="w-3 shrink-0 text-faint"
                    title={folded ? '展开' : '收起'}
                  >
                    {folded ? '▸' : '▾'}
                  </button>
                  <span className="min-w-0 flex-1 truncate text-fg">{project.name}</span>
                  <span className="shrink-0 text-faint">{(project.tasks ?? []).length} 张状态图</span>
                  <button
                    type="button"
                    title="在这个项目下新建状态图"
                    onClick={() => {
                      const name = prompt2('新状态图名字（一个状态图 = 一个脚本目录）');
                      if (name) {
                        void (async () => {
                          try {
                            await projectCreate(name, project.root);
                            await load();
                          } catch (reason) {
                            devLog(`新建状态图失败: ${String(reason)}`);
                          }
                        })();
                      }
                    }}
                    className="shrink-0 rounded-sm border border-line px-1 text-dim hover:bg-raised hover:text-fg"
                  >
                    ＋
                  </button>
                </div>

                {!folded &&
                  (project.tasks ?? []).map((task) => {
                    const asScript: ProjectSummary = {
                      name: task.name,
                      root: task.root,
                      nodes: task.nodes,
                      edges: task.edges,
                      recognizers: task.recognizers,
                    };
                    return (
                      <ScriptRow
                        key={task.root}
                        item={asScript}
                        current={task.root === currentRoot}
                        busy={busy}
                        onSwitch={() => void switchProject(task.root)}
                        onDuplicate={(name) => void duplicate(task.root, name).then(load)}
                        onRename={(name) => void rename(task.root, name).then(load)}
                        onRemove={() => void remove(task.root).then(load)}
                      />
                    );
                  })}
              </div>
            );
          })}
          <button
            type="button"
            title="在这个工作区下新建项目（一个游戏/一个空间）"
            onClick={() => {
              const name = prompt2('新项目名字（一个游戏/一个空间，例如「阴阳师」）');
              if (name) {
                void (async () => {
                  try {
                    await workspaceMkdir(workspace.root, name);
                    await load();
                  } catch (reason) {
                    devLog(`新建项目失败: ${String(reason)}`);
                  }
                })();
              }
            }}
            className="w-full px-2 py-0.5 text-left text-faint hover:bg-raised hover:text-fg"
          >
            ＋项目
          </button>
        </div>
      ))}
    </div>
  );
}
