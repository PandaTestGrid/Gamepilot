import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';

import { DevicePopover } from '@/features/device/DevicePopover';
import { ScreenPane } from '@/features/device/ScreenPane';
import { EventPane } from '@/features/events/EventPane';
import { GraphPane } from '@/features/graph/GraphPane';
import { RecognizerPane } from '@/features/recognizers/RecognizerPane';
import { DeviceTabs } from '@/layout/DeviceTabs';
import { ErrorBanner } from '@/layout/ErrorBanner';
import { StatusBar } from '@/layout/StatusBar';
import { Toolbar } from '@/layout/Toolbar';
import { devLog } from '@/lib/rpc';
import { readPaneQuery, type PaneKind } from '@/lib/windows';
import { connectedDevices, useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
import { useEventStore } from '@/stores/event.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';

/**
 * 主壳。
 *
 * 两个入口：
 *   - 主窗口：工具栏 + 设备标签条 + 三栏（可拖拽、布局记忆）+ 底栏 + 设备弹层
 *   - 独立窗口：`?pane=screen&device=dev-a` 只渲染那一栏（DESIGN.md §4.6）
 */
export function App(): ReactNode {
  const { pane, deviceId } = readPaneQuery();
  const init = useEngineStore((state) => state.init);
  const selfCheck = useEngineStore((state) => state.selfCheck);
  const initSession = useSessionStore((state) => state.init);
  const activeId = useDeviceStore((state) => state.activeId);
  const running = useSessionStore((state) => Boolean(state.running[activeId]));
  const startRun = useSessionStore((state) => state.startRun);
  const stopRun = useSessionStore((state) => state.stopRun);
  // 布局记忆：拖过的栏宽会存进 localStorage，下次启动恢复
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: 'gamepilot.layout.v1' });

  // 两条订阅：引擎通知（engine.ready/...）与运行时消息（engine.frame / engine.event / device.*）
  useEffect(() => {
    const disposers: Array<() => void> = [];
    void init().then((unlisten) => disposers.push(unlisten));
    void initSession().then((unlisten) => disposers.push(unlisten));
    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, [init, initSession]);

  // 启动即拉起引擎（不再要求用户先点某个按钮），失败时由错误条提示并可重试
  useEffect(() => {
    devLog('界面已挂载，开始启动引擎');
    void selfCheck();
  }, [selfCheck]);

  // 引擎连上后自动扫描一次真实设备
  const engineStatus = useEngineStore((state) => state.status);
  const scanDevices = useDeviceStore((state) => state.scan);
  const refreshProject = useSessionStore((state) => state.refreshProject);
  useEffect(() => {
    if (engineStatus === 'ready') {
      void scanDevices();
      void refreshProject(); // 引擎起来后才能问它在哪个脚本目录
    }
  }, [engineStatus, scanDevices, refreshProject]);

  // 每台设备首次出现时补齐它的状态图与事件桶（M1 换成从引擎拉取）
  const devices = useDeviceStore((state) => state.devices);
  const ensureGraph = useGraphStore((state) => state.ensure);
  const ensureEvents = useEventStore((state) => state.ensure);
  useEffect(() => {
    for (const device of devices) {
      ensureGraph(device.id);
      ensureEvents(device.id);
    }
  }, [devices, ensureGraph, ensureEvents]);

  // 开发用自动连接：VITE_GP_AUTOCONNECT=<serial 或 设备 id> 时，扫描后自动连上它。
  // 平时不设置这个变量就没有任何影响；用它可以把"连接→出帧→渲染"整条链路无头验完
  const connectSession = useSessionStore((state) => state.connect);
  // 每台设备只自动连一次：这个 effect 依赖 devices，而 connect() 会改 devices，
  // 不记录"试过了"就会无限重试（实测能刷到 10 万次，把引擎的 RPC 派发线程占死）
  const autoTried = useRef(new Set<string>());
  useEffect(() => {
    const wanted = (import.meta.env.VITE_GP_AUTOCONNECT ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (wanted.length === 0 || engineStatus !== 'ready' || devices.length === 0) {
      return;
    }
    for (const key of wanted) {
      const target = devices.find((item) => item.id.includes(key) || item.uri.includes(key));
      if (target && !autoTried.current.has(target.id)) {
        autoTried.current.add(target.id);
        devLog(`开发钩子：自动连接 ${target.id}`);
        void connectSession(target.id, target.uri);
      }
    }
    // VITE_GP_GRID=1 直接开多开网格（验证多画面用）
    if (import.meta.env.VITE_GP_GRID === '1') {
      useDeviceStore.setState({ gridView: true });
    }
  }, [engineStatus, devices, connectSession]);

  // 推流策略：只给"看得见的画面"推帧，并按同时显示的数量分配帧率。
  // 不做这件事的话，每台设备都会以 14fps 推 60~143KB 的 JPEG（两台就 ~4MB/s），界面必然卡。
  const gridView = useDeviceStore((state) => state.gridView);
  const setStreamPolicy = useSessionStore((state) => state.setStreamPolicy);
  const [windowHidden, setWindowHidden] = useState(false);
  useEffect(() => {
    const onVisibility = (): void => setWindowHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    const connected = connectedDevices(devices);
    const grid = gridView && connected.length >= 2;
    const gridFps = connected.length >= 4 ? 4 : 6;
    for (const device of connected) {
      const fps = windowHidden ? 0 : grid ? gridFps : device.id === activeId ? 10 : 0;
      setStreamPolicy(device.id, fps);
    }
  }, [devices, activeId, gridView, windowHidden, setStreamPolicy]);

  if (pane) {
    return <StandalonePane pane={pane} deviceId={deviceId} />;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <Toolbar
        running={running}
        onToggleRun={() => {
          if (running) {
            void stopRun(activeId);
          } else {
            void startRun(activeId);
          }
        }}
      />
      <DeviceTabs />
      <ErrorBanner />

      <main className="min-h-0 flex-1">
        {/* 三栏可拖拽 + 布局记忆（DESIGN.md 决策 P3） */}
        <Group
          id="gamepilot.layout.v1"
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
          className="h-full"
        >
          <Panel id="screen" defaultSize="34%" minSize="22%">
            <ScreenPane />
          </Panel>
          <Separator className="w-px bg-line transition-colors hover:bg-brand" />
          <Panel id="graph" defaultSize="40%" minSize="24%">
            <GraphPane />
          </Panel>
          <Separator className="w-px bg-line transition-colors hover:bg-brand" />
          <Panel id="right" defaultSize="26%" minSize="18%">
            <div className="flex h-full flex-col">
              <EventPane />
              <RecognizerPane />
            </div>
          </Panel>
        </Group>
      </main>

      <StatusBar running={running} />
      <DevicePopover />
    </div>
  );
}

/** 独立窗口：只渲染一栏，给第二块屏用（画面丢过去，主窗口留状态图与事件）。 */
function StandalonePane({ pane, deviceId }: { pane: PaneKind; deviceId: string | null }): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const setActive = useDeviceStore((state) => state.setActive);
  const device = devices.find((item) => item.id === deviceId) ?? null;

  useEffect(() => {
    if (device) {
      setActive(device.id);
    }
  }, [device, setActive]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        <span className="text-panel font-medium">
          {pane === 'screen' ? '画面' : pane === 'graph' ? '状态图' : '事件'}
        </span>
        <span className="text-badge text-faint">{device?.name ?? '未指定设备'}</span>
        <div className="flex-1" />
        <span className="text-badge text-faint">独立窗口 · 关闭不影响运行</span>
      </header>
      <div className="min-h-0 flex-1">
        {pane === 'screen' && <ScreenPane />}
        {pane === 'graph' && <GraphPane />}
        {pane === 'events' && <EventPane />}
      </div>
    </div>
  );
}
