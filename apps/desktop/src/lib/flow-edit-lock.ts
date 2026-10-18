/**
 * 运行中改图会 graph.save → 热重载，步骤链执行指针会被丢掉。
 * 当前这份工作流只要有设备在跑，结构编辑一律锁住。
 *
 * 不从 ui.store 引 workflowRootKey：graph.store 会用到这里，再引 ui.store 会顶层循环。
 */
export const FLOW_EDIT_LOCKED_HINT = '运行中不能修改流程图，请先停止';

function rootKey(value: string): string {
  return value
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

export function isWorkflowLive(
  root: string,
  runningWorkflowRoots: Readonly<Record<string, readonly string[] | undefined>>,
): boolean {
  const key = rootKey(root);
  if (!key) {
    return false;
  }
  return Object.values(runningWorkflowRoots).some((roots) =>
    (roots ?? []).some((item) => rootKey(item) === key),
  );
}
