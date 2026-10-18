/**
 * 设备弹层里的一行。
 *
 * 交互按状态分开（这是之前最乱的地方）：
 *   - **当前设备**：左侧一条 brand 竖线 + 「当前」，点它不再做任何事；
 *   - **已连接（不是当前）**：点行 = **切换过去**（多设备时最常用的动作），右侧 `断开` 才是断开；
 *   - **未连接**：点行 = 连接；右侧常显 `连接`（不再只在 hover 时出现 —— 摸不到按钮就很难用）；
 *   - **连接中**：转圈，不可点；
 *   - **失败**：行内展开原因 + 修复建议 + `重试`。
 */
import { RefreshCw } from 'lucide-react';
import { type ReactNode } from 'react';

import { kindLabel, statusTone } from '@/features/device/device-kinds';
import { StatusDot } from '@/layout/PanelShell';
import { formatResolution } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { DeviceRuntime } from '@/types';

export function DeviceRow({
  device,
  active,
  onActivate,
  onConnect,
  onDisconnect,
}: {
  device: DeviceRuntime;
  active: boolean;
  onActivate: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}): ReactNode {
  const failed = device.status === 'failed';
  const connected = device.status === 'connected';
  const connecting = device.status === 'connecting';

  const primary = (): void => {
    if (connecting) {
      return;
    }
    if (connected) {
      onActivate();
      return;
    }
    onConnect();
  };

  return (
    <div className={cn('group border-b border-line/60', active && 'bg-active/60')}>
      <div className="flex h-8 items-center gap-2 pr-2 pl-1.5 hover:bg-raised">
        {/* 当前设备的竖线：多设备时一眼看出"操作的是哪台" */}
        <span className={cn('h-4 w-[2px] shrink-0', active ? 'bg-brand' : 'bg-transparent')} />

        <button
          type="button"
          onClick={primary}
          disabled={connecting}
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
          title={
            connected
              ? active
                ? `${device.name} 就是当前设备`
                : `切到 ${device.name}（状态图 / 事件 / 控制都跟着切）`
              : `连接 ${device.name}`
          }
        >
          <StatusDot tone={statusTone(device.status)} />
          <span className="min-w-0 truncate text-body">{device.name}</span>
          <span className="shrink-0 rounded-sm border border-line px-1 text-badge text-faint">
            {kindLabel(device.kind)}
          </span>
          {active && <span className="shrink-0 text-badge text-brand">当前</span>}
        </button>

        <span className="w-20 shrink-0 text-right text-badge text-dim">
          {failed ? '不可用' : formatResolution(device.resolution)}
        </span>

        {connected ? (
          <button
            type="button"
            onClick={onDisconnect}
            className="w-12 shrink-0 text-right text-badge text-dim hover:text-failed"
            title={`断开 ${device.name}`}
          >
            断开
          </button>
        ) : connecting ? (
          <span className="flex w-12 shrink-0 items-center justify-end text-badge text-pending">
            <RefreshCw className="size-3 animate-spin" />
          </span>
        ) : (
          <button
            type="button"
            onClick={onConnect}
            className="w-12 shrink-0 text-right text-badge text-brand hover:underline"
          >
            {failed ? '重试' : '连接'}
          </button>
        )}
      </div>

      {failed && (
        <div className="flex items-center gap-2 bg-raised/40 px-2 py-1.5">
          <StatusDot tone="failed" />
          <span className="flex-1 text-badge text-failed">
            {device.error ?? '连接失败'}
            {device.suggestedFix ? ` · ${device.suggestedFix}` : ''}
          </span>
          <button type="button" onClick={onConnect} className="shrink-0 text-badge text-brand">
            重试
          </button>
        </div>
      )}
    </div>
  );
}
