/**
 * 引擎连接状态（骨架自检）+ **能力校验与重启**。
 *
 * 唯一真正调用 Rust 命令的地方：`engine_start` / `engine_stop` + `engine.ping`。
 *
 * ⚠️ 引擎是应用启动时拉起的**独立进程**，会一直活着：代码更新后正在跑的那个仍是旧的，
 * 于是界面上会出现「未知方法: project.create」这类错误。引擎在 `engine.ready` / `engine.info`
 * 里会报方法表，所以这里做两件事：
 *   1. 握手时对比能力清单（`lib/engine-methods.ts`），缺方法就置 `missingMethods`；
 *   2. 给出 `restart()`：停掉旧进程 → 拉起新进程 → 重新握手，并清掉设备/会话的连接态
 *      （旧进程里的 session 已经不存在了，界面上的"已连接"必须跟着复位）。
 */
import { create } from 'zustand';

import { missingEngineMethods } from '@/lib/engine-methods';
import { engineStart, engineStop, onEngineNotification, ping, PROTOCOL_VERSION, rpc } from '@/lib/rpc';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';

export type EngineStatus = 'idle' | 'connecting' | 'ready' | 'error';

interface EngineInfoPayload {
  readonly version?: string;
  readonly protocol?: number;
  readonly methods?: string[];
}

interface EngineState {
  readonly status: EngineStatus;
  readonly info: string;
  readonly notifications: readonly string[];
  /** 引擎是旧进程：它不认识这些前端需要的方法（重启即可） */
  readonly missingMethods: readonly string[];
  readonly selfCheck: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly init: () => Promise<() => void>;
}

export const useEngineStore = create<EngineState>()((set) => {
  /** 握手之后统一收口：状态、文案、能力校验。 */
  const applyProbe = async (): Promise<void> => {
    const result = await ping();
    let methods: string[] | undefined;
    let info = `engine v${result.version} · protocol ${result.protocol}`;
    try {
      const detail = await rpc<EngineInfoPayload>('engine.info', {});
      methods = detail.methods;
      info = `engine v${detail.version ?? result.version} · protocol ${detail.protocol ?? result.protocol}`;
    } catch {
      // engine.info 拿不到不影响主流程：能力校验退化为"未知"，由具体调用去暴露问题
    }
    const missing = missingEngineMethods(methods);
    const protocolOk = result.pong && result.protocol === PROTOCOL_VERSION;
    set({
      status: protocolOk ? 'ready' : 'error',
      info: protocolOk ? info : `${info}（界面要求 protocol ${PROTOCOL_VERSION}）`,
      missingMethods: missing,
    });
  };

  return {
    status: 'idle',
    info: '未连接引擎',
    notifications: [],
    missingMethods: [],

    selfCheck: async () => {
      set({ status: 'connecting' });
      try {
        await engineStart();
        await applyProbe();
      } catch (error) {
        set({ status: 'error', info: error instanceof Error ? error.message : String(error) });
      }
    },

    restart: async () => {
      set({ status: 'connecting', info: '正在重启引擎…' });
      try {
        await engineStop();
        // 旧进程里的设备会话没了：界面上的连接态必须复位，否则会一直显示"已连接"却发不出指令
        useSessionStore.setState({
          ready: {},
          frames: {},
          links: {},
          running: {},
          connectingPhase: {},
          error: null,
        });
        await engineStart();
        await applyProbe();
        await useDeviceStore.getState().scan();
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
        if (notification.method === 'engine.ready') {
          // 握手通知里带方法表：不用额外发一次 engine.info 就能发现"旧进程"
          const methods = notification.params.methods;
          set({
            missingMethods: missingEngineMethods(Array.isArray(methods) ? methods.map(String) : undefined),
          });
        }
      });
      return unlisten;
    },
  };
});
