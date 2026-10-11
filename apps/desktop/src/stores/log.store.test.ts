/**
 * 日志 store 的测试：两个来源（引擎通知 / 界面 devLog）混排、级别收窄、环形缓冲。
 * 日志本身不复杂，但它是"跑飞了之后唯一的现场"，字段错位会让排查变成误导。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { pushUiLog } from '@/lib/log-bus';
import { filterLogs, useLogStore } from '@/stores/log.store';

describe('日志 store', () => {
  beforeEach(() => {
    useLogStore.setState({ entries: [], minLevel: 'debug' });
  });

  it('引擎日志：level 支持 "WARNING" / 30 这类写法，字段缺失时不炸', () => {
    const appendEngine = useLogStore.getState().appendEngine;

    appendEngine({ level: 'WARNING', logger: 'gamepilot.session', message: '设备掉线', ts: 100 });
    appendEngine({ level: 40, message: '截图失败' });
    appendEngine({});

    const [warn, err, empty] = useLogStore.getState().entries;
    expect(warn).toMatchObject({
      level: 'warning',
      source: 'engine',
      logger: 'gamepilot.session',
      message: '设备掉线',
    });
    expect(err).toMatchObject({ level: 'error', logger: 'engine' });
    expect(empty?.message).toBe('');
    // ts 缺省时补当前时间，不能是 NaN
    expect(Number.isFinite(empty?.ts)).toBe(true);
  });

  it('界面日志：devLog 走总线进同一个列表（source=ui）', () => {
    const unsubscribe = useLogStore.getState().subscribeUi();
    pushUiLog('debug', 'ui', '画面栏分支: 有帧');
    unsubscribe();

    const entry = useLogStore.getState().entries[0];
    expect(entry).toMatchObject({ source: 'ui', level: 'debug', message: '画面栏分支: 有帧' });
  });

  it('取消订阅后不再收界面日志（组件卸载必须清干净）', () => {
    const unsubscribe = useLogStore.getState().subscribeUi();
    unsubscribe();
    pushUiLog('info', 'ui', '不该出现');

    expect(useLogStore.getState().entries).toHaveLength(0);
  });

  it('环形缓冲：只留最近 500 条', () => {
    const { append } = useLogStore.getState();
    for (let i = 0; i < 520; i += 1) {
      append({ ts: i, level: 'info', source: 'ui', logger: 'ui', message: `第 ${i} 条` });
    }

    const entries = useLogStore.getState().entries;
    expect(entries).toHaveLength(500);
    expect(entries[0]?.message).toBe('第 20 条');
    expect(entries[499]?.message).toBe('第 519 条');
  });

  it('级别过滤：信息+ 不显示 debug，错误只显示 error', () => {
    const entries = [
      { id: 1, ts: 1, level: 'debug' as const, source: 'ui' as const, logger: 'a', message: 'd' },
      { id: 2, ts: 2, level: 'warning' as const, source: 'ui' as const, logger: 'a', message: 'w' },
      { id: 3, ts: 3, level: 'error' as const, source: 'engine' as const, logger: 'b', message: 'e' },
    ];

    expect(filterLogs(entries, 'debug')).toHaveLength(3);
    expect(filterLogs(entries, 'info').map((item) => item.message)).toEqual(['w', 'e']);
    expect(filterLogs(entries, 'error').map((item) => item.message)).toEqual(['e']);
  });
});
