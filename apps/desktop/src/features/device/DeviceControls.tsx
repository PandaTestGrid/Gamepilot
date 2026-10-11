/**
 * 设备控制条：贴在投屏画面**下面**那条 28px 横条 —— **只放设备按键**
 * （返回 / 桌面 / 最近任务 / 电源，按平台适配，见 `nav-keys.ts`）。
 *
 * 为什么「控制」「录操作」不在这里（用户反馈后搬走的）：
 *   它们是**这个 App 的模式开关**，和"手机上有什么键"不是一类东西；
 *   混在一排里会让人以为它们是手机上的功能。现在开关在面板头（画面栏标题那一行），
 *   这条只剩"对设备按一下键"，语义干净。
 *
 * 为什么按键留在画面下面（而不是也搬到面板头）：
 *   它们是"对这台设备做什么"，和画面是一体的；面板头只留面板自己的工具 + 模式开关。
 *   投屏那一格是纵向可拖的，控制条跟着画面走（`SCREEN_LAYOUT` 的 view 面板），
 *   拖高识别读数时不会被推走。
 *
 * 数据全走 store（session.store 的 pressKey），所以它自己不持有状态，换设备也不会串。
 */
import { House, Layers, Undo2 } from 'lucide-react';
import { type ReactNode } from 'react';

import { navKeysFor, type NavKeyId } from '@/features/device/nav-keys';
import { GhostButton } from '@/layout/PanelShell';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { DeviceKind } from '@/types';

const ICONS: Record<NavKeyId, ReactNode> = {
  back: <Undo2 className="size-3" />,
  home: <House className="size-3" />,
  recents: <Layers className="size-3" />,
};

export function DeviceControls({
  deviceId,
  deviceName,
  kind,
}: {
  deviceId: string;
  deviceName: string;
  /** 哪台设备：实体键随平台不同（iOS 只有主页，macOS 窗口一个都没有） */
  kind: DeviceKind;
}): ReactNode {
  const ready = useSessionStore((state) => Boolean(state.ready[deviceId]));
  const pressKey = useSessionStore((state) => state.pressKey);
  const controlMode = useUiStore((state) => state.controlMode);
  const keys = navKeysFor(kind);

  // 状态行里的一句话要短（长了会把控制条挤成两排），完整原因在按钮的 title 里
  const blocked = ready ? null : `${deviceName} 未连接 · 先连设备`;
  // 没有实体键的平台（macOS 本机窗口）：说清这条为什么是空的，别让人以为坏了
  const emptyHint = keys.length === 0 ? `${deviceName} 没有实体导航键（用画面上的点击/滑动操作）` : null;

  return (
    <div
      data-testid="device-controls"
      // 三栏网格：左 1fr · 中间按键 · 右 1fr 放提示 —— 两侧等宽，所以按键是**真居中**
      // （flex + justify-center 会被右边那句提示顶偏）。minmax(0,1fr) 让提示在窄面板里截断，
      // 而不是把按键挤出去；@container 控制提示什么时候让位。
      className="@container grid min-h-7 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-2 border border-line bg-panel px-2 py-0.5"
    >
      <span aria-hidden="true" />

      <span className="flex items-center">
        {keys.map((item, index) => (
          <span key={item.id} className="flex items-center">
            {index > 0 && <span className="mx-1 h-3 w-px bg-line" />}
            <GhostButton
              disabled={Boolean(blocked)}
              onClick={() => void pressKey(deviceId, item.id)}
              title={blocked ?? item.hint}
            >
              {ICONS[item.id]}
              {item.label}
            </GhostButton>
          </span>
        ))}
      </span>

      <span
        className={cn(
          'min-w-0 truncate text-right text-badge',
          // 没连上时无论如何都要留着原因；连上了就只在够宽时显示操作提示
          blocked || emptyHint ? 'text-pending' : 'hidden text-faint @[620px]:inline',
        )}
      >
        {blocked ?? emptyHint ?? (controlMode ? '点画面=轻触 · 拖拽=滑动' : '控制已关：画面只用于框选/点选')}
      </span>
    </div>
  );
}
