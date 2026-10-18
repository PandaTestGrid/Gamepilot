/** 展示层格式化：所有"可能没有值"的字段都收敛到这里，避免组件里散落 `?? '—'`。 */

export function formatResolution(resolution: readonly [number, number] | null): string {
  return resolution ? `${resolution[0]}×${resolution[1]}` : '—';
}
