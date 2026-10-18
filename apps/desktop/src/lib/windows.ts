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
    return { pane: null, deviceId: null };
  }
  const params = new URLSearchParams(window.location.search);
  const pane = params.get('pane');
  return {
    pane: pane === 'screen' || pane === 'graph' || pane === 'events' ? pane : null,
    deviceId: params.get('device'),
  };
}
