/**
 * 控制台：直接手发一条 RPC 看返回。
 *
 * 调试"到底哪一层坏了"时最省时间的一个工具：
 * 界面上的按钮没反应 → 在这里发 `engine.ping` / `device.list` / `graph.get`，
 * 一眼分清是引擎没起来、设备没连上，还是某个面板自己写错了参数。
 *
 * 只做只读排查，不提供"随手改图"的命令（写操作都在界面上有对应的、会校验的入口）。
 */
import { type ReactNode, useRef, useState } from 'react';

import { GhostButton } from '@/layout/PanelShell';
import { devLog, rpc } from '@/lib/rpc';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';

interface ConsoleLine {
  readonly id: number;
  readonly kind: 'input' | 'ok' | 'error';
  readonly text: string;
}

const QUICK: Array<{ method: string; label: string; needsDevice?: boolean }> = [
  { method: 'engine.ping', label: 'engine.ping' },
  { method: 'project.get', label: 'project.get' },
  { method: 'device.list', label: 'device.list' },
  { method: 'graph.get', label: 'graph.get', needsDevice: true },
  { method: 'device.status', label: 'device.status', needsDevice: true },
];

export function ConsolePane(): ReactNode {
  const activeId = useDeviceStore((state) => state.activeId);
  const [method, setMethod] = useState('engine.ping');
  const [params, setParams] = useState('{}');
  const [lines, setLines] = useState<readonly ConsoleLine[]>([]);
  const nextId = useRef(1);

  const push = (kind: ConsoleLine['kind'], text: string): void => {
    setLines((current) => [...current.slice(-99), { id: nextId.current++, kind, text }]);
  };

  const send = async (name: string, raw: string): Promise<void> => {
    let parsed: Record<string, unknown> = {};
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (error) {
        push('error', `参数不是合法 JSON: ${String(error)}`);
        return;
      }
    }
    if (
      'deviceId' in parsed === false &&
      name !== 'engine.ping' &&
      name !== 'device.list' &&
      name !== 'project.get'
    ) {
      // 大多数方法都要 deviceId：不填就补当前设备，省得每次手打
      if (activeId) {
        parsed = { deviceId: activeId, ...parsed };
      }
    }
    push('input', `${name} ${JSON.stringify(parsed)}`);
    try {
      const result = await rpc<unknown>(name, parsed);
      push('ok', JSON.stringify(result, null, 2));
      devLog(`控制台: ${name} 成功`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      push('error', message);
      devLog(`控制台: ${name} 失败 ${message}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-6 shrink-0 flex-wrap items-center gap-1 border-b border-line px-2">
        <span className="text-badge text-faint">快捷</span>
        {QUICK.map((item) => (
          <GhostButton
            key={item.method}
            disabled={item.needsDevice && !activeId}
            title={item.needsDevice && !activeId ? '先连接一台设备' : `发送 ${item.method}`}
            onClick={() => {
              setMethod(item.method);
              void send(item.method, item.needsDevice ? '{}' : '{}');
            }}
          >
            {item.label}
          </GhostButton>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono">
        {lines.length === 0 && (
          <div className="py-6 text-center text-badge text-faint">
            发一条 RPC 看看返回值 · 参数留空 = 用当前设备（{activeId || '未连接设备'}）
          </div>
        )}
        {lines.map((line) => (
          <pre
            key={line.id}
            className={cn(
              'whitespace-pre-wrap break-all text-badge',
              line.kind === 'input' && 'text-brand',
              line.kind === 'ok' && 'text-dim',
              line.kind === 'error' && 'text-failed',
            )}
          >
            {line.kind === 'input' ? '› ' : line.kind === 'error' ? '✗ ' : '✓ '}
            {line.text}
          </pre>
        ))}
      </div>

      <div className="flex h-7 shrink-0 items-center gap-1 border-t border-line px-2">
        <input
          value={method}
          onChange={(event) => setMethod(event.target.value)}
          spellCheck={false}
          placeholder="device.status"
          className="h-5 w-40 shrink-0 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
        />
        <input
          value={params}
          onChange={(event) => setParams(event.target.value)}
          spellCheck={false}
          placeholder='{"deviceId":"..."}'
          className="h-5 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void send(method, params);
            }
          }}
        />
        <button
          type="button"
          onClick={() => void send(method, params)}
          className="h-5 shrink-0 rounded-sm bg-brand px-2 text-badge font-medium text-[#0b0d12] hover:opacity-90"
        >
          发送
        </button>
      </div>
    </div>
  );
}
