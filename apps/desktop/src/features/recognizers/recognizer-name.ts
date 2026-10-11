/**
 * 识别器名字的**前端预校验**（纯逻辑）。
 *
 * 为什么前端还要校验一遍：引擎那边（`core/graph.py: validate_recognizer_label`）才是
 * 权威 —— 它还要检查"引用冲突""保存失败"这些前端看不见的事。但改名是一次**写文件**的操作，
 * 让用户敲完回车等一个来回才知道"名字不能带 /"，体验很差。所以这里做同规则的即时反馈，
 * 引擎报错照样会显示（错误条 + 事件栏）。
 *
 * 规则必须和引擎保持一致（改一边就要改另一边）：
 * - 去掉首尾空白后 1~48 个字符
 * - 不能带 `/` `\`（录制时它会变成模板文件名 `templates/<名字>.png`）
 * - 不能带控制字符；不能用保留名 `always`（那是"无条件边"的哨兵值）
 */

export const RECOGNIZER_NAME_MAX = 48;

/** "无条件边"的哨兵值（引擎 `conditions.ALWAYS_LABEL`），拿它当识别器名字会产生歧义 */
export const RESERVED_LABEL = 'always';

export function trimRecognizerName(value: string): string {
  return value.trim();
}

/**
 * 校验新名字；返回错误文案，通过时返回 null。
 *
 * `current` 是这一行原来的名字（改成自己不算重名），`existing` 是当前所有识别器的名字。
 */
export function checkRecognizerName(
  value: string,
  options: { readonly current: string; readonly existing: readonly string[] },
): string | null {
  const name = trimRecognizerName(value);
  if (!name) {
    return '名字不能为空';
  }
  if (name.length > RECOGNIZER_NAME_MAX) {
    return `名字太长（最多 ${RECOGNIZER_NAME_MAX} 个字符）`;
  }
  if (name.includes('/') || name.includes('\\')) {
    return '名字不能带 / 或 \\（它会变成模板文件名）';
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return '名字不能带控制字符';
  }
  if (name === RESERVED_LABEL) {
    return `「${RESERVED_LABEL}」是保留名（表示无条件边），换一个`;
  }
  if (name !== options.current && options.existing.includes(name)) {
    return `已经有同名识别器：${name}`;
  }
  return null;
}
