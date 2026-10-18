/** 引擎当前加载的工作流目录（避免 graph.store ↔ session.store 循环依赖）。 */
let activeWorkflowRoot = '';

export function setActiveWorkflowRoot(root: string): void {
  activeWorkflowRoot = root.replace(/[\\/]+$/, '');
}

export function getActiveWorkflowRoot(): string {
  return activeWorkflowRoot;
}
