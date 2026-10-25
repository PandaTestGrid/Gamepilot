/**
 * 手动触控队列：iOS 的每次 touch 都要走子进程 IPC（几十毫秒），
 * 60Hz 的拖动不能把队列堆成几秒的滞后 —— 否则表现为「滑动不跟手 / 像没生效」。
 */
import { describe, expect, it, vi } from 'vitest';

import { queueManualInput } from '@/lib/manual-input';

/** 可手动放行的"慢 IPC"：模拟 iOS 单次命令的往返 */
function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('手动触控队列', () => {
  it('move 只保留最新一点：排队期间中间的点被覆盖，不逐条补发', async () => {
    const sent: number[] = [];
    const slow = deferred();
    let first = true;

    const send = (x: number) => (): Promise<void> => {
      sent.push(x);
      if (first) {
        first = false;
        return slow.promise;
      }
      return Promise.resolve();
    };

    const errors: unknown[] = [];
    const onError = (error: unknown): void => {
      errors.push(error);
    };

    // 第一条 move 卡在 IPC 上
    void queueManualInput('ios:1', 'move', send(1), onError);
    await Promise.resolve();
    // 期间又来了 40 个点：只应该保留最后一个
    for (let x = 2; x <= 41; x += 1) {
      void queueManualInput('ios:1', 'move', send(x), onError);
    }

    slow.release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent[0]).toBe(1);
    expect(sent.at(-1)).toBe(41);
    // 41 条输入被压缩到远少于 41 条（首条 + 合并后的最后一条）
    expect(sent.length).toBeLessThanOrEqual(3);
  });

  it('up 排在所有 move 之后，且拿到的是"这一笔已经失败过"的结论', async () => {
    const order: string[] = [];
    const onError = (error: unknown): void => {
      throw error;
    };

    await queueManualInput('ios:2', 'down', () => {
      order.push('down');
      return Promise.resolve();
    }, onError);
    await queueManualInput('ios:2', 'move', () => {
      order.push('move');
      return Promise.resolve();
    }, onError);
    const ok = await queueManualInput('ios:2', 'up', () => {
      order.push('up');
      return Promise.resolve();
    }, onError);

    expect(order).toEqual(['down', 'move', 'up']);
    expect(ok).toBe(true);
  });

  it('move 失败会记在这一次手势上，up 返回 false（录制据此决定要不要写这一步）', async () => {
    const onError = vi.fn();
    await queueManualInput('ios:3', 'down', () => Promise.resolve(), onError);
    await queueManualInput('ios:3', 'move', () => Promise.reject(new Error('iOS 控制通道未就绪')), onError);
    const ok = await queueManualInput('ios:3', 'up', () => Promise.resolve(), onError);

    expect(onError).toHaveBeenCalled();
    expect(ok).toBe(false);
  });
});


