/**
 * 运行/停止按钮：顶栏与状态图头部共用同一个组件 + 同一份 `useRunControl`。
 *
 * 为什么允许出现在两处：
 *   - 运行是**设备会话**的开关（引擎侧 `DeviceSession.running`），不是状态图的一部分，
 *     所以顶栏那处常驻（任何布局下都在），并且承担"为什么现在不能跑"的解释；
 *   - 图栏头那处是**就近**入口（图 = 脚本，运行 = 让当前设备按它跑），
 *     图栏被双击弹成独立窗口（`?pane=graph`）时，那里就是唯一的运行入口。
 * 两处只共用一个开关，不存在第二份状态（见 lib/useRunControl.ts）。
 */
import { CirclePlay, Square } from 'lucide-react';
import { type ReactNode } from 'react';

import { GhostButton } from '@/layout/PanelShell';
import { useRunControl } from '@/lib/useRunControl';

export function RunButton({ size = 'normal' }: { size?: 'normal' | 'compact' }): ReactNode {
  const run = useRunControl();
  const label = run.running ? '停止' : '运行';
  const iconClass = size === 'compact' ? 'size-3' : 'size-3.5';
  const title = run.blocker
    ? run.blocker
    : run.running
      ? `停止运行（${run.deviceName ?? '当前设备'}）`
      : `让 ${run.deviceName ?? '当前设备'} 按状态图跑（不运行时也在识别，只是不发动作）`;

  return (
    <GhostButton active={run.running} disabled={Boolean(run.blocker)} onClick={run.toggle} title={title}>
      {run.running ? <Square className={iconClass} /> : <CirclePlay className={iconClass} />}
      {label}
    </GhostButton>
  );
}
