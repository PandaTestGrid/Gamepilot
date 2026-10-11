/**
 * 右栏「工作区 › 项目 › 状态图」树（照 Cursor 侧边栏）。
 *
 * 规矩：
 * - 三层都**整行可点**：点项目行展开/收起，点状态图行切过去
 * - 所有行**同一高度 26px**（包括状态图行 —— 不再复用为整栏宽度设计的 ScriptRow）
 * - 行内操作（改/副/删、＋状态图）**悬停才出现**，平时不吵
 */
import { type ReactNode, useEffect, useState } from 'react';

import { Copy, Folder, FolderOpen, Pencil, Plus, Trash2 } from 'lucide-react';

import {
  devLog,
  projectCreate,
  workspaceCreate,
  workspaceMkdir,
  workspaceTree,
  type TreeProject,
} from '@/lib/rpc';
import { cn } from '@/lib/utils';
import { ScriptNameForm } from '@/features/library/ScriptNameForm';
import { useLibraryStore } from '@/stores/library.store';
import { useSessionStore } from '@/stores/session.store';

const ROW = 'flex h-[26px] w-full min-w-0 items-center gap-1 py-0 pr-2 pl-1 hover:bg-raised';

export function WorkspaceTree(): ReactNode {
  const currentRoot = useSessionStore((state) => state.project?.root ?? '');
  const switchProject = useSessionStore((state) => state.switchProject);
  const duplicate = useLibraryStore((state) => state.duplicate);
  const rename = useLibraryStore((state) => state.rename);
  const remove = useLibraryStore((state) => state.remove);
  const [groups, setGroups] = useState<TreeProject[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // 内联表单：**不能用 window.prompt** —— Tauri 的系统 webview 不实现它，点了没反应（踩过）
  const [pending, setPending] = useState<{
    kind: 'workspace' | 'project' | 'task' | 'rename' | 'duplicate';
    dir?: string;
    initial?: string;
  } | null>(null);

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

  const submit = (name: string): void => {
    const form = pending;
    setPending(null);
    if (!form) {
      return;
    }
    const done = (): void => void load();
    const fail = (reason: unknown): void => devLog(String(reason));
    if (form.kind === 'workspace') {
      void workspaceCreate(name).then(done).catch(fail);
    } else if (form.kind === 'project') {
      void workspaceMkdir(form.dir ?? '', name)
        .then(done)
        .catch(fail);
    } else if (form.kind === 'task') {
      void projectCreate(name, form.dir ?? '')
        .then(done)
        .catch(fail);
    } else if (form.kind === 'rename') {
      void rename(form.dir ?? '', name)
        .then(done)
        .catch(fail);
    } else {
      void duplicate(form.dir ?? '', name)
        .then(done)
        .catch(fail);
    }
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-auto text-badge">
      <div className={cn(ROW, 'border-b border-line')}>
        <span className="text-body text-fg">工作区</span>
        <button
          type="button"
          title="新建工作区（最外层，例如「游戏自动化」）"
          onClick={() => {
            setPending({ kind: 'workspace' });
          }}
          className="ml-auto rounded-sm border border-line px-1.5 text-dim hover:bg-raised hover:text-fg"
        >
          ＋工作区
        </button>
      </div>

      {pending && (
        <div className="border-b border-line px-1 py-1">
          <ScriptNameForm
            title={
              pending.kind === 'workspace'
                ? '新建工作区（最外层，例如「游戏自动化」）'
                : pending.kind === 'project'
                  ? '新建项目（一个游戏/一个空间，例如「阴阳师」）'
                  : pending.kind === 'task'
                    ? '新建状态图（一个状态图 = 一个脚本目录）'
                    : pending.kind === 'rename'
                      ? '重命名'
                      : '复制一份'
            }
            initial={pending.initial ?? ''}
            submitLabel={pending.kind === 'rename' ? '改名' : '创建'}
            onSubmit={submit}
            onCancel={() => setPending(null)}
          />
        </div>
      )}

      {groups.map((workspace) => (
        <div key={workspace.name} className="w-full min-w-0">
          <div className={cn(ROW, 'text-faint')}>
            <span className="shrink-0">▾</span>
            <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
          </div>

          {(workspace.workspaces ?? []).map((project) => {
            const folded = collapsed[project.root] === true;
            return (
              <div key={project.root} className="w-full min-w-0">
                <div className={cn(ROW, 'group')}>
                  {/* 整行可点：点名字就展开/收起 */}
                  <button
                    type="button"
                    onClick={() => setCollapsed((current) => ({ ...current, [project.root]: !folded }))}
                    title={folded ? '展开' : '收起'}
                    className="flex min-w-0 flex-1 items-center gap-1 pl-2 text-left"
                  >
                    <span className="w-3 shrink-0 text-faint">
                      {folded ? (
                        <Folder className="size-3 shrink-0 text-faint" />
                      ) : (
                        <FolderOpen className="size-3 shrink-0 text-faint" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-fg">{project.name}</span>
                    <span className="shrink-0 text-faint">{(project.tasks ?? []).length} 图</span>
                  </button>
                  <button
                    type="button"
                    title="在这个项目下新建状态图"
                    onClick={() => {
                      setPending({ kind: 'task', dir: project.root });
                    }}
                    className="shrink-0 rounded-sm border border-line px-1 text-dim opacity-0 group-hover:opacity-100 hover:bg-raised hover:text-fg"
                  >
                    <Plus className="size-3" /> 状态图
                  </button>
                </div>

                {!folded && (project.tasks ?? []).length > 0 && (
                  <div className="ml-3 w-full min-w-0 border-l border-line">
                    {(project.tasks ?? []).map((task) => {
                      const active = task.root === currentRoot;
                      return (
                        <div key={task.root} className={cn(ROW, 'group/row pl-2')}>
                          <button
                            type="button"
                            onClick={() => void switchProject(task.root)}
                            title={task.root}
                            className="flex min-w-0 flex-1 items-center gap-1 text-left"
                          >
                            <span className={cn('shrink-0', active ? 'text-brand' : 'text-faint')}>
                              {active ? '●' : '○'}
                            </span>
                            <span
                              className={cn('min-w-0 flex-1 truncate', active ? 'text-brand' : 'text-dim')}
                            >
                              {task.name}
                            </span>
                            <span className="shrink-0 text-faint">
                              {task.nodes}/{task.edges}
                            </span>
                          </button>
                          <span className="flex shrink-0 items-center gap-1 pr-1 opacity-0 group-hover/row:opacity-100">
                            <button
                              type="button"
                              title="重命名"
                              onClick={() => {
                                setPending({ kind: 'rename', dir: task.root, initial: task.name });
                              }}
                              className="rounded-sm border border-line px-1 text-faint hover:text-fg"
                            >
                              <Pencil className="size-3" />
                            </button>
                            <button
                              type="button"
                              title="复制一份"
                              onClick={() => {
                                setPending({
                                  kind: 'duplicate',
                                  dir: task.root,
                                  initial: `${task.name}-副本`,
                                });
                              }}
                              className="rounded-sm border border-line px-1 text-faint hover:text-fg"
                            >
                              <Copy className="size-3" />
                            </button>
                            <button
                              type="button"
                              title="删除（移到 .trash，可恢复）"
                              onClick={() => void remove(task.root).then(load)}
                              className="rounded-sm border border-line px-1 text-faint hover:text-failed"
                            >
                              <Trash2 className="size-3" />
                            </button>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          <button
            type="button"
            title="在这个工作区下新建项目（一个游戏/一个空间）"
            onClick={() => {
              setPending({ kind: 'project', dir: workspace.root });
            }}
            className={cn(ROW, 'pl-4 text-left text-faint')}
          >
            ＋项目
          </button>
        </div>
      ))}
    </div>
  );
}
