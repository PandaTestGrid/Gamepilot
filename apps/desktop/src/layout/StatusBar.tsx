import { type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { activeDevice, useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
import { useEventStore } from '@/stores/event.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';

/**
 * 一枚指标：`key` 是灰标签，`value` 是读数（异常变红）。
 *
 * `hideBelow` = 这枚指标"窄到什么时候整枚收起"。状态行是整扇窗口里最挤的一条，
 * 小窗口下**不能靠换行或压扁**去适配：`link dvt（慢）` 的 `（慢）` 会掉到第二行盖住抽屉
 * （全角括号前后都可以断行），Tab 按钮的中文会被挤成竖排文字。只能按重要性整枚拿掉。
 *
 * 阈值查的是**状态行自己的宽度**（根节点上的 `@container`），不是窗口宽度：
 * 真正决定放不放得下的是"窗口宽 − 右侧 Tab / 抽屉按钮"，拿窗口宽当尺子会算错。
 * 数字来自各枚的实测宽度（11px 字号 + `tabular-nums`）：8 枚 ≈ 596px（含 12px 间距），
 * 每级留 ≥ 96px 给右侧事件摘要，所以才是一档一档往下掉。
 */
interface Metric {
  readonly key: string;
  readonly value: string;
  readonly bad?: boolean;
  /** 容器查询类：状态行窄于该宽度时收起这一枚（见下方说明） */
  readonly hideBelow?: string;
}

/**
 * 底栏状态行：运行指标 + 最后一条事件摘要。任一指标异常变红（DESIGN.md §4.2 E）。
 *
 * 不再自己画边框/背景：它是底部抽屉那条 28px 状态行的一部分（见 layout/BottomDock.tsx），
 * 所以也不需要外面传 `running` —— 直接从会话 store 读，少一层 prop 传递。
 *
 * 响应式规则（W = 状态行可用宽度）：`input`<690 · `capture`<610 · `vote`<520 · `link`<450 ·
 * 事件摘要<380 · `fps`<330 · `tick`<260；`node` 与 `run` 永不收起 —— 不管窗口多窄，
 * "现在在哪 / 跑没跑" 都必须看得见。每枚都 `shrink-0 whitespace-nowrap`：
 * 宁可少显示一枚，也不许把文字折行或压成竖排。
 */
export function StatusBar(): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const running = useSessionStore((state) => Boolean(state.running[activeId]));
  const graph = useGraphStore((state) => state.graphs[activeId]);
  const events = useEventStore((state) => state.events[activeId]);
  const engineStatus = useEngineStore((state) => state.status);
  const frame = useSessionStore((state) => state.frames[activeId]);
  const link = useSessionStore((state) => state.links[activeId]);

  const device = activeDevice(devices, activeId);
  const connected = device?.status === 'connected';
  const fps = frame ? frame.fps : connected ? (device?.fps ?? 0) : 0;
  const last = events?.[events.length - 1];

  const items: readonly Metric[] = [
    { key: 'node', value: frame?.node ?? graph?.activeNodeId ?? '-' },
    { key: 'tick', value: String(frame?.tick ?? 0), hideBelow: '@max-[260px]:hidden' },
    { key: 'vote', value: running ? '2/2' : '-', hideBelow: '@max-[520px]:hidden' },
    {
      key: 'link',
      value: link ? `${link.channel}${link.channel === 'scrcpy' ? '' : '（慢）'}` : '-',
      bad: Boolean(link && link.channel !== 'scrcpy'),
      hideBelow: '@max-[450px]:hidden',
    },
    {
      key: 'fps',
      value: connected ? fps.toFixed(1) : '-',
      bad: connected && fps < 3,
      hideBelow: '@max-[330px]:hidden',
    },
    {
      key: 'capture',
      value: frame ? `${frame.captureMs}ms` : '-',
      bad: Boolean(frame && frame.captureMs > 200),
      hideBelow: '@max-[610px]:hidden',
    },
    { key: 'input', value: connected ? '48ms' : '-', hideBelow: '@max-[690px]:hidden' },
    { key: 'run', value: running ? '运行中' : '停止' },
  ];

  return (
    <div className="@container flex h-6 min-w-0 flex-1 items-center text-badge text-dim">
      {/* 指标区 `shrink-0` + `min-w-0 overflow-hidden`：**先饿死右侧事件摘要，再谈裁指标**。
          反过来的话（指标可压缩）flex 会按比例一起缩，最后一枚 `run` 会被截掉半个字 ——
          但"跑没跑"是这条里最不能少的信息。真到极端窄窗口，最多裁掉指标区末尾一角 */}
      <div className="flex min-w-0 shrink-0 items-center gap-3 overflow-hidden">
        {items.map((item) => (
          <span
            key={item.key}
            className={cn('flex shrink-0 items-center gap-1 whitespace-nowrap', item.hideBelow)}
          >
            <span className="text-faint">{item.key}</span>
            <span className={item.bad ? 'text-failed' : undefined}>{item.value}</span>
          </span>
        ))}
      </div>

      <div className="min-w-2 flex-1" />

      <span className="min-w-0 max-w-[40%] truncate @max-[380px]:hidden" title={last?.message}>
        {engineStatus === 'ready'
          ? last
            ? `${last.type} · ${last.message}`
            : '引擎已就绪，暂无事件'
          : '骨架自检未运行'}
      </span>
    </div>
  );
}
