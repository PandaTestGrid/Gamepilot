/**
 * 脚本名规则：与引擎 `library.validate_name` **同一套**（前端先拦一道，引擎仍是最终裁判）。
 *
 * 单独一个纯模块：表单、测试、将来的"导入脚本"都复用它，不重复写规则。
 */
export const SCRIPT_NAME_MAX = 64;
const ILLEGAL = /[/\\:*?"<>|]/;

export function scriptNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return '名字不能为空';
  }
  if (trimmed.length > SCRIPT_NAME_MAX) {
    return `名字最长 ${SCRIPT_NAME_MAX} 个字符`;
  }
  if (ILLEGAL.test(trimmed)) {
    return '不能包含 / \\ : * ? " < > | 这些字符';
  }
  if (trimmed.startsWith('.') || trimmed.endsWith('.')) {
    return '不能以点开头或结尾';
  }
  return null;
}
