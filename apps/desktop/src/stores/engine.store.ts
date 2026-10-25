/**
 * 引擎连接状态（骨架自检）+ **能力校验与重启**。
 *
 * 唯一真正调用 Rust 命令的地方：`engine_start` / `engine_stop` + `engine.ping`。
 *
 * 引擎为独立进程；握手对比 `lib/engine-methods.ts`，缺方法时可 `restart()` 并复位会话连接态。
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
        set({
          status: 'error',
          info: `引擎启动失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },

    restart: async () => {
      set({ status: 'connecting', info: '正在重启引擎…' });
      try {
        await engineStop();
        // 旧进程里的设备会话没了：界面上的连接态必须复位，否则会一直显示"已连接"却发不出指令
        useSessionStore.getState().resetForEngineRestart();
        useDeviceStore.getState().resetConnections();
        await engineStart();
        await applyProbe();
        await useDeviceStore.getState().scan();
      } catch (error) {
        set({
          status: 'error',
          info: `引擎启动失败：${error instanceof Error ? error.message : String(error)}`,
        });
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
        if (notification.method === 'engine.exited') {
          // 引擎进程没了（自己崩了 / 被关掉）：必须马上在界面上说清楚。
          // 不说的话，接下来每个调用只会回「引擎没在运行」这种没头没尾的错，
          // 而"什么时候退的、为什么退"全看不出来（见 engine.rs 的 watch_engine_exit）。
          // reason 是 Rust 给的字符串（退出状态）；别用 String() 硬转任意值（对象会变成 [object Object]）
          const raw = notification.params.reason;
          const reason = typeof raw === 'string' ? raw.trim() : '';
          set({
            status: 'error',
            info: `引擎已退出${reason ? `（${reason}）` : ''}：点「重启引擎」重开一次`,
          });
        }
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
