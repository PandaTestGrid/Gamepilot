/** 保持触控事件顺序；录制收尾等待设备确认，不重复发送输入。 */
const inputs = new Map<string, Promise<boolean>>();
const failures = new Set<string>();
export function queueManualInput(
  device: string,
  phase: 'down' | 'move' | 'up',
  input: () => Promise<unknown>,
  onError: (error: unknown) => void,
): Promise<boolean> {
  const previous = inputs.get(device) ?? Promise.resolve(true);
  const next = previous.then(async () => {
    if (phase === 'down') failures.delete(device);
    try {
      await input();
      return !failures.has(device);
    } catch (error) {
      failures.add(device);
      onError(error);
      return false;
    }
  });
  inputs.set(device, next);
  return next;
}
