/**
 * 每台已连接设备该推多少帧：主窗口、独立窗口、多开网格共用这一份规则。
 *
 * 独立窗口绝不能把别的设备设成 0fps —— 主窗口还在用那些画面。
 * 返回 `null` 表示「这台设备的策略别动」。
 */
import type { PaneKind } from '@/lib/windows';

/**
 * 单台画面（主窗口 / 独立画面窗口）的推流帧率。
 *
 * 引擎 scrcpy 通道的采集循环上限是 30fps（`session.py` 的 SCRCPY_LOOP_FPS），
 * 这里跟它对齐：低于它，界面就白等了一半的拍子。取帧是**事件驱动**的
 * （收到 engine.frame 立刻拉字节），所以这个数只决定引擎推帧的节奏，
 * 不额外引入轮询延迟。
 *
 * 多开网格另有 gridFps（4~6）；调这一档只影响"只有一台设备在看"的场景。
 */
export const PREVIEW_FPS = 30;

export function streamFpsForDevice(input: {
  readonly deviceId: string;
  readonly activeId: string;
  readonly windowed: boolean;
  readonly grid: boolean;
  readonly gridFps: number;
  readonly windowHidden: boolean;
  readonly pane: PaneKind | null;
  readonly paneDeviceId: string | null;
}): number | null {
  if (input.pane) {
    if (input.pane === 'screen' && input.deviceId === input.paneDeviceId) {
      return PREVIEW_FPS;
    }
    return null;
  }
  if (input.windowed) {
    return input.grid ? input.gridFps : PREVIEW_FPS;
  }
  if (input.windowHidden) {
    return 0;
  }
  if (input.grid) {
    return input.gridFps;
  }
  return input.deviceId === input.activeId ? PREVIEW_FPS : 0;
}
