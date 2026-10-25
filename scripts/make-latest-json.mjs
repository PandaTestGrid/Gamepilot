#!/usr/bin/env node
/**
 * 生成 Tauri updater 的 latest.json。
 *
 * 只负责“把已签名产物和签名拼成更新清单”，不构建、不上传：
 *   1. 先按 docs/updater.md 用签名私钥执行 `tauri build`；
 *   2. 把 bundle/macos 下的 `.app.tar.gz` 和 `.app.tar.gz.sig` 上传到 Release；
 *   3. 运行本脚本，把生成的 latest.json 一起上传到同一个 Release。
 *
 * 用法：
 *   node scripts/make-latest-json.mjs \
 *     --version 0.1.0 \
 *     --base-url https://github.com/PandaTestGrid/Gamepilot/releases/download/v0.1.0 \
 *     --notes "修复 xxx" \
 *     --out latest.json
 *
 * 默认适配 macOS arm64（当前构建机）。Windows 构建时用
 * `--platform windows-x86_64 --artifact <setup.nsis.zip>` 生成对应条目。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function fail(message) {
  console.error(`make-latest-json: ${message}`);
  process.exit(1);
}

const version = arg('version');
const baseUrl = arg('base-url');
if (!version || !baseUrl) {
  fail('缺少 --version 或 --base-url');
}

const platform = arg('platform', 'darwin-aarch64');
const out = resolve(arg('out', 'latest.json'));
const notes = arg('notes', '');
const bundleDir = resolve(arg('bundle-dir', 'apps/desktop/src-tauri/target/release/bundle/macos'));

let artifact = arg('artifact');
if (!artifact) {
  if (!existsSync(bundleDir)) {
    fail(`找不到 macOS 产物目录: ${bundleDir}`);
  }
  const candidates = readdirSync(bundleDir)
    .filter((name) => name.endsWith('.app.tar.gz'))
    .map((name) => join(bundleDir, name));
  if (candidates.length !== 1) {
    fail(`期望一个 .app.tar.gz，实际 ${candidates.length} 个；请用 --artifact 指定`);
  }
  artifact = candidates[0];
}

const signatureFile = `${artifact}.sig`;
if (!existsSync(artifact)) {
  fail(`找不到产物: ${artifact}`);
}
if (!existsSync(signatureFile)) {
  fail(`找不到签名: ${signatureFile}（tauri build 必须设置 TAURI_SIGNING_PRIVATE_KEY）`);
}

const signature = readFileSync(signatureFile, 'utf8').trim();
if (!signature) {
  fail(`签名为空: ${signatureFile}`);
}

const url = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(basename(artifact))}`;
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    [platform]: {
      signature,
      url,
    },
  },
};

writeFileSync(out, `${JSON.stringify(latest, null, 2)}\n`, 'utf8');
console.log(`已写入 ${out}`);
console.log(`  platform: ${platform}`);
console.log(`  version:  ${version}`);
console.log(`  artifact: ${artifact}`);
console.log(`  url:      ${url}`);
