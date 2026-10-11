/**
 * 工作流名规则：与引擎 `library.validate_name` **同一套**（前端先拦一道，引擎仍是最终裁判）。
 *
 * 单独一个纯模块：表单、测试都复用它，不重复写规则。工作区的名字也走同一套规则。
 */
export const WORKFLOW_NAME_MAX = 64;
const ILLEGAL = /[/\\:*?"<>|]/;

export function workflowNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return '名字不能为空';
  }
  if (trimmed.length > WORKFLOW_NAME_MAX) {
    return `名字最长 ${WORKFLOW_NAME_MAX} 个字符`;
  }
  if (ILLEGAL.test(trimmed)) {
    return '不能包含 / \\ : * ? " < > | 这些字符';
  }
  if (trimmed.startsWith('.') || trimmed.endsWith('.')) {
    return '不能以点开头或结尾';
  }
  return null;
}
