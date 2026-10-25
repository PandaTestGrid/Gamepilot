# 桌面端自动更新（Tauri Updater）

GamePilot 使用 Tauri v2 官方 updater：应用启动后检查 `latest.json`，发现更高版本时在右下角提示；用户确认后下载签名包、安装并重启。

不是 Python 代码热重载。运行中的引擎、设备连接和工作流会随重启中断。

## 已经接好的部分

- Rust 插件：`tauri-plugin-updater`、`tauri-plugin-process`
- 前端：`apps/desktop/src/features/updater/UpdateBanner.tsx`
- 权限：`apps/desktop/src-tauri/capabilities/default.json` 的 `updater:default`、`process:default`
- 配置：`apps/desktop/src-tauri/tauri.conf.json`
  - `bundle.createUpdaterArtifacts: true`
  - `plugins.updater.pubkey`
  - `plugins.updater.endpoints`
    - `https://github.com/PandaTestGrid/Gamepilot/releases/latest/download/latest.json`
- 清单生成：`scripts/make-latest-json.mjs`

## 签名密钥（只生成一次）

公钥已经写进 `tauri.conf.json`。私钥**不能提交到仓库**。

本机生成的文件：

```text
~/.tauri/gamepilot-updater.key          # 私钥，备份到密码管理器
~/.tauri/gamepilot-updater.key.pub      # 公钥
~/.tauri/gamepilot-updater.password     # 私钥密码
```

私钥丢失后，已经发布的客户端将无法验证新包，只能让用户手动重装。请立刻备份 `.key` 和密码。

## 发版步骤（macOS Apple Silicon）

### 1. 提升版本号

需要同时改：

- `apps/desktop/src-tauri/tauri.conf.json` 的 `version`
- `apps/desktop/package.json` 的 `version`（保持一致）
- `apps/desktop/src-tauri/Cargo.toml` 的 `version`（保持一致）

版本必须**大于**用户当前安装版本，否则不会提示更新。

### 2. 带签名构建

```bash
cd /Users/mini/Downloads/Gamepilot-main

export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/gamepilot-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/gamepilot-updater.password)"

pnpm --filter @gamepilot/desktop tauri build
```

产物在：

```text
apps/desktop/src-tauri/target/release/bundle/macos/GamePilot.app.tar.gz
apps/desktop/src-tauri/target/release/bundle/macos/GamePilot.app.tar.gz.sig
```

如果 `.sig` 不存在，说明签名环境变量没生效，不能用这个包发更新。

### 3. 生成 latest.json

先上传 `.app.tar.gz` 和 `.sig` 到 Release，再生成与下载地址匹配的清单：

```bash
node scripts/make-latest-json.mjs \
  --version 0.1.0 \
  --base-url https://github.com/PandaTestGrid/Gamepilot/releases/download/v0.1.0 \
  --notes "修复设备重连和工作流稳定性" \
  --out latest.json
```

`--base-url` 必须与实际上传 Release 的 tag 一致；脚本会把文件名 URL-encode 后拼进去。

### 4. 发布 GitHub Release

把以下文件放到同一个 Release：

```text
GamePilot.app.tar.gz
GamePilot.app.tar.gz.sig
latest.json
```

Release 必须是**已发布**（不是 draft），并且是仓库的最新正式 Release；应用的检查地址是：

```text
https://github.com/PandaTestGrid/Gamepilot/releases/latest/download/latest.json
```

`/releases/latest` 会忽略 prerelease，所以不要用 pre-release 发正式更新。

仓库或 Release 如果是私有的，这个地址对客户端不可用；需要把仓库/Release 设为公开，或换成带访问控制的 HTTPS 更新源。

### 5. 验证

1. 安装上一个版本；
2. 启动应用；
3. 右下角应出现「发现新版本」；
4. 点「下载并安装」后应用重启，版本号更新。

开发模式（`tauri dev`）不会弹更新，因为检查需要真实的 `__TAURI_INTERNALS__` 和发布源。

## Windows 更新

Windows 需要在 Windows 构建机生成 NSIS updater 产物（通常是 `.nsis.zip` + `.sig`），然后给 `latest.json` 增加：

```json
{
  "platforms": {
    "windows-x86_64": {
      "signature": "…",
      "url": "https://github.com/…/GamePilot_0.1.0_x64-setup.nsis.zip"
    }
  }
}
```

当前 `make-latest-json.mjs` 默认生成 macOS arm64 条目；Windows 构建时用 `--platform windows-x86_64 --artifact <path>` 生成对应片段，再把多个平台合并到同一个 `latest.json`。

## macOS 签名与公证

Updater 的 `.sig` 只保证更新包没被篡改，不等于 Apple 公证。正式分发仍需要 Developer ID 证书完成 codesign + notarization；否则首次打开/更新后仍可能被 Gatekeeper 拦截。没有证书时只能用于内测或让用户手动放行。

## 安全边界

- 更新包必须由私钥签名；客户端用 `tauri.conf.json` 中的公钥验签，签名不匹配会拒绝安装。
- 更新源必须是 HTTPS；GitHub Release 满足要求。
- 不要在前端或日志里输出私钥、密码。
- 更新提示不会自动安装：用户确认后才下载，避免打断正在跑的工作流。
