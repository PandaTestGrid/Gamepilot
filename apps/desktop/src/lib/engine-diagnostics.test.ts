/**
 * 诊断文本：别人电脑上跑不起来时，这东西要能**一眼看懂 + 直接粘贴**。
 *
 * 守两件事：
 *   1. adb 那几项（路径 / 版本 / 5037 占用 / devices stderr）必须在里面 —— 那正是出事的地方；
 *   2. 缺项不留 `undefined` 这种噪音。
 */
import { describe, expect, it } from 'vitest';

import { formatDiagnostics } from '@/lib/engine-diagnostics';

const REPORT = {
  engine: { version: '0.0.1', protocol: 2, python: '3.13.5', platform: 'Windows-11', frozen: true },
  adb: {
    adbPath: 'C:\\Users\\me\\AppData\\Local\\Temp\\_MEI123\\adb\\adb.exe',
    adbExists: true,
    adbVersion: 'Android Debug Bridge version 1.0.41',
    adbVersionError: null,
    port5037Owner: 'adb.exe (PID 4321)',
    devices: ['List of devices attached', 'AGY7N19408000158\tunauthorized'],
    devicesError: 'adb server version (41) does not match this client (39)',
    devicesExit: 0,
  },
  paths: { tempDir: 'C:\\Users\\me\\AppData\\Local\\Temp', cwd: 'C:\\Program Files\\GamePilot' },
};

describe('engine-diagnostics：格式化', () => {
  it('adb 路径 / 版本 / 5037 / devices 都在，且没有 undefined', () => {
    const text = formatDiagnostics(REPORT);

    expect(text).toContain('adb（这台机器）');
    expect(text).toContain('路径: C:\\Users\\me\\AppData\\Local\\Temp\\_MEI123');
    expect(text).toContain('_MEI123');
    expect(text).toContain('Android Debug Bridge version 1.0.41');
    expect(text).toContain('adb.exe (PID 4321)');
    expect(text).toContain('unauthorized');
    expect(text).toContain('does not match this client');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('5037 没人听时写清楚"没人在听"，而不是留空', () => {
    const text = formatDiagnostics({ ...REPORT, adb: { ...REPORT.adb, port5037Owner: null } });
    expect(text).toContain('没人在听');
  });
});
