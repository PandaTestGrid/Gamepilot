/**
 * 脚本库面板（右栏第一个 Tab）：**多张状态图就是多个脚本目录**。
 *
 * 一个目录 = 一张图：`graph.json`（界面/步骤）+ `templates/`（录制的模板截图）。
 * 所以"再做一个日常任务的脚本"= 在这里点「+ 新建」— 新目录立刻成为当前脚本，
 * 录制/运行/事件都会跟着它走；老的脚本原封不动留在库里。
 *
 * 引擎是唯一真源：列表由 `project.list` 拉取，每次增删改都用引擎返回的整份列表刷新
 * （见 stores/library.store.ts）。面板不做"本地乐观更新"，避免和磁盘上的真实情况不一致。
 */
import { Plus, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { ScriptNameForm } from '@/features/library/ScriptNameForm';
import { ScriptRow } from '@/features/library/ScriptRow';
import { WelcomeCard } from '@/features/script/WelcomeCard';
import { GhostButton } from '@/layout/PanelShell';
import { cn } from '@/lib/utils';
import { isUnknownMethodError } from '@/lib/engine-methods';
import { useEngineStore } from '@/stores/engine.store';
import { useLibraryStore } from '@/stores/library.store';
import { useSessionStore } from '@/stores/session.store';

type FormState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'rename'; readonly dir: string; readonly name: string };

export function ScriptLibraryPane(): ReactNode {
  const items = useLibraryStore((state) => state.items);
  const loading = useLibraryStore((state) => state.loading);
  const error = useLibraryStore((state) => state.error);
  const refresh = useLibraryStore((state) => state.refresh);
  const create = useLibraryStore((state) => state.create);
  const duplicate = useLibraryStore((state) => state.duplicate);
  const rename = useLibraryStore((state) => state.rename);
  const remove = useLibraryStore((state) => state.remove);

  const currentRoot = useSessionStore((state) => state.project?.root ?? '');
  const switchProject = useSessionStore((state) => state.switchProject);
  const engineStatus = useEngineStore((state) => state.status);
  const missingMethods = useEngineStore((state) => state.missingMethods);
  const restartEngine = useEngineStore((state) => state.restart);
  // 引擎是旧进程：错误里会出现 -32601 / 未知方法，或缺方法表校验没通过
  const staleEngine = missingMethods.length > 0 || isUnknownMethodError(error);

  const [form, setForm] = useState<FormState>({ kind: 'closed' });
  const [busy, setBusy] = useState(false);

  // 挂载即拉一次；引擎是后起来的（首次启动 / 点了重试），ready 时再拉一次 ——
  // 否则首屏那次失败会让面板一直空着，用户只能自己去点「刷新」
  useEffect(() => {
    if (engineStatus === 'ready') {
      void refresh();
    }
  }, [engineStatus, refresh]);

  // 切脚本后引擎会广播 project.changed，列表本身不变（目录没动），所以不必重拉
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (task: () => Promise<boolean>): Promise<void> => {
    setBusy(true);
    const ok = await task();
    setBusy(false);
    if (ok) {
      setForm({ kind: 'closed' });
    }
  };

  // 没有当前脚本（新用户/还没切过）→ 显示欢迎卡片：新建项目/工作区/任务 + 最近的
  if (!currentRoot) {
    return <WelcomeCard />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-6 shrink-0 items-center gap-1 border-b border-line px-2">
        <GhostButton
          onClick={() => setForm(form.kind === 'create' ? { kind: 'closed' } : { kind: 'create' })}
          title="新建一张状态图（= 新建脚本目录，含 templates/），并切过去"
        >
          <Plus className="size-3" />
          新建
        </GhostButton>
        <GhostButton onClick={() => void refresh()} title="重新读磁盘上的脚本列表">
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          刷新
        </GhostButton>
        <span className="flex-1" />
        <span className="text-badge text-faint">{items.length} 个脚本</span>
      </div>

      {form.kind === 'create' && (
        <ScriptNameForm
          title="新建脚本（一个目录 = 一张状态图）"
          submitLabel="创建并切换"
          onSubmit={(name) => void run(() => create(name))}
          onCancel={() => setForm({ kind: 'closed' })}
        />
      )}

      {form.kind === 'rename' && (
        <ScriptNameForm
          title={`重命名「${form.name}」`}
          initial={form.name}
          submitLabel="重命名"
          onSubmit={(name) => void run(() => rename(form.dir, name))}
          onCancel={() => setForm({ kind: 'closed' })}
        />
      )}

      {error && (
        <div className="shrink-0 border-b border-line px-2 py-1 text-badge text-failed">
          读不到脚本库：{error}
          <button type="button" className="ml-2 text-dim hover:text-fg" onClick={() => void refresh()}>
            重试
          </button>
          {/* 最常见的原因：引擎是应用启动时拉起的旧进程（不认识 project.create）→ 一键重启 */}
          {staleEngine && (
            <button
              type="button"
              className="ml-2 text-failed hover:text-fg"
              title="停掉正在跑的引擎进程、拉起新的（会断开当前设备连接，重连即可）"
              onClick={() => void restartEngine()}
            >
              重启引擎
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {items.map((item) => (
          <ScriptRow
            key={item.root}
            item={item}
            current={item.root === currentRoot}
            busy={busy}
            onSwitch={() => void switchProject(item.root)}
            onDuplicate={() => {
              setForm({ kind: 'closed' });
              void run(() => duplicate(item.root, `${item.name}-副本`));
            }}
            onRename={() => setForm({ kind: 'rename', dir: item.root, name: item.name })}
            onRemove={() => void run(() => remove(item.root))}
          />
        ))}
        {items.length === 0 && !error && (
          <div className="px-2 py-4 text-badge text-faint">
            {loading ? '正在读取脚本列表…' : '库里还没有脚本 · 点上面「新建」开一张图'}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line px-2 py-1 text-badge text-faint">
        当前：<span className="text-dim">{currentRoot || '未加载'}</span>
        <div className="mt-0.5">
          删除是移到库根的 .trash/（可恢复）；切脚本会热重载所有已连接设备的状态图，运行中的不丢当前节点。
        </div>
      </div>
    </div>
  );
}
