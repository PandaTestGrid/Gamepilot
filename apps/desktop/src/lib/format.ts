/** 展示层格式化：所有"可能没有值"的字段都收敛到这里，避免组件里散落 `?? '—'`。 */

export function formatResolution(resolution: readonly [number, number] | null): string {
  return resolution ? `${resolution[0]}×${resolution[1]}` : '—';
}

export function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false });
}

export function formatScore(score: number): string {
  return score.toFixed(2);
}
