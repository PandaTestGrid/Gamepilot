/**
 * 调 Tauri 原生的「选文件夹」对话框。
 *
 * 契约 v3 §3.3 的硬要求：**动态 import + try/catch**。原生对话框在浏览器 / vitest 里没有，
 * 插件没装、权限没给也会抛 —— 这些情况一律返回 `unavailable`，由调用方退回"手输绝对路径"。
 *
 * 三种结果必须分开，否则用户点了「取消」会看到一句"选择器不可用"的假故障：
 *   - `picked`：选了目录
 *   - `cancelled`：对话框正常弹出、用户点了取消（什么都不该发生）
 *   - `unavailable`：插件/权限/环境问题，需要露出路径输入框
 */
type DialogModule = {
  open: (options: {
    directory?: boolean;
    multiple?: boolean;
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<unknown>;
};

export type DirectoryPick =
  | { readonly kind: 'picked'; readonly path: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** 让原生对话框选一个目录；拿不到就说明原因（调用方必须能手输兜底）。 */
export async function pickDirectoryResult(title = '选择工作区文件夹'): Promise<DirectoryPick> {
  let module: DialogModule;
  try {
    module = await import('@tauri-apps/plugin-dialog');
  } catch (error) {
    return { kind: 'unavailable', reason: `插件加载失败：${describe(error)}` };
  }
  try {
    const picked = await module.open({ directory: true, multiple: false, title });
    if (typeof picked === 'string' && picked.trim()) {
      return { kind: 'picked', path: picked.trim() };
    }
    // multiple:false 时理论上回 string；万一是数组也只取第一项
    if (Array.isArray(picked) && typeof picked[0] === 'string' && picked[0].trim()) {
      return { kind: 'picked', path: picked[0].trim() };
    }
    return { kind: 'cancelled' };
  } catch (error) {
    return { kind: 'unavailable', reason: describe(error) };
  }
}

/** 兼容旧调用点：只要路径（取消/不可用都是 null）。 */
export async function pickDirectory(title = '选择工作区文件夹'): Promise<string | null> {
  const result = await pickDirectoryResult(title);
  return result.kind === 'picked' ? result.path : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type FilePick =
  | { readonly kind: 'picked'; readonly path: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** 让原生对话框选一个文件（目前用于"从本地 zip 安装 AI 组件"）。 */
export async function pickFileResult(title: string, extensions: readonly string[]): Promise<FilePick> {
  let module: DialogModule;
  try {
    module = await import('@tauri-apps/plugin-dialog');
  } catch (error) {
    return { kind: 'unavailable', reason: `插件加载失败：${describe(error)}` };
  }
  try {
    const picked = await module.open({
      directory: false,
      multiple: false,
      title,
      filters: [{ name: extensions.join(' / '), extensions: [...extensions] }],
    });
    if (typeof picked === 'string' && picked.trim()) {
      return { kind: 'picked', path: picked.trim() };
    }
    if (Array.isArray(picked) && typeof picked[0] === 'string' && picked[0].trim()) {
      return { kind: 'picked', path: picked[0].trim() };
    }
    return { kind: 'cancelled' };
  } catch (error) {
    return { kind: 'unavailable', reason: describe(error) };
  }
}
