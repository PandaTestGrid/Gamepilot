import { type ReactNode, useEffect, useRef, useState } from 'react';

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { DevicePopover } from '@/features/device/DevicePopover';
import { UpdateBanner } from '@/features/updater/UpdateBanner';
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
  const { pane, deviceId, launch } = readPaneQuery();
  const needsLaunchHandoff = launch === 'main' && !pane;
  // 只有测试环境可在不启动真实引擎时直接进入主壳；生产构建里 Vite 会把它折叠为 false。
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

  // 正常启动由独立 Splash 窗口拉起引擎并完成握手。
  //
  // 但每个 WebView 的 JS 状态是**各自一份**的：Splash 握完手，主窗口里的
  // `useEngineStore.status` 仍然是 idle（截图里就是「引擎未连接」但画面上已经在推帧）。
  // 所以主窗口和独立窗口挂载后都要自己探一次 —— `engine_start` 是幂等的（已在跑就返回），
  // 探测只是 ping/info，不会重复拉起进程。
  // 浏览器预览没有 Rust 命令，`invoke` 会失败；那里仍然走 selfCheck 的兼容路径。
  useEffect(() => {
    if (launch === 'splash' || !import.meta.env.VITEST) {
      // 生产/打包：任何窗口（主窗口 / 独立窗口）挂载都探一次
      devLog('界面已挂载，探测引擎');
      void selfCheck();
      return;
    }
    if (pane || launch !== null) {
      return;
    }
    devLog('界面已挂载，开始启动引擎');
    void selfCheck();
  }, [selfCheck, pane, launch]);

  // 引擎连上后自动扫描一次真实设备
  // `pane` 独立窗口只渲染单个栏，不参与主窗口的启动门禁；主窗口才注册。
  const engineStatus = useEngineStore((state) => state.status);
  const scanDevices = useDeviceStore((state) => state.scan);
  const adoptLiveDevices = useSessionStore((state) => state.adoptLiveDevices);
  const refreshCurrentWorkflow = useSessionStore((state) => state.refreshCurrentWorkflow);
  useEffect(() => {
    if (engineStatus !== 'ready') {
      return;
    }
    void (async () => {
      // 独立窗口也要设备清单：它只渲染一栏，但仍要靠 devices 找到 URL 里那台设备
      // （以前这里 `pane !== null` 直接 return，结果独立窗口里设备列表是空的，
      //  画面永远停在空态 —— 看起来像"窗口打开了却没有投屏"）。
      await scanDevices();
      // 引擎那边的会话可能还活着（界面重载/重启）：把状态对齐，别在画面还在动时显示"未连接"。
      // 独立窗口只认 URL 里那一台（见 adoptLiveDevices 的注释）。
      adoptLiveDevices(pane === null ? null : deviceId);
      // 独立窗口**也要**当前工作流：框选/点选/录操作/文字识别都要先有工作流才能落盘
      // （`setRecordMode` 没工作流就只弹一句提示，按钮看起来"点了没反应"）。
      // `project.get` / `graph.get` 都是只读的，多开一个窗口读一次不会互相顶掉。
      await refreshCurrentWorkflow();
    })();
  }, [pane, deviceId, engineStatus, scanDevices, adoptLiveDevices, refreshCurrentWorkflow]);

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
        // 画面已经弹到独立窗口的设备：引擎仍要按 fps 推（那边在看），
        // 但**本窗口**不必再拉字节解码 —— 否则同一路投屏被两个 WebView 各解一遍，
        // 主窗口那块区域还留着旧画面，看起来像"独立窗口没生效"。
        const pollFps = pane === null && device.windowed ? 0 : fps;
        setStreamPolicy(device.id, fps, pollFps);
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

  // 主窗口已经完成这次 React 提交，此时才销毁启动窗口；Splash 多留一帧，
  // 用来覆盖主 WebView 的首屏绘制，切换过程不会露出空白背景。
  useEffect(() => {
    if (!needsLaunchHandoff) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      void invoke('close_launch_window').catch((error: unknown) => {
        devLog(`关闭启动窗口失败: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [needsLaunchHandoff]);

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
      <UpdateBanner />
    </div>
  );
}
