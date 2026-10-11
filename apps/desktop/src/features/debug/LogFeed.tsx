/**
 * 日志流：引擎日志（`engine.log`）与界面日志（devLog）混排，按级别过滤。
 *
 * 用途很具体：脚本跑飞了的时候，先看这条时间线里"引擎说了什么"，
 * 而不是去翻终端（Tauri 应用日志）——那个在打包后根本看不到。
 */
import { Trash2 } from 'lucide-react';
import { type ReactNode, useMemo, useRef, useEffect } from 'react';

import { GhostButton } from '@/layout/PanelShell';
import { cn } from '@/lib/utils';
import { filterLogs, levelTone, sourceLabel, useLogStore } from '@/stores/log.store';
import type { LogLevel } from '@/lib/log-bus';

const LEVELS: Array<{ id: LogLevel; label: string }> = [
  { id: 'debug', label: '全部' },
  { id: 'info', label: '信息+' },
  { id: 'warning', label: '警告+' },
  { id: 'error', label: '错误' },
];

export function LogFeed(): ReactNode {
  const entries = useLogStore((state) => state.entries);
  const minLevel = useLogStore((state) => state.minLevel);
  const setMinLevel = useLogStore((state) => state.setMinLevel);
  const clear = useLogStore((state) => state.clear);

  const rows = useMemo(() => filterLogs(entries, minLevel), [entries, minLevel]);

  // 有新日志就滚到底（跟终端一样），但只在用户本来就贴着底部时滚，别打断回看
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useEffect(() => {
    const node = scroller.current;
    if (node && stickToBottom.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [rows.length]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-6 shrink-0 items-center gap-1 border-b border-line px-2">
        {LEVELS.map((item) => (
          <GhostButton key={item.id} active={minLevel === item.id} onClick={() => setMinLevel(item.id)}>
            {item.label}
          </GhostButton>
        ))}
        <span className="flex-1" />
        <span className="text-badge text-faint">
          {rows.length} / {entries.length} 条
        </span>
        <GhostButton onClick={clear} title="清空日志（只清界面里的，不删引擎的 stderr）">
          <Trash2 className="size-3" />
          清空
        </GhostButton>
      </div>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-auto font-mono"
        onScroll={(event) => {
          const node = event.currentTarget;
          stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        }}
      >
        {rows.length === 0 && (
          <div className="px-3 py-6 text-center text-badge text-faint">
            还没有日志 · 引擎的日志会经 `engine.log` 通知出现在这里
          </div>
        )}
        {rows.map((entry) => (
          <div key={entry.id} className="flex items-start gap-2 px-2 py-0.5 text-badge hover:bg-raised">
            <span className="w-16 shrink-0 text-faint">
              {new Date(entry.ts * 1000).toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
            <span className="w-8 shrink-0 text-faint">{sourceLabel(entry.source)}</span>
            <span className={cn('w-14 shrink-0', levelTone(entry.level))}>{entry.level}</span>
            <span className="w-40 shrink-0 truncate text-faint" title={entry.logger}>
              {entry.logger}
            </span>
            <span className="min-w-0 flex-1 break-all text-dim">{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
