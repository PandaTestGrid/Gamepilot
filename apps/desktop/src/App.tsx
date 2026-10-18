import { type ReactNode, useEffect, useRef, useState } from 'react';

import { listen } from '@tauri-apps/api/event';

import { DevicePopover } from '@/features/device/DevicePopover';
import { DeviceTabs } from '@/layout/DeviceTabs';
import { ErrorBanner } from '@/layout/ErrorBanner';
import { StandalonePane } from '@/layout/StandalonePane';
import { WorkspaceLayout } from '@/layout/WorkspaceLayout';
import { devLog } from '@/lib/rpc';
import { streamFpsForDevice } from '@/lib/stream-policy';
import { useDismissCaptureOnBlur } from '@/lib/use-dismiss-capture';
import { readPaneQuery } from '@/lib/windows';
import { connectedDevices, useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
import { useEventStore } from '@/stores/event.store';
import { useGraphStore } from '@/stores/graph.store';
import { useLogStore } from '@/stores/log.store';
import { useSessionStore } from '@/stores/session.store';

/**
 * 主壳。
 *
 * 两个入口：
 *   - 主窗口：顶部条（设备标签 + 布局 + 引擎状态）+ 三栏（可拖拽、布局记忆）+ 底栏 + 设备弹层
 *   - 独立窗口：`?pane=screen&device=dev-a` 只渲染那一栏（DESIGN.md §4.6）
 */
export function App(): ReactNode {
  const { pane, deviceId } = readPaneQuery();
  useDismissCaptureOnBlur();
  const init = useEngineStore((state) => state.init);
  const selfCheck = useEngineStore((state) => state.selfCheck);
  const initSession = useSessionStore((state) => state.init);
  const activeId = useDeviceStore((state) => state.activeId);

  // 三条订阅：引擎通知（engine.ready/...）、运行时消息（engine.frame / engine.event / device.*）、
  // 界面日志（devLog → 底部「日志」抽屉）
  useEffect(() => {
    const disposers: Array<() => void> = [useLogStore.getState().subscribeUi()];
    let mounted = true;
    const attach = (pending: Promise<() => void>): void => {
      void pending
        .then((unlisten) => {
          if (mounted) disposers.push(unlisten);
          else unlisten(); // 热更新期间异步订阅来晚了，也不能留下重复监听器
        })
        // 订阅失败（Tauri 事件通道暂时不可用）只记一条前端日志：
        // 一句被拒的 Promise 不该在整个界面上变成"未处理的异常"
        .catch((error: unknown) => {
          devLog(`界面订阅失败: ${error instanceof Error ? error.message : String(error)}`);
        });
    };
    attach(init());
    attach(initSession());
    return () => {
      mounted = false;
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
  const adoptLiveDevices = useSessionStore((state) => state.adoptLiveDevices);
  const refreshCurrentWorkflow = useSessionStore((state) => state.refreshCurrentWorkflow);
  useEffect(() => {
    if (engineStatus !== 'ready') {
      return;
    }
    void (async () => {
      await scanDevices();
      // 引擎那边的会话可能还活着（界面重载/重启）：把状态对齐，别在画面还在动时显示"未连接"
      adoptLiveDevices();
      await refreshCurrentWorkflow();
    })();
  }, [engineStatus, scanDevices, adoptLiveDevices, refreshCurrentWorkflow]);

  // 每台设备首次出现时补齐它的状态图与事件桶（M1 换成从引擎拉取）
  const devices = useDeviceStore((state) => state.devices);
  const hasEmulator = devices.some((device) => device.kind === 'emulator');
  useEffect(() => {
    if (engineStatus !== 'ready' || !hasEmulator) return;
    // 用户在 MuMu 打开/关闭标签页后切回本窗口时，自动刷新实际窗口数。
    let lastRefresh = Date.now();
    const onFocus = (): void => {
      if (Date.now() - lastRefresh < 1500) return;
      lastRefresh = Date.now();
      void scanDevices();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [engineStatus, hasEmulator, scanDevices]);
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
  // 每台设备只自动连一次，避免 connect 更新 devices 触发 effect 循环
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
  const ready = useSessionStore((state) => state.ready);
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
      const fps = streamFpsForDevice({
        deviceId: device.id,
        activeId,
        windowed: Boolean(device.windowed),
        grid,
        gridFps,
        windowHidden,
        pane,
        paneDeviceId: deviceId,
      });
      if (fps !== null) {
        setStreamPolicy(device.id, fps);
      }
    }
  }, [devices, activeId, gridView, windowHidden, ready, setStreamPolicy, pane, deviceId]);

  useEffect(() => {
    if (pane) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>('pane-window-closed', (event) => {
      const closedId = event.payload;
      if (closedId) {
        useDeviceStore.getState().markWindowed(closedId, false);
      }
    })
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          unlisten = stop;
        }
      })
      .catch((error: unknown) => {
        devLog(`订阅独立窗口关闭失败: ${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [pane]);

  if (pane) {
    return <StandalonePane pane={pane} deviceId={deviceId} />;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <DeviceTabs />
      <ErrorBanner />

      {/* 主区（三栏，可左右拖） + 底部调试抽屉（可上下拖），见 layout/WorkspaceLayout.tsx */}
      <main className="min-h-0 flex-1">
        <WorkspaceLayout />
      </main>

      <DevicePopover />
    </div>
  );
}
