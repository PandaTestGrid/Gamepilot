/**
 * 前端依赖的引擎能力清单（**引擎进程是独立的，很容易跑到旧版本上**）。
 *
 * 背景（真踩过）：引擎由 Tauri 壳在应用启动时拉起，之后一直活着。
 * 代码更新（比如新增 `project.create`）后，**正在跑的那个进程仍然是旧的** ——
 * 界面点「新建脚本」就收到 `-32601 未知方法: project.create`。
 * 引擎在握手（`engine.ready`）与 `engine.info` 里都会带上方法表，所以这里做能力校验，
 * 缺方法就明确告诉用户"引擎是旧进程，重启即可"，而不是丢一个 JSON-RPC 错误码给用户。
 *
 * 规则：**新增一个前端会调用的 RPC 方法时，往下面这张表里加一行**。
 * 只列"界面直接依赖"的方法；纯引擎内部方法不用列。
 */
export const REQUIRED_ENGINE_METHODS: readonly string[] = [
  // 脚本库（多状态图）
  'project.create',
  'project.duplicate',
  'project.rename',
  'project.delete',
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
