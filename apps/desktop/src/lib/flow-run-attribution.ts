/**
 * 多设备下「谁在跑哪份工作流」的文案。
 *
 * 转圈只表示正在切换；稳定运行时要用设备名 + 工作流名，不能只写「运行中」。
 */
export interface FlowRunRunner {
  readonly id: string;
  readonly name: string;
}

export function deviceRunLabel(workflowNames: readonly string[]): string | null {
  if (workflowNames.length === 0) {
    return null;
  }
  return workflowNames.length === 1
    ? (workflowNames[0] ?? null)
    : `${workflowNames[0]} +${workflowNames.length - 1}`;
}
