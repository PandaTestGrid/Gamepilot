import { Activity, Boxes, Cable, MonitorPlay } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import {
  type EngineNotification,
  engineStart,
  onEngineNotification,
  ping,
  PROTOCOL_VERSION,
} from '@/lib/rpc';
import { cn } from '@/lib/utils';

type EngineStatus = 'idle' | 'connecting' | 'ready' | 'error';

/**
 * 骨架页面：只有三栏容器 + 一条「前端 → Rust → Python」链路自检。
 *
 * 三栏的内容（画面栏 / 状态图画布 / 事件·时间轴·识别器）按 DESIGN.md §4 在 M1~M4
 * 逐个实现，这里只验证骨架能跑通、布局占位正确。
 */
export function App(): ReactNode {
  const [status, setStatus] = useState<EngineStatus>('idle');
  const [engineInfo, setEngineInfo] = useState<string>('未连接');
  const [notifications, setNotifications] = useState<string[]>([]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void onEngineNotification((notification: EngineNotification) => {
      setNotifications((prev) =>
        [`${notification.method} ${JSON.stringify(notification.params)}`, ...prev].slice(0, 5),
      );
    }).then((unlisten) => {
      dispose = unlisten;
    });
    return () => {
      dispose?.();
    };
  }, []);

  const selfCheck = useCallback(async () => {
    setStatus('connecting');
    try {
      await engineStart();
      const result = await ping();
      setEngineInfo(
        `engine v${result.version} · protocol ${result.protocol} · ${new Date(result.ts * 1000).toLocaleTimeString()}`,
      );
      setStatus(result.pong && result.protocol === PROTOCOL_VERSION ? 'ready' : 'error');
    } catch (error) {
      setEngineInfo(error instanceof Error ? error.message : String(error));
      setStatus('error');
    }
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Header status={status} engineInfo={engineInfo} onSelfCheck={() => void selfCheck()} />

      <main className="grid min-h-0 flex-1 grid-cols-[34fr_40fr_26fr] gap-2 p-2">
        <Panel
          icon={<MonitorPlay className="size-4" />}
          title="画面"
          subtitle="设备投屏 + 识别覆盖 + 框选录制"
          items={[
            '实时画面（M1）',
            '识别框：绿=已确认 / 橙=待投票 / 红=失败残影（M1）',
            '框选 / 点选 / 只读 三种模式（M2）',
            '归一化坐标实时读数（M2）',
          ]}
        />
        <Panel
          icon={<Boxes className="size-4" />}
          title="状态图"
          subtitle="节点 = 界面，边 = 动作，红虚线 = recovery"
          items={[
            '节点与边渲染（M3，React Flow）',
            '当前节点高亮 / pending 目标闪烁（M3）',
            '拖拽连线与边属性编辑（M5）',
            '校验器：不可达节点、无恢复边告警（M4）',
          ]}
        />
        <Panel
          icon={<Activity className="size-4" />}
          title="事件 · 时间轴 · 识别器"
          subtitle="调试与调参的主战场"
          items={[
            '事件流（类型着色 + 过滤，M2）',
            '时间轴回溯最近 60s 帧（M4）',
            '识别器缩略图墙 + 实时分数（M2）',
            '阈值滑块（拖动即时重算当前帧，M2）',
          ]}
        />
      </main>

      <Footer status={status} notifications={notifications} />
    </div>
  );
}

function Header({
  status,
  engineInfo,
  onSelfCheck,
}: {
  status: EngineStatus;
  engineInfo: string;
  onSelfCheck: () => void;
}): ReactNode {
  const tone: Record<EngineStatus, string> = {
    idle: 'text-muted-foreground border-border',
    connecting: 'text-amber-400 border-amber-500/40',
    ready: 'text-emerald-400 border-emerald-500/40',
    error: 'text-red-400 border-red-500/40',
  };
  return (
    <header className="flex items-center gap-3 border-b border-border px-3 py-2">
      <span className="text-sm font-semibold">GamePilot</span>
      <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
        骨架 v0.0.1 · protocol {PROTOCOL_VERSION}
      </span>
      <span className={cn('rounded-full border px-2 py-0.5 text-[11px]', tone[status])}>
        engine: {status}
      </span>
      <span className="truncate text-[11px] text-muted-foreground">{engineInfo}</span>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onSelfCheck}
        className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:border-primary"
      >
        <Cable className="size-3.5" />
        骨架自检（拉起引擎 + ping）
      </button>
    </header>
  );
}

function Panel({
  icon,
  title,
  subtitle,
  items,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  items: string[];
}): ReactNode {
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-border bg-card/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <span className="text-sm font-medium">{title}</span>
        <span className="truncate text-[11px] text-muted-foreground">{subtitle}</span>
      </div>
      <ul className="space-y-1 text-[11px] text-muted-foreground">
        {items.map((item) => (
          <li key={item} className="rounded border border-dashed border-border/70 px-2 py-1">
            {item}
          </li>
        ))}
      </ul>
      <div className="flex-1" />
      <p className="mt-2 text-[10px] text-muted-foreground/70">占位容器：实现见 docs/DESIGN.md §4</p>
    </section>
  );
}

function Footer({ status, notifications }: { status: EngineStatus; notifications: string[] }): ReactNode {
  return (
    <footer className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
      <span>node=- tick=0 vote=- fps=-</span>
      <div className="flex-1" />
      <span className="truncate">
        {status === 'ready' ? (notifications[0] ?? '等待引擎通知…') : '骨架未连通引擎'}
      </span>
    </footer>
  );
}
