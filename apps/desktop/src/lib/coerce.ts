/** 把 flow 参数等未知值安全转成字符串（避免 `[object Object]`）。 */
export function coerceStr(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}
