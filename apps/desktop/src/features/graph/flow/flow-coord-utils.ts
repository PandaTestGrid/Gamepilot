export function clampUnitCoord(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

export function formatCoordPair(x: unknown, y: unknown): string {
  const nx = Number(x ?? 0.5);
  const ny = Number(y ?? 0.5);
  return `${nx.toFixed(2)}, ${ny.toFixed(2)}`;
}
