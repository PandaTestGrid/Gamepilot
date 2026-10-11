/**
 * 从 Finder 往侧栏里拖文件夹 = 添加工作区。
 *
 * 为什么不用 HTML5 的 `ondrop` + `dataTransfer.files`：在 Tauri 的 webview 里文件拖拽由
 * 原生层接管（`dragDropEnabled` 默认开），拿到的是**真实路径**（`onDragDropEvent`），
 * 而 HTML5 那条路只能拿到 File 对象、拿不到路径 —— 我们要的恰恰是路径。
 *
 * 不在 Tauri 里（浏览器 / vitest）时静默不生效：没有拖拽事件，也不会报错。
 */
import { useEffect, useRef } from 'react';

export interface WorkspaceDropHandlers {
  /** 有东西拖到窗口上方（用来点亮落点提示） */
  readonly onEnter: () => void;
  /** 拖走了 / 松手了 */
  readonly onLeave: () => void;
  /** 松手：给出这次拖进来的所有路径（文件也在里面，引擎会拒绝"不是目录"的那种） */
  readonly onDrop: (paths: readonly string[]) => void;
}

type DragPayload = { type: string; paths?: readonly string[] };
type WebviewModule = {
  getCurrentWebview: () => {
    onDragDropEvent: (handler: (event: { payload: DragPayload }) => void) => Promise<() => void>;
  };
};

export function useWorkspaceDrop(handlers: WorkspaceDropHandlers): void {
  // 回调放 ref：重新订阅会漏掉拖动过程中的事件，所以只在挂载/卸载时订阅一次
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    let stop: (() => void) | undefined;
    let alive = true;
    void (async () => {
      try {
        const module = (await import('@tauri-apps/api/webview')) as unknown as WebviewModule;
        const unlisten = await module.getCurrentWebview().onDragDropEvent((event) => {
          const { type } = event.payload;
          if (type === 'enter' || type === 'over') {
            latest.current.onEnter();
          } else if (type === 'leave') {
            latest.current.onLeave();
          } else if (type === 'drop') {
            latest.current.onDrop(event.payload.paths ?? []);
          }
        });
        if (alive) {
          stop = unlisten;
        } else {
          unlisten();
        }
      } catch {
        // 不在 Tauri 里（浏览器 / 测试）：没有拖拽事件可用，正常降级
      }
    })();
    return () => {
      alive = false;
      stop?.();
    };
  }, []);
}
