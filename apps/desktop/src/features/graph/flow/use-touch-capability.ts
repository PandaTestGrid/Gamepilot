import { useDeviceStore } from '@/stores/device.store';

/** Capability is advisory for editing; only connected device reports constrain choices. */
export function useTouchCapability() {
  const device = useDeviceStore((state) => state.devices.find((item) => item.id === state.activeId));
  const capabilities = device?.status === 'connected' ? device.capabilities : undefined;
  const unsupported = capabilities?.multiTouch === false || capabilities?.maxTouchPoints === 0;
  const reported = capabilities?.maxTouchPoints;
  const max = !unsupported && capabilities?.multiTouch === true && typeof reported === 'number'
    && Number.isFinite(reported) && reported > 0 ? Math.min(10, Math.floor(reported)) : 10;
  const known = !unsupported && capabilities?.multiTouch === true && typeof reported === 'number' && reported > 0;
  const hint = unsupported ? '当前设备不支持多指触控'
    : known ? `当前设备最多支持 ${max} 指触控`
    : '运行时需支持多指触控的 Android/scrcpy 设备';
  return { unsupported, max, known, hint };
}
