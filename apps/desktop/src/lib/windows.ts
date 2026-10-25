/**
 * 多窗口支持（DESIGN.md §4.6）。
 *
 * 主窗口之外，任一栏都可以弹成独立窗口（典型用法：把「画面」丢到第二块屏，
 * 主窗口只留状态图与事件）。实现方式是 Tauri 多 WebView：
 *   Rust 侧 `open_pane_window(pane, deviceId)` → 新窗口 URL 带 `?pane=screen&device=dev-a`
 *   前端启动时读 query，只渲染那一栏。
 */
import { invoke } from '@tauri-apps/api/core';

import { devLog } from '@/lib/rpc';

export type PaneKind = 'screen' | 'graph' | 'events';

export interface PaneQuery {
  readonly pane: PaneKind | null;
  readonly deviceId: string | null;
  readonly launch: 'splash' | 'main' | null;
}

export interface LaunchQuery {
  readonly launch: 'splash' | 'main' | null;
}

function isTauri(): boolean {
  return typeof globalThis === 'object' && '__TAURI_INTERNALS__' in globalThis;
}

export async function openPaneWindow(pane: PaneKind, deviceId: string): Promise<void> {
  if (!deviceId.trim()) {
    throw new Error('打开独立窗口需要先选中一台设备');
  }
  if (!isTauri()) {
    // 浏览器里跑 `pnpm dev` 时没有 Tauri 环境：静默跳过，不影响布局预览
    return;
  }
  try {
    await invoke('open_pane_window', { pane, deviceId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    devLog(`打开独立窗口失败: ${message}`);
    throw new Error(`无法打开独立窗口：${message}`, { cause: error });
  }
}

export function readPaneQuery(): PaneQuery {
  if (typeof window === 'undefined') {
    return { pane: null, deviceId: null, launch: null };
  }
  const params = new URLSearchParams(window.location.search);
  const pane = params.get('pane');
  const launch = params.get('launch');
  return {
    pane: pane === 'screen' || pane === 'graph' || pane === 'events' ? pane : null,
    deviceId: params.get('device'),
    launch: launch === 'splash' || launch === 'main' ? launch : null,
  };
}

/**
 * 关掉某个独立窗口（主窗口的「收回主窗口」用）。
 *
 * 由 Rust 关，而不是让独立窗口自己 `close()`：收回动作发生在**主窗口**里，
 * 它要关的是另一个 WebView。窗口销毁后 Rust 照常发 `pane-window-closed`，
 * 主窗口据此把 `windowed` 复位并恢复拉帧 —— 只有一处真源。
 */
export async function closePaneWindow(pane: PaneKind, deviceId: string): Promise<void> {
  if (!isTauri()) {
    return;
  }
  try {
    await invoke('close_pane_window', { pane, deviceId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    devLog(`关闭独立窗口失败: ${message}`);
  }
}

/**
 * 当前 WebView 是不是「独立窗口」（`?pane=`）。主窗口返回 false。
 *
 * 结果按 `location.search` 缓存：生产里 URL 不会变（换窗口 = 新 WebView），
 * 而画面栏每帧都在渲染 —— 每帧解析一次 URLSearchParams 是白烧 CPU。
 * 按 search 串缓存（而不是模块级常量）是为了测试里能改 URL 重算。
 */
let paneCache: { search: string; pane: boolean } | null = null;

export function isPaneWindow(): boolean {
  const search = typeof window === 'undefined' ? '' : window.location.search;
  if (paneCache?.search !== search) {
    paneCache = { search, pane: readPaneQuery().pane !== null };
  }
  return paneCache.pane;
}

export function readLaunchQuery(): LaunchQuery {
  if (typeof window === 'undefined') {
    return { launch: null };
  }
  const launch = new URLSearchParams(window.location.search).get('launch');
  return { launch: launch === 'splash' || launch === 'main' ? launch : null };
}






