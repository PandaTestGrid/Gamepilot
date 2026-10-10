/**
 * 引擎连接状态（骨架自检）。
 *
 * 唯一真正调用 Rust 命令的地方：`engine_start` + `engine.ping`，
 * 用来证明 React → Rust → Python 三段链路通。M1 起 RPC 客户端会长大，
 * 但"状态与通知放 store、组件只读"这个结构不变。
 */
import { create } from 'zustand';

import { engineStart, onEngineNotification, ping, PROTOCOL_VERSION } from '@/lib/rpc';

export type EngineStatus = 'idle' | 'connecting' | 'ready' | 'error';

interface EngineState {
  readonly status: EngineStatus;
  readonly info: string;
  readonly notifications: readonly string[];
  readonly selfCheck: () => Promise<void>;
  readonly init: () => Promise<() => void>;
}

export const useEngineStore = create<EngineState>()((set) => ({
  status: 'idle',
  info: '未连接引擎',
  notifications: [],

  selfCheck: async () => {
    set({ status: 'connecting' });
    try {
      await engineStart();
      const result = await ping();
      set({
        status: result.pong && result.protocol === PROTOCOL_VERSION ? 'ready' : 'error',
        info: `engine v${result.version} · protocol ${result.protocol}`,
      });
    } catch (error) {
      set({ status: 'error', info: error instanceof Error ? error.message : String(error) });
    }
  },

  init: async () => {
    const unlisten = await onEngineNotification((notification) => {
      set((state) => ({
        notifications: [
          `${notification.method} ${JSON.stringify(notification.params)}`,
          ...state.notifications,
        ].slice(0, 5),
      }));
    });
    return unlisten;
  },
}));
