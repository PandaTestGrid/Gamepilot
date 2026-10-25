/**
 * 独立启动窗口。
 *
 * 主窗口在后台预创建但保持隐藏；这个小窗口负责真实拉起引擎、订阅通知并完成
 * ping/info 握手。握手成功后由 Rust 一次性切到主窗口，避免大窗口先闪一整屏空白。
 */
import { invoke } from '@tauri-apps/api/core';
import { type ReactNode, useEffect, useState } from 'react';

import { AppStartupScreen } from '@/layout/AppStartupScreen';
import { devLog } from '@/lib/rpc';
import { useEngineStore } from '@/stores/engine.store';

export function StartupApp(): ReactNode {
  const init = useEngineStore((state) => state.init);
  const selfCheck = useEngineStore((state) => state.selfCheck);
  const restart = useEngineStore((state) => state.restart);
  const status = useEngineStore((state) => state.status);
  const info = useEngineStore((state) => state.info);
  const [handoffError, setHandoffError] = useState('');

  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    void init()
      .then((unlisten) => {
        if (active) {
          dispose = unlisten;
          return selfCheck();
        }
        unlisten();
      })
      .catch((error: unknown) => {
        devLog(`启动窗口初始化失败: ${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      active = false;
      dispose?.();
    };
  }, [init, selfCheck]);

  useEffect(() => {
    if (status !== 'ready') {
      return;
    }
    let active = true;
    async function showWorkspace(): Promise<void> {
      try {
        await invoke('finish_startup');
      } catch (error) {
        if (active) {
          setHandoffError(error instanceof Error ? error.message : String(error));
        }
      }
    }
    void showWorkspace();
    return () => {
      active = false;
    };
  }, [status]);

  return (
    <AppStartupScreen
      status={status}
      info={handoffError || info}
      onRetry={() => void selfCheck()}
      onRestart={() => void restart()}
    />
  );
}
