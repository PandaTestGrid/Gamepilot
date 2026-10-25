/**
 * 把 \`engine.diagnostics\` 的快照拍成一小段**能直接粘贴**的文字。
 *
 * 为什么要它：引擎在别人电脑上跑不起来时，我们最需要的是"这台机器的 adb 长什么样"
 * （自带 adb 被杀软拦、5037 被模拟器占、手机没授权、没装驱动），而让人去找日志文件、
 * 再发过来，来回就是好几轮。这里一次复制全带上。
 */
import { engineDiagnostics } from '@/lib/rpc';

function section(title: string, rows: readonly (readonly [string, unknown])[]): string[] {
  const lines = rows
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `  ${key}: ${Array.isArray(value) ? value.join(' | ') : String(value)}`);
  return lines.length > 0 ? [`${title}:`, ...lines] : [];
}

/** 纯函数：快照 → 文本（可单测） */
export function formatDiagnostics(report: Record<string, unknown>): string {
  const engine = (report.engine ?? {}) as Record<string, unknown>;
  const adb = (report.adb ?? {}) as Record<string, unknown>;
  const paths = (report.paths ?? {}) as Record<string, unknown>;
  return [
    'GamePilot 诊断（把这段整段发给开发者）',
    `时间: ${new Date().toISOString()}`,
    ...section('引擎', [
      ['版本', engine.version],
      ['协议', engine.protocol],
      ['Python', engine.python],
      ['系统', engine.platform],
      ['打包态', engine.frozen],
      ['解压目录', engine.bundleRoot],
    ]),
    ...section('adb（这台机器）', [
      ['路径', adb.adbPath],
      ['文件存在', adb.adbExists],
      ['版本', adb.adbVersion],
      ['版本报错', adb.adbVersionError],
      ['5037 端口', adb.port5037Owner ?? '没人在听'],
      ['环境变量', adb.adbFromEnv],
      ['devices 退出码', adb.devicesExit],
      ['devices stderr', adb.devicesError],
      ['devices', Array.isArray(adb.devices) ? adb.devices.join(' ⏎ ') : adb.devices],
    ]),
    ...section('路径', [
      ['adb 目录', paths.adbDir],
      ['scrcpy-server', paths.scrcpyServer],
      ['OCR 模型', paths.ocrModelDir],
      ['临时目录', paths.tempDir],
      ['工作目录', paths.cwd],
    ]),
  ].join('\n');
}

/** 取快照 + 写剪贴板，返回那段文字（写剪贴板失败也返回文字，调用方自己提示） */
export async function copyDiagnostics(): Promise<{ text: string; copied: boolean }> {
  const text = formatDiagnostics(await engineDiagnostics());
  try {
    await navigator.clipboard?.writeText(text);
    return { text, copied: true };
  } catch {
    return { text, copied: false };
  }
}
