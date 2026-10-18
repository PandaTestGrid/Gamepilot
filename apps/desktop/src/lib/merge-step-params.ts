/** 合并 flow 步骤 params；patch 里显式 `undefined` 表示删除该字段 */
export function mergeStepParams(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...base, ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete next[key];
    }
  }
  return next;
}
