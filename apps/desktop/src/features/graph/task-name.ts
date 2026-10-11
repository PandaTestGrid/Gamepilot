/**
 * 状态图的名字 = 它所在目录的名字。
 *
 * 引擎也是这么算的（`workspaces._task_summary` 里 `os.path.basename(task_dir)`），
 * 标签条、空态、以后的窗口标题都从这里取，别各自 `split('/')` 一遍。
 */
export function taskName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}
