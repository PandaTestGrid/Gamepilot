/**
 * 手动触控的发送队列。
 *
 * 两条硬要求：
 *   1. **顺序**：down → move… → up 不能乱序（乱序的 up 会变成"按在别处的手指点了一下"）。
 *   2. **不能被 move 拖垮**：iOS 的每次 `device.touch` 都是一次子进程 IPC 往返
 *      （`ios_worker` 的 `_command` 要等 HID 真的发出去），单次几十毫秒。
 *      如果每个 move 都排队，60Hz 的拖动会瞬间堆出几十条待发命令 ——
 *      手已经抬起来了，队列里还在补几秒前的点，表现就是**iOS 滑动不跟手/像是没生效**。
 *
 * 所以 move 采用「最新一点覆盖旧的」：
 *   - 同一时刻最多一条 move 在路上；
 *   - 排队期间又来了 move，只保留最后一个坐标（中间点对手势没有意义）；
 *   - down / up 仍然严格排队 —— up 会等 drain 完再发，保证对端收到的是完整一笔。
 *
 * 安卓 scrcpy 的 touch 只要 ~1ms，这个策略对它没有副作用（本来就来不及堆）。
 */

interface DeviceInput {
  /** 串行链：down / up / drain 都挂在这上面 */
  chain: Promise<boolean>;
  /** 还没发出去的最新 move（覆盖式） */
  pendingMove: (() => Promise<unknown>) | null;
  /** drain 循环是否已在链上排好（避免每次 move 都往链里塞一段） */
  draining: boolean;
  /** 本次手势是否已经失败过（up 的返回值据此决定要不要录这一笔） */
  failed: boolean;
}

const devices = new Map<string, DeviceInput>();

function stateFor(device: string): DeviceInput {
  let state = devices.get(device);
  if (!state) {
    state = { chain: Promise.resolve(true), pendingMove: null, draining: false, failed: false };
    devices.set(device, state);
  }
  return state;
}

export function queueManualInput(
  device: string,
  phase: 'down' | 'move' | 'up',
  input: () => Promise<unknown>,
  onError: (error: unknown) => void,
): Promise<boolean> {
  const state = stateFor(device);

  if (phase === 'move') {
    state.pendingMove = input;
    if (!state.draining) {
      state.draining = true;
      state.chain = state.chain.then(async () => {
        // drain：把排队期间"最后"那一点发出去，中间的直接丢掉
        while (state.pendingMove) {
          const next = state.pendingMove;
          state.pendingMove = null;
          try {
            await next();
          } catch (error) {
            state.failed = true;
            onError(error);
          }
        }
        state.draining = false;
        return !state.failed;
      });
    }
    return state.chain.then(() => !state.failed);
  }

  // down / up：严格排在已有命令之后
  state.chain = state.chain.then(async () => {
    if (phase === 'down') {
      state.failed = false;
    }
    try {
      await input();
      return !state.failed;
    } catch (error) {
      state.failed = true;
      onError(error);
      return false;
    }
  });
  return state.chain;
}
