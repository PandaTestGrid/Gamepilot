/**
 * 脚本目录（工程）菜单。
 *
 * 一个目录 = 一个脚本：`graph.json`（状态图真源）+ `templates/`（录制下来的模板截图）。
 * 切换目录时引擎会热重载所有已连接设备的状态图，所以"换个游戏/换个账号的脚本"就是点一下。
 */
import { type ReactNode, useEffect, useState } from 'react';

import { FolderOpen } from 'lucide-react';

import { GhostButton } from '@/layout/PanelShell';
import { devLog, projectList, type ProjectSummary } from '@/lib/rpc';
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
  const [busy, setBusy] = useState(false);

  const root = project?.root ?? '';
  const draft = edited ?? root;

  useEffect(() => {
    if (!root) {
      return; // 引擎还没回话（或测试里的空响应）：别拿 undefined 当路径用
    }
    // 兄弟工程（同目录下别的脚本）
    const parent = root.replace(/\/[^/]+$/, '');
    void projectList(parent)
      .then((result) => setSiblings(result.items))
      .catch((error: unknown) => devLog(`project.list 失败: ${String(error)}`));
  }, [root, open]);

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
            脚本目录（graph.json + templates/ 放这里）
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

          <div className="max-h-40 overflow-auto">
            <div className="mb-0.5 text-badge text-faint">同目录下的其它脚本</div>
            {siblings.length === 0 && <div className="px-1 py-1 text-badge text-faint">（没有别的脚本）</div>}
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
