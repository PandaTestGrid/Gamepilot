/**
 * 引擎能力校验（"引擎是旧进程"这一类问题的守门人）。
 *
 * 真实场景：引擎由 Tauri 壳在应用启动时拉起并一直活着，代码更新后正在跑的那个仍是旧的，
 * 界面点「新建工作流」就收到 `-32601 未知方法: workflow.create`。这里守住三件事：
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

  it('老引擎的方法表（v4 之前的契约）→ 缺工作区层与工作流层的方法', () => {
    // 老引擎只有 project.get/set（当前工作流的读写）与 workspace.tree
    const legacy = ['device.list', 'device.connect', 'project.get', 'project.set', 'workspace.tree'];
    expect(missingEngineMethods(legacy)).toEqual([
      'workspace.list',
      'workspace.add',
      'workspace.remove',
      'workflow.create',
      'workflow.rename',
      'workflow.delete',
      'workflow.duplicate',
      'recognizer.search',
      'recognizer.create',
      'yolo.status',
      'yolo.warmup',
      'yolo.install',
      'yolo.remove',
      'recognizer.preview',
      'yolo.models',
      'yolo.model.set',
      'yolo.model.add',
      'recognizer.detail',
      'recognizer.update',
      'recognizer.frames.meta',
      'recognizer.frame',
      'recording.start',
      'recording.stop',
      'recording.meta',
      'recording.frameAt',
      'recording.delete',
      'window.list',
      
    ]);
  });

  it('能力清单 = v4 八个方法 + 识别器/组件/本机窗口方法（老的层级名不该再出现）', () => {
    expect([...REQUIRED_ENGINE_METHODS]).toEqual([
      'workspace.tree',
      'workspace.list',
      'workspace.add',
      'workspace.remove',
      'workflow.create',
      'workflow.rename',
      'workflow.delete',
      'workflow.duplicate',
      'recognizer.search',
      'recognizer.create',
      'yolo.status',
      'yolo.warmup',
      'yolo.install',
      'yolo.remove',
      'recognizer.preview',
      'yolo.models',
      'yolo.model.set',
      'yolo.model.add',
      'recognizer.detail',
      'recognizer.update',
      'recognizer.frames.meta',
      'recognizer.frame',
      'recording.start',
      'recording.stop',
      'recording.meta',
      'recording.frameAt',
      'recording.delete',
      'window.list',
      
    ]);
  });

  it('旧引擎即使支持原有方法，也必须提示缺少新录制接口', () => {
    const old = REQUIRED_ENGINE_METHODS.filter((method) => !method.startsWith('recording.'));
    expect(missingEngineMethods(old)).toEqual([
      'recording.start',
      'recording.stop',
      'recording.meta',
      'recording.frameAt',
      'recording.delete',
    ]);
  });

  it('工作区层依赖四个方法：tree（画树）+ list/add/remove（面板）', () => {
    const workspaceMethods = REQUIRED_ENGINE_METHODS.filter((method) => method.startsWith('workspace.'));
    expect(workspaceMethods).toEqual([
      'workspace.tree',
      'workspace.list',
      'workspace.add',
      'workspace.remove',
    ]);
  });

  it('拿不到方法表（undefined/空）时不乱报：交给具体调用去暴露问题', () => {
    expect(missingEngineMethods(undefined)).toEqual([]);
    expect(missingEngineMethods(null)).toEqual([]);
  });

  it('认得出 -32601 / 中文"未知方法"两种写法', () => {
    expect(isUnknownMethodError('引擎返回错误: {"code":-32601,"message":"未知方法: workflow.create"}')).toBe(
      true,
    );
    expect(isUnknownMethodError('未知方法: workflow.create')).toBe(true);
    expect(isUnknownMethodError('设备未连接: mock:1')).toBe(false);
    expect(isUnknownMethodError(null)).toBe(false);
  });

  it('提示语要写清"是什么问题 + 怎么修"', () => {
    const hint = staleEngineHint(['workflow.create', 'workflow.duplicate']);
    expect(hint).toContain('旧进程');
    expect(hint).toContain('workflow.create');
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
