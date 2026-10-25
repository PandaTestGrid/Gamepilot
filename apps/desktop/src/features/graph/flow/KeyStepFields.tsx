/**
 * 按键模块：按系统（Android / 模拟器 / iOS）展示可用系统按键，
 * 支持在节点上直接切换「返回 / 主页 / 最近任务」等按键。
 */
import { type ReactNode } from 'react';

import {
  KEY_PLATFORMS,
  keysForPlatform,
  normalizeKeyForPlatform,
  resolveKeyPlatform,
  supportsKeyModule,
  type KeyPlatformId,
  type SystemKeyId,
} from '@/features/graph/flow/flow-key-params';
import { cn } from '@/lib/utils';
import type { DeviceKind } from '@/types';

export function KeyStepFields({
  params,
  deviceKind,
  onPatch,
  compact = false,
  className,
}: {
  params: Record<string, unknown>;
  deviceKind?: DeviceKind | null;
  onPatch: (patch: Record<string, unknown>) => void;
  compact?: boolean;
  className?: string;
}): ReactNode {
  const supported = supportsKeyModule(deviceKind);
  const platform = resolveKeyPlatform(params, deviceKind);
  const isWindows = platform === 'windows';
  const options = keysForPlatform(platform);
  const primaryKeys = options.filter((item) => item.primary);
  const extraKeys = options.filter((item) => !item.primary);
  const currentKey = normalizeKeyForPlatform(params.value, platform);

  const selectClass = cn(
    'nodrag nopan rounded-sm border border-line bg-canvas px-1 text-fg focus:border-brand focus:outline-none',
    compact ? 'h-5 min-w-0 flex-1 text-[11px]' : 'h-5 text-badge',
  );

  const handlePlatformChange = (nextPlatform: KeyPlatformId): void => {
    const nextValue = normalizeKeyForPlatform(params.value, nextPlatform);
    onPatch({ platform: nextPlatform, value: nextValue });
  };

  const handleKeySelect = (nextValue: SystemKeyId): void => {
    onPatch({ value: nextValue });
  };

  if (!supported) {
    return (
      <div
        className={cn('nodrag nopan space-y-1 text-badge', className)}
        onClick={(event) => event.stopPropagation()}
        data-testid="key-step-unsupported"
      >
        <p className="text-[10px] leading-snug text-pending">
          当前设备（本机窗口）没有系统导航键，不支持此按键模块。
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn('nodrag nopan space-y-1 text-badge', className)}
      onClick={(event) => event.stopPropagation()}
      data-testid="key-step-fields"
    >
      {isWindows ? (
        <p className={cn('text-[10px] leading-snug text-dim', compact && 'text-[10px]')}>
          本机窗口键盘：点常用键，其它键从下拉选（WASD / 空格 / 功能键）
        </p>
      ) : (
        <label className={cn('flex items-center gap-1 text-dim', compact && 'text-[11px]')}>
          系统
          <select
            aria-label="按键系统"
            data-testid="key-platform-select"
            className={selectClass}
            value={platform}
            onChange={(event) => handlePlatformChange(event.target.value as KeyPlatformId)}
          >
            {KEY_PLATFORMS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <div
        className={cn('flex flex-wrap gap-0.5', compact && 'text-[10px]')}
        role="group"
        aria-label="常用按键"
      >
        {primaryKeys.map((item) => (
          <button
            key={item.id}
            type="button"
            title={item.hint}
            data-testid={`key-option-${item.id}`}
            onClick={() => handleKeySelect(item.id)}
            className={cn(
              'nodrag nopan rounded-sm border px-1 py-0.5 text-center transition-colors hover:border-brand/50 hover:bg-raised',
              isWindows ? 'min-w-7 flex-none' : 'flex-1',
              currentKey === item.id ? 'border-brand bg-active text-brand' : 'border-line bg-canvas text-dim',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {extraKeys.length > 0 && (
        <label className={cn('flex items-center gap-1 text-dim', compact && 'text-[11px]')}>
          按键
          <select
            aria-label="按键选择"
            data-testid="key-value-select"
            className={selectClass}
            value={currentKey}
            onChange={(event) => handleKeySelect(event.target.value)}
          >
            {options.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
