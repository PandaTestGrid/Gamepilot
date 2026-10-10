import {
  Cable,
  ChevronDown,
  CirclePlay,
  MoreHorizontal,
  RefreshCw,
  Search,
  Square,
  Undo2,
  Redo2,
  Video,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import {
  type EngineNotification,
  engineStart,
  onEngineNotification,
  ping,
  PROTOCOL_VERSION,
} from '@/lib/rpc';
import { cn } from '@/lib/utils';

/**
 * 骨架界面（扁平化 v2）。
 *
 * 这里只有三种东西：
 *   1. 真实的三栏骨架（画面 | 状态图 | 事件·时间轴·识别器），按 DESIGN.md §4.1 排布；
 *   2. 设备弹层的**静态视觉稿**（DESIGN.md §4.3）——数据是写死的，用于确认设计方向，不接引擎；
 *   3. 一条真实链路自检：前端 → Rust → Python 的 engine.ping。
 *
 * 任何识别 / 投屏 / 状态机逻辑都在 M1~M4 实现，不在这份骨架里。
 */
export function App(): ReactNode {
  const [deviceOpen, setDeviceOpen] = useState(true);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'ready' | 'error'>('idle');
  const [engineInfo, setEngineInfo] = useState('未连接引擎');
  const [notifications, setNotifications] = useState<string[]>([]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void onEngineNotification((notification: EngineNotification) => {
      setNotifications((prev) =>
        [`${notification.method} ${JSON.stringify(notification.params)}`, ...prev].slice(0, 3),
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
      setEngineInfo(`engine v${result.version} · protocol ${result.protocol} · pid ok`);
      setStatus(result.pong && result.protocol === PROTOCOL_VERSION ? 'ready' : 'error');
    } catch (error) {
      setEngineInfo(error instanceof Error ? error.message : String(error));
      setStatus('error');
    }
  }, []);

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <Toolbar
        status={status}
        connected={connected}
        running={running}
        engineInfo={engineInfo}
        onToggleRun={() => setRunning((v) => !v)}
        onToggleDevice={() => setDeviceOpen((v) => !v)}
        onSelfCheck={() => void selfCheck()}
      />

      <main className="grid min-h-0 flex-1 grid-cols-[34fr_40fr_26fr] divide-x divide-line">
        <ScreenColumn connected={connected} onConnect={() => setConnected(true)} />
        <GraphColumn />
        <InspectorColumn />
      </main>

      <StatusBar
        running={running}
        connected={connected}
        engineInfo={engineInfo}
        notifications={notifications}
      />

      {deviceOpen && (
        <DevicePopover
          onClose={() => setDeviceOpen(false)}
          onConnect={() => {
            setConnected(true);
            setDeviceOpen(false);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 顶栏 */

function Toolbar({
  status,
  connected,
  running,
  engineInfo,
  onToggleRun,
  onToggleDevice,
  onSelfCheck,
}: {
  status: 'idle' | 'connecting' | 'ready' | 'error';
  connected: boolean;
  running: boolean;
  engineInfo: string;
  onToggleRun: () => void;
  onToggleDevice: () => void;
  onSelfCheck: () => void;
}): ReactNode {
  const dot = !connected
    ? 'bg-idle'
    : status === 'ready'
      ? 'bg-confirmed'
      : status === 'error'
        ? 'bg-failed'
        : 'bg-pending';

  return (
    <header className="flex h-9 shrink-0 items-center bg-panel pr-2">
      <span className="px-3 text-[15px] font-medium tracking-wide">GamePilot</span>
      <Divider />

      <ToolButton onClick={onToggleRun} active={running}>
        {running ? <Square className="size-3.5" /> : <CirclePlay className="size-3.5" />}
        {running ? '停止' : '运行'}
      </ToolButton>
      <ToolButton title="录制：在画面上框选即生成识别器与节点">
        <Video className="size-3.5" />
        录制
      </ToolButton>
      <Divider />

      <ToolButton title="撤销">
        <Undo2 className="size-3.5" />
      </ToolButton>
      <ToolButton title="重做">
        <Redo2 className="size-3.5" />
      </ToolButton>
      <Divider />

      <button
        type="button"
        onClick={onToggleDevice}
        className="flex h-6 items-center gap-2 rounded-sm px-2 hover:bg-raised"
        title="设备选择器（DESIGN.md §4.3）"
      >
        <span className={cn('size-1.5 rounded-full', dot)} />
        <span className="text-body">{connected ? 'SM-G9980 · 1440×3200' : '未连接设备'}</span>
        <ChevronDown className="size-3.5 text-dim" />
      </button>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onSelfCheck}
        className={cn(
          'flex h-6 items-center gap-1.5 rounded-sm px-2 hover:bg-raised',
          status === 'error' && 'text-failed',
          status === 'ready' && 'text-confirmed',
        )}
        title={engineInfo}
      >
        <Cable className="size-3.5" />
        骨架自检
      </button>
      <Divider />
      <span className="px-2 text-badge text-faint">─ □ ✕</span>
    </header>
  );
}

function Divider(): ReactNode {
  return <span className="mx-1 h-4 w-px bg-line" />;
}

function ToolButton({
  children,
  onClick,
  active,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  title?: string;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-6 items-center gap-1.5 rounded-sm px-2 hover:bg-raised',
        active && 'bg-raised text-brand',
      )}
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------- 栏通用件 */

function PanelHead({ title, children }: { title: string; children?: ReactNode }): ReactNode {
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
      <span className="text-panel font-medium">{title}</span>
      <div className="flex-1" />
      {children}
    </div>
  );
}

function GhostButton({ children, onClick }: { children: ReactNode; onClick?: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-5 items-center gap-1 rounded-sm px-1.5 text-badge text-dim hover:bg-raised hover:text-fg"
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------- 画面栏 */

function ScreenColumn({ connected, onConnect }: { connected: boolean; onConnect: () => void }): ReactNode {
  return (
    <section className="flex min-h-0 flex-col bg-panel">
      <PanelHead title="画面">
        <GhostButton>框选</GhostButton>
        <GhostButton>读数 12</GhostButton>
      </PanelHead>

      <div className="min-h-0 flex-1 overflow-hidden bg-canvas p-2">
        {connected ? (
          <div className="flex h-full items-center justify-center border border-dashed border-line text-dim">
            实时画面（M1 实现：投屏 + 识别框覆盖）
          </div>
        ) : (
          <EmptyDeviceState onConnect={onConnect} />
        )}
      </div>

      <div className="shrink-0 border-t border-line">
        <div className="flex h-6 items-center px-2 text-badge text-faint">识别读数</div>
        {(
          [
            ['confirmed', 'main_start', '0.93', '稳定'],
            ['confirmed', 'main_shop', '0.88', '稳定'],
            ['pending', 'battle_hp', '0.71', '待确认'],
            ['idle', 'popup_close', '0.00', '未命中'],
          ] as const
        ).map(([tone, label, score, state]) => (
          <div key={label} className="flex h-[26px] items-center gap-2 px-2 hover:bg-raised">
            <span className={cn('size-1.5 rounded-full', dotClass(tone))} />
            <span className="w-28 truncate text-body">{label}</span>
            <span className="text-body text-dim">{score}</span>
            <div className="flex-1" />
            <span className="text-badge text-faint">{state}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function EmptyDeviceState({ onConnect }: { onConnect: () => void }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <span className="text-panel text-dim">未连接设备</span>
      <button
        type="button"
        onClick={onConnect}
        className="h-7 rounded-sm bg-brand px-4 text-body font-medium text-[#0b0d12] hover:opacity-90"
      >
        连接设备
      </button>
      <div className="w-64 text-badge text-faint">
        <div className="mb-1 text-dim">最近使用</div>
        {['Android · emulator-5554 · 1080×1920', 'Mock · 合成测试设备 · 1280×720'].map((item) => (
          <div key={item} className="flex h-[26px] items-center justify-between px-1 hover:bg-raised">
            <span>{item}</span>
            <span className="text-dim">→</span>
          </div>
        ))}
        <div className="mt-2">正在扫描：adb 设备 1 个 · Windows 窗口 7 个</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 状态图栏 */

function GraphColumn(): ReactNode {
  return (
    <section className="flex min-h-0 flex-col bg-panel">
      <PanelHead title="状态图">
        <GhostButton>+ 节点</GhostButton>
        <GhostButton>自动布局</GhostButton>
        <GhostButton>验证</GhostButton>
        <GhostButton>JSON</GhostButton>
      </PanelHead>

      <div className="relative min-h-0 flex-1 bg-canvas">
        <svg className="absolute inset-0 size-full" aria-hidden>
          {/* 普通边：1px 实线 */}
          <line x1="250" y1="120" x2="430" y2="120" stroke="var(--state-confirmed)" strokeWidth="1" />
          <line x1="250" y1="150" x2="250" y2="250" stroke="var(--state-confirmed)" strokeWidth="1" />
          <line x1="250" y1="250" x2="430" y2="250" stroke="var(--state-confirmed)" strokeWidth="1" />
          {/* recovery 边：红色虚线 + ⚡ */}
          <line
            x1="310"
            y1="320"
            x2="420"
            y2="320"
            stroke="var(--state-recovery)"
            strokeWidth="1"
            strokeDasharray="4 3"
          />
          <text x="250" y="112" fill="var(--state-confirmed)" fontSize="10">
            e_start
          </text>
          <text x="256" y="200" fill="var(--state-confirmed)" fontSize="10">
            e_shop
          </text>
          <text x="300" y="242" fill="var(--state-confirmed)" fontSize="10">
            e_settle
          </text>
          <text x="300" y="312" fill="var(--state-recovery)" fontSize="10">
            ⚡ r_popup
          </text>
        </svg>

        <GraphNode style={{ left: 120, top: 96 }} label="main" sub="主界面" active />
        <GraphNode style={{ left: 430, top: 96 }} label="battle" sub="战斗中" />
        <GraphNode style={{ left: 120, top: 226 }} label="shop" sub="商店" />
        <div
          className="absolute rounded-sm border border-dashed border-recovery px-2 py-1 text-badge text-recovery"
          style={{ left: 420, top: 306 }}
        >
          recovery · popup_close
        </div>
      </div>
    </section>
  );
}

function GraphNode({
  style,
  label,
  sub,
  active,
}: {
  style: { left: number; top: number };
  label: string;
  sub: string;
  active?: boolean;
}): ReactNode {
  return (
    <div
      className={cn(
        'absolute w-[130px] rounded-sm bg-panel px-2 py-1',
        active ? 'border border-brand' : 'border border-line',
      )}
      style={style}
    >
      <div className="text-body">{label}</div>
      <div className="text-badge text-faint">{sub}</div>
    </div>
  );
}

/* --------------------------------------------------- 事件 · 时间轴 · 识别器 */

function InspectorColumn(): ReactNode {
  const events: Array<[string, string, string]> = [
    ['node_entered', 'main', 'text-brand'],
    ['edge_matched', 'e_start', 'text-confirmed'],
    ['recovery_matched', '⚡ r_popup', 'text-recovery'],
    ['transition_failed', 'e_settle', 'text-failed'],
    ['device', 'disconnected', 'text-failed'],
  ];
  return (
    <section className="flex min-h-0 flex-col bg-panel">
      <PanelHead title="事件">
        <GhostButton>全部</GhostButton>
        <GhostButton>仅失败</GhostButton>
      </PanelHead>

      <div className="min-h-0 flex-1 overflow-hidden">
        {events.map(([type, target, tone]) => (
          <div key={type + target} className="flex h-[26px] items-center gap-2 px-2 hover:bg-raised">
            <span className="w-14 shrink-0 text-badge text-faint">12:01:0{events.length}</span>
            <span className={cn('truncate text-body', tone)}>{type}</span>
            <div className="flex-1" />
            <span className="truncate text-badge text-dim">{target}</span>
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-line px-2 py-1.5">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-badge text-faint">时间轴</span>
          <div className="relative h-1 flex-1 bg-raised">
            <span className="absolute top-[-3px] left-[38%] size-2 rounded-full bg-brand" />
          </div>
          <span className="text-badge text-faint">60s</span>
        </div>
      </div>

      <div className="shrink-0 border-t border-line">
        <div className="flex h-6 items-center px-2 text-badge text-faint">识别器</div>
        {[
          ['main_start', '0.93', '模板'],
          ['battle_hp', '0.71', '颜色'],
        ].map(([label, score, kind]) => (
          <div key={label} className="px-2 py-1 hover:bg-raised">
            <div className="flex h-[22px] items-center gap-2">
              <span className="flex-1 truncate text-body">{label}</span>
              <span className="text-body text-dim">{score}</span>
              <span className="text-badge text-faint">{kind}</span>
            </div>
            <div className="flex h-4 items-center gap-2">
              <span className="text-badge text-faint">阈值</span>
              <div className="relative h-0.5 flex-1 bg-raised">
                <span className="absolute top-[-3px] left-[82%] size-2 rounded-sm bg-brand" />
                <span className="absolute inset-y-0 left-0 w-[82%] bg-brand/40" />
              </div>
              <span className="w-8 text-right text-badge text-dim">0.82</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- 底栏 */

function StatusBar({
  running,
  connected,
  engineInfo,
  notifications,
}: {
  running: boolean;
  connected: boolean;
  engineInfo: string;
  notifications: string[];
}): ReactNode {
  const items: Array<[string, string, string?]> = [
    ['node', running ? 'main' : '-'],
    ['tick', running ? '142' : '0'],
    ['vote', running ? '2/2' : '-'],
    ['fps', connected ? '11' : '-'],
    ['capture', connected ? '12ms' : '-', connected ? 'ok' : undefined],
    ['input', connected ? '48ms' : '-', connected ? 'ok' : undefined],
    ['run', running ? '00:12:31' : '00:00:00'],
  ];
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-badge text-dim">
      {items.map(([key, value, tone]) => (
        <span key={key} className="flex items-center gap-1">
          <span className="text-faint">{key}</span>
          <span className={tone === 'ok' ? 'text-confirmed' : undefined}>{value}</span>
        </span>
      ))}
      <div className="flex-1" />
      <span className="truncate">{notifications[0] ?? engineInfo}</span>
    </footer>
  );
}

/* ------------------------------------------------- 设备弹层（静态视觉稿） */

function DevicePopover({ onClose, onConnect }: { onClose: () => void; onConnect: () => void }): ReactNode {
  const rows: Array<{
    name: string;
    kind: string;
    res: string;
    tone: 'connected' | 'connecting' | 'idle' | 'failed';
  }> = [
    { name: 'emulator-5554', kind: '安卓', res: '1080×1920', tone: 'connecting' },
    { name: 'SM-G9980', kind: '安卓', res: '1440×3200', tone: 'connected' },
    { name: 'MuMu Player 12', kind: '模拟器', res: '1280×720', tone: 'idle' },
    { name: 'Unity Window (Game.exe)', kind: 'Windows', res: '1920×1080', tone: 'idle' },
    { name: 'Mock 合成设备', kind: 'Mock', res: '1280×720', tone: 'idle' },
    { name: 'ZPFA BE5D17', kind: '安卓', res: '未授权', tone: 'failed' },
  ];

  return (
    <div className="absolute inset-0 z-10 bg-canvas/60" onClick={onClose} role="presentation">
      <div
        className="absolute top-11 left-3 w-[420px] rounded-sm border border-line bg-panel"
        onClick={(event) => event.stopPropagation()}
        role="presentation"
      >
        <div className="flex h-7 items-center border-b border-line px-2">
          <span className="text-panel font-medium">设备</span>
          <span className="ml-2 text-badge text-faint">静态预览（未接引擎）</span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="px-1 text-dim hover:text-fg">
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-line px-2 py-2">
          <Search className="size-3.5 text-faint" />
          <input
            className="h-6 flex-1 bg-transparent text-body placeholder:text-faint focus:outline-none"
            placeholder="搜索设备，或粘贴 URI（Android:///?serial=xxx）"
          />
        </div>

        <div className="flex gap-1 border-b border-line px-2 py-1.5">
          {['全部', '安卓', '模拟器', 'Windows', 'Mock'].map((tab, index) => (
            <button
              key={tab}
              type="button"
              className={cn(
                'h-5 rounded-sm px-2 text-badge',
                index === 0 ? 'bg-active text-fg' : 'text-dim hover:bg-raised',
              )}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="max-h-[300px] overflow-auto">
          {rows.map((row) => (
            <div
              key={row.name}
              className="group flex h-8 items-center gap-2 border-b border-line/60 px-2 hover:bg-raised"
            >
              <span className={cn('size-1.5 shrink-0 rounded-full', dotClass(row.tone))} />
              <span className="flex-1 truncate text-body">{row.name}</span>
              <span className="text-badge text-faint">{row.kind}</span>
              <span className="w-20 text-right text-badge text-dim">{row.res}</span>
              {row.tone === 'connected' ? (
                <span className="w-14 text-right text-badge text-confirmed">断开</span>
              ) : row.tone === 'connecting' ? (
                <RefreshCw className="size-3.5 animate-spin text-pending" />
              ) : row.tone === 'failed' ? (
                <span className="w-14 text-right text-badge text-failed">重试</span>
              ) : (
                <button
                  type="button"
                  onClick={onConnect}
                  className="w-14 text-right text-badge text-brand opacity-0 group-hover:opacity-100"
                >
                  连接
                </button>
              )}
            </div>
          ))}

          <div className="border-b border-line/60 bg-raised/40 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className="size-1.5 shrink-0 rounded-full bg-failed" />
              <span className="text-body text-failed">未授权：在手机上确认「允许 USB 调试」</span>
              <div className="flex-1" />
              <button type="button" className="text-badge text-brand">
                重新检测
              </button>
            </div>
          </div>
        </div>

        <div className="flex h-8 items-center gap-3 px-2 text-badge text-dim">
          <button type="button" className="flex items-center gap-1 hover:text-fg">
            <RefreshCw className="size-3" /> 刷新
          </button>
          <button type="button" className="flex items-center gap-1 hover:text-fg">
            <MoreHorizontal className="size-3" /> 高级
          </button>
          <div className="flex-1" />
          <span className="text-faint">iOS 支持：计划中（暂不提供）</span>
        </div>
      </div>
    </div>
  );
}

function dotClass(tone: string): string {
  switch (tone) {
    case 'connected':
    case 'confirmed':
      return 'bg-confirmed';
    case 'connecting':
    case 'pending':
      return 'bg-pending';
    case 'failed':
      return 'bg-failed';
    default:
      return 'bg-idle';
  }
}
