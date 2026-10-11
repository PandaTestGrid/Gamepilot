/**
 * 设备控制条：贴在投屏画面**下面**那条 28px 的横条（返回 / 桌面 / 最近任务 / 电源 + 控制开关 + 录操作）。
 *
 * 为什么从面板头搬下来：
 *   - 这些键是"对设备做什么"，和画面是一体的；放面板头时和「框选 / 点选 / 多开」混在一排，
 *     面板一窄就换行成两排，最常用的返回键被挤到第二行；
 *   - 投屏是纵向可拖的：控制条跟着画面那一格走（`SCREEN_LAYOUT` 的 view 面板），
 *     拖高识别读数时控制条不会被推走。
 *
 * 数据全部走 store（ui.store 的 controlMode / recordActionMode、session.store 的 pressKey / recordStep），
 * 所以它自己不持有状态，换设备也不会串。
 */
import { CircleDot, House, Layers, MousePointerClick, Power, Undo2 } from 'lucide-react';
import { type ReactNode } from 'react';

import { GhostButton } from '@/layout/PanelShell';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

const KEYS = [
  { key: 'back', label: '返回', icon: <Undo2 className="size-3" />, hint: '返回键' },
  { key: 'home', label: '桌面', icon: <House className="size-3" />, hint: '回到桌面（Home）' },
  { key: 'recents', label: '最近任务', icon: <Layers className="size-3" />, hint: '最近任务' },
  { key: 'power', label: '电源', icon: <Power className="size-3" />, hint: '电源键（锁屏/亮屏）' },
] as const;

export function DeviceControls({
  deviceId,
  deviceName,
}: {
  deviceId: string;
  deviceName: string;
}): ReactNode {
  const ready = useSessionStore((state) => Boolean(state.ready[deviceId]));
  const pressKey = useSessionStore((state) => state.pressKey);
  const recordStep = useSessionStore((state) => state.recordStep);
  const controlMode = useUiStore((state) => state.controlMode);
  const toggleControl = useUiStore((state) => state.toggleControl);
  const recordActionMode = useUiStore((state) => state.recordActionMode);
  const toggleRecordAction = useUiStore((state) => state.toggleRecordAction);

  // 状态行里的一句话要短（长了会把控制条挤成两排），完整原因在按钮的 title 里
  const blocked = ready ? null : `${deviceName} 未连接 · 先连设备`;

  return (
    <div
      data-testid="device-controls"
      // @container：窄面板时右侧那句提示自动让位（否则会换行成两排，把这格吃掉 46px 高）
      className="@container flex min-h-7 shrink-0 flex-wrap items-center gap-x-1 gap-y-0.5 border border-line bg-panel px-2 py-0.5"
    >
      <GhostButton
        active={controlMode}
        onClick={toggleControl}
        title={
          controlMode
            ? '控制已开启：点击画面=轻触，拖拽=滑动（录制时自动让位）'
            : '控制已关闭：画面上的操作只用于框选/点选录制'
        }
      >
        <MousePointerClick className="size-3" />
        控制
      </GhostButton>

      <span className="mx-0.5 h-3 w-px bg-line" />

      {KEYS.map((item) => (
        <GhostButton
          key={item.key}
          disabled={Boolean(blocked)}
          onClick={() => void pressKey(deviceId, item.key)}
          title={blocked ?? item.hint}
        >
          {item.icon}
          {item.label}
        </GhostButton>
      ))}

      <span className="mx-0.5 h-3 w-px bg-line" />

      <GhostButton
        active={recordActionMode}
        disabled={Boolean(blocked)}
        onClick={toggleRecordAction}
        title={
          blocked ??
          (recordActionMode
            ? '正在录操作：画面上的每次点击/滑动都会变成脚本里的一步（再点一下关闭）'
            : '录操作：把点击/滑动录成脚本里的一步')
        }
      >
        <CircleDot className="size-3" />
        录操作
      </GhostButton>

      {recordActionMode &&
        [0.5, 1, 3].map((seconds) => (
          <button
            key={seconds}
            type="button"
            disabled={Boolean(blocked)}
            onClick={() => void recordStep(deviceId, { type: 'wait', seconds })}
            className="h-5 rounded-sm border border-line px-1 text-badge text-dim hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            title={blocked ?? `录一步"等待 ${seconds}s"`}
          >
            +等{seconds}s
          </button>
        ))}

      <span className="flex-1" />

      <span
        className={cn(
          'truncate text-badge',
          // 没连上时无论如何都要留着原因；连上了就只在够宽时显示操作提示
          blocked ? 'text-pending' : 'hidden text-faint @[560px]:inline',
        )}
      >
        {blocked ?? (controlMode ? '点画面=轻触 · 拖拽=滑动' : '控制已关：画面只用于框选/点选')}
      </span>
    </div>
  );
}
