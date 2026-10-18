import { describe, expect, it } from 'vitest';

import { emulatorDisplaysFor } from '@/features/device/emulator-displays';
import type { DeviceRuntime } from '@/types';

function device(id: string, uri: string, kind: DeviceRuntime['kind'] = 'emulator'): DeviceRuntime {
  return { id, uri, kind, name: id, status: 'discovered', resolution: null, fps: 0 };
}

describe('模拟器窗口分组', () => {
  it('按 URI 的 serial 分组、按逻辑屏号排序，保留应用包名', () => {
    const main = device('android:192.168.1.2:5555', 'Android:///?serial=192.168.1.2%3A5555');
    const game = {
      ...device('android:192.168.1.2:5555:4', 'Android:///?serial=192.168.1.2%3A5555&display=4'),
      name: 'MuMu · 屏4 · com.netease.onmyoji',
    };
    const other = device('android:emulator-5556:7', 'Android:///?serial=emulator-5556&display=7');
    const displays = emulatorDisplaysFor([game, other, main], game);

    expect(displays.map((item) => [item.id, item.device.id, item.app])).toEqual([
      [0, main.id, null],
      [4, game.id, 'com.netease.onmyoji'],
    ]);
  });

  it('只有主屏时模拟器仍给刷新入口；普通单屏手机不显示切屏栏', () => {
    const emulator = device('android:emulator-5554', 'Android:///?serial=emulator-5554');
    const phone = device('android:3387980', 'Android:///?serial=3387980', 'android');
    expect(emulatorDisplaysFor([emulator], emulator).map((item) => item.id)).toEqual([0]);
    expect(emulatorDisplaysFor([phone], phone)).toEqual([]);
  });

  it('手机外接多屏也能切；无效 display 参数不会变成屏 0', () => {
    const phone = device('android:3387980', 'Android:///?serial=3387980', 'android');
    const second = device('android:3387980:3', 'Android:///?serial=3387980&display=3', 'android');
    const invalid = device('android:3387980:bad', 'Android:///?serial=3387980&display=bad');
    expect(emulatorDisplaysFor([invalid, second, phone], phone).map((item) => item.id)).toEqual([0, 3]);
    expect(emulatorDisplaysFor([invalid], invalid)).toEqual([]);
  });
});
