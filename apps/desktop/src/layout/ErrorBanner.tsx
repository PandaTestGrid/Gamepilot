import { ClipboardCopy, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { copyDiagnostics } from '@/lib/engine-diagnostics';
import { isUnknownMethodError, staleEngineHint } from '@/lib/engine-methods';
import { useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
import { useSessionStore } from '@/stores/session.store';

/**
 * 错误条：把"出了什么问题"直接摆在界面上。
 *
 * 之前这些错误只躺在 store 里没人显示，用户看到的就是"点了没反应"——
 * 连接失败、录制失败、运行失败、引擎起不来，全部走这一条。
 */
export function ErrorBanner(): ReactNode {
  const sessionError = useSessionStore((state) => state.error);
  const clearError = useSessionStore((state) => state.clearError);
  const scanError = useDeviceStore((state) => state.scanError);
  const engineStatus = useEngineStore((state) => state.status);
  const engineInfo = useEngineStore((state) => state.info);
  const missingMethods = useEngineStore((state) => state.missingMethods);
  const restartEngine = useEngineStore((state) => state.restart);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [copiedHint, setCopiedHint] = useState('');

  /*
   * 三种情况要分开说，因为"怎么修"不一样：
   *   1. 引擎是旧进程（方法表缺东西，或某个调用报了 -32601）→ 重启引擎，一键修
   *   2. 引擎起不来 → 重试（可能是依赖没装，文案里已经写了怎么办）
   *   3. 业务错误（连接/录制/运行失败）→ 原样显示
   */
  const staleEngine = missingMethods.length > 0 || isUnknownMethodError(sessionError);
  // 引擎超时（手机没授权 / adb 被杀软拦或被模拟器占）也走"引擎出的问题"这条路
  const engineTrouble =
    staleEngine || engineStatus === 'error' || Boolean(sessionError?.includes('引擎响应超时'));
  const message = staleEngine
    ? missingMethods.length > 0
      ? staleEngineHint(missingMethods)
      : `${sessionError ?? ''}（引擎不认识这个方法：它多半是应用启动时拉起的旧进程）`
    : // 引擎状态是 error 时，info 本身就是一句完整的话（启动失败 / 已退出 / 协议不匹配），
      // 这里原样显示 —— 再套一层"引擎启动失败："会把"引擎已退出"说成启动失败
      (sessionError ?? scanError ?? (engineStatus === 'error' ? engineInfo : null));

  if (!message || dismissed === message) {
    return null;
  }

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-failed/10 px-2 text-badge">
      <TriangleAlert className="size-3.5 shrink-0 text-failed" />
      <span className="min-w-0 flex-1 truncate text-failed">
        {message}
        {copiedHint ? ` · ${copiedHint}（直接粘给开发者）` : ''}
      </span>

      {engineTrouble && (
        <button
          type="button"
          title="把这台机器的环境快照（引擎 + adb 路径/版本 + 5037 占用 + 设备列表）复制到剪贴板，发给开发者即可"
          onClick={() => {
            void copyDiagnostics().then(({ copied }) => {
              setCopiedHint(copied ? '诊断已复制' : '诊断取到了，但剪贴板不可用');
            });
          }}
          className="flex shrink-0 items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 text-dim hover:bg-raised hover:text-fg"
        >
          <ClipboardCopy className="size-3" />
          复制诊断
        </button>
      )}

      {engineTrouble && (
        <button
          type="button"
          onClick={() => {
            setDismissed(message);
            clearError();
            void restartEngine();
          }}
          className="flex shrink-0 items-center gap-1 rounded-sm border border-failed/50 px-1.5 py-0.5 text-failed hover:bg-raised"
          title="停掉正在跑的引擎进程、拉起新的（会断开当前设备连接，重连即可）"
        >
          <RefreshCw className="size-3" />
          重启引擎
        </button>
      )}

      <button
        type="button"
        onClick={() => {
          setDismissed(message);
          clearError();
        }}
        className="flex shrink-0 items-center gap-1 text-dim hover:text-fg"
      >
        <X className="size-3" />
        知道了
      </button>
    </div>
  );
}
