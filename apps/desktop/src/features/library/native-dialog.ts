/**
 * 调 Tauri 原生的「选文件夹」对话框。
 *
 * 契约 v3 §3.3 的硬要求：**动态 import + try/catch**。原生对话框在浏览器 / vitest 里没有，
 * 插件没装、权限没给也会抛 —— 这些情况一律返回 `null`，由调用方退回"手输绝对路径"。
 * 失败时返回 null，由调用方显示手输路径表单。
 *
 * 说明：`@tauri-apps/plugin-dialog` 是可选依赖（顶层 dynamic import 会被打包器处理，
 * 装不上时这段 import 会 reject → 走 catch；配套的 Rust 侧装配见 src-tauri/）。
 */
type DialogModule = {
  open: (options: {
    directory?: boolean;
    multiple?: boolean;
    title?: string;
    defaultPath?: string;
  }) => Promise<unknown>;
};

/** 让原生对话框选一个目录；拿不到就返回 null（调用方必须能手输兜底）。 */
export async function pickDirectory(title = '选择工作区文件夹'): Promise<string | null> {
  try {
    const module = (await import('@tauri-apps/plugin-dialog')) as unknown as DialogModule;
    const picked = await module.open({ directory: true, multiple: false, title });
    if (typeof picked === 'string' && picked.trim()) {
      return picked.trim();
    }
    // multiple:false 时理论上回 string；万一是数组也只取第一项
    if (Array.isArray(picked) && typeof picked[0] === 'string' && picked[0].trim()) {
      return picked[0].trim();
    }
    return null;
  } catch {
    // 没装插件 / 不在 Tauri 里 / 权限不足：安静退回手输，不打断用户
    return null;
  }
}
