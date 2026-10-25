/**
 * 前端依赖的引擎能力清单（**引擎进程是独立的，很容易跑到旧版本上**）。
 *
 * 握手时对比方法表；新增前端 RPC 时在此登记一行。
 * 只列"界面直接依赖"的方法；纯引擎内部方法不用列。
 */
export const REQUIRED_ENGINE_METHODS: readonly string[] = [
  // 工作区层（v4：可以有多个，一个工作区 = 用户选的一个文件夹）+ 当前工作区的树
  'workspace.tree',
  'workspace.list',
  'workspace.add',
  'workspace.remove',
  // 工作流层（工作流 = 一张流程图 = graph.json + templates/）
  'workflow.create',
  'workflow.rename',
  'workflow.delete',
  'workflow.duplicate',
  // 识别器：搜索范围（模板默认全屏 / 区域）—— 旧引擎没有它时，
  // 界面上的「全屏」只是本地勾选，引擎仍按原区域搜，滚动后必然未命中
  'recognizer.search',
  // AI 识别器：不录模板直接注册 + 可选组件（旧引擎没有这些方法时，界面按"不支持"处理）
  'recognizer.create',
  'yolo.status',
  'yolo.warmup',
  'yolo.install',
  'yolo.remove',
  // AI 识别弹窗的实时检测预览 / 模型切换
  'recognizer.preview',
  'yolo.models',
  'yolo.model.set',
  'yolo.model.add',
  'recognizer.detail',
  'recognizer.update',
  'recognizer.frames.meta',
  'recognizer.frame',
  // AI 弹窗的无帧数上限录制：独立持久化及分页/逐帧读取
  'recording.start',
  'recording.stop',
  'recording.meta',
  'recording.frameAt',
  'recording.delete',
  // 本机窗口选择器：Windows / macOS 统一枚举（旧引擎只有 mac.windows，Windows 上挑不到窗口）
  'window.list',
];

/** 引擎方法表里缺了哪些前端需要的方法（空数组 = 兼容）。 */
export function missingEngineMethods(known: readonly string[] | undefined | null): string[] {
  if (!known) {
    return []; // 拿不到方法表（老引擎不报这个字段）时不乱报错，交给具体调用去暴露问题
  }
  const set = new Set(known);
  return REQUIRED_ENGINE_METHODS.filter((method) => !set.has(method));
}

/** 错误信息里是否是"引擎不认识这个方法"（JSON-RPC -32601）。 */
export function isUnknownMethodError(message: string | null | undefined): boolean {
  if (!message) {
    return false;
  }
  return message.includes('-32601') || message.includes('未知方法');
}

/** 给用户看的一句话（含怎么修）。 */
export function staleEngineHint(missing: readonly string[]): string {
  const list = missing.slice(0, 3).join('、');
  const more = missing.length > 3 ? ` 等 ${missing.length} 个` : '';
  return `引擎是旧进程：它不认识 ${list}${more}。点「重启引擎」即可（会断开当前设备连接，重连一下就行）`;
}
