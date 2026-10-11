/**
 * 引擎能力校验（"引擎是旧进程"这一类问题的守门人）。
 *
 * 真实场景：引擎由 Tauri 壳在应用启动时拉起并一直活着，代码更新后正在跑的那个仍是旧的，
 * 界面点「新建脚本」就收到 `-32601 未知方法: project.create`。这里守住三件事：
 *   1. 缺方法能被识别出来（而不是等用户点某个按钮才炸）；
 *   2. 拿不到方法表时**不乱报**（老引擎不报这个字段，别把正常情况当故障）；
 *   3. 错误信息里的 -32601 / 未知方法 能被认出来，并给出一句能照做的话。
 */
import { describe, expect, it } from 'vitest';

import {
  isUnknownMethodError,
  missingEngineMethods,
  REQUIRED_ENGINE_METHODS,
  staleEngineHint,
} from '@/lib/engine-methods';

describe('引擎能力校验', () => {
  it('方法表齐全 → 不缺任何东西', () => {
    expect(missingEngineMethods([...REQUIRED_ENGINE_METHODS, 'device.list'])).toEqual([]);
  });

  it('老引擎的方法表（只有 project.get/set/list）→ 缺 4 个库方法', () => {
    const legacy = [
      'device.list',
      'device.connect',
      'project.get',
      'project.list',
      'project.set',
      'run.start',
    ];
    expect(missingEngineMethods(legacy)).toEqual([
      'project.create',
      'project.duplicate',
      'project.rename',
      'project.delete',
    ]);
  });

  it('拿不到方法表（undefined/空）时不乱报：交给具体调用去暴露问题', () => {
    expect(missingEngineMethods(undefined)).toEqual([]);
    expect(missingEngineMethods(null)).toEqual([]);
  });

  it('认得出 -32601 / 中文"未知方法"两种写法', () => {
    expect(isUnknownMethodError('引擎返回错误: {"code":-32601,"message":"未知方法: project.create"}')).toBe(
      true,
    );
    expect(isUnknownMethodError('未知方法: project.create')).toBe(true);
    expect(isUnknownMethodError('设备未连接: mock:1')).toBe(false);
    expect(isUnknownMethodError(null)).toBe(false);
  });

  it('提示语要写清"是什么问题 + 怎么修"', () => {
    const hint = staleEngineHint(['project.create', 'project.duplicate']);
    expect(hint).toContain('旧进程');
    expect(hint).toContain('project.create');
    expect(hint).toContain('重启引擎');
    expect(hint).toContain('断开当前设备连接');
  });

  it('缺很多方法时只列前三个，避免把错误条撑爆', () => {
    const hint = staleEngineHint(['a', 'b', 'c', 'd', 'e']);
    expect(hint).toContain('a、b、c');
    expect(hint).toContain('等 5 个');
    expect(hint).not.toContain('d、e');
  });
});
