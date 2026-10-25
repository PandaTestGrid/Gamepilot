# branding —— 标与安装器外观

这里是"GamePilot 长什么样"的唯一来源。**改标只改这里**，然后按下面对应的尺寸重新生成。

## 标

`logo.svg`（1024 视图框，安装器/预览用）与 `logo-1024.svg`（同款，满版，喂 `tauri icon`）：

- 深墨底（`#171b1a`）+ 浅黄绿色线框（`#c0cbaa`）+ G 形航迹，取自 Fieldnotes / Automation 的品牌参考；
- 外框与 G 形同时表达记录页、路径和自动化动作，16px 下仍保持清晰轮廓（`src/layout/AppMark.tsx` 使用同一几何形状）。

品牌标使用独立的参考配色：deep `#171b1a`、pale `#c0cbaa`、muted `#6f7a71`。
产品操作状态仍沿用 `src/index.css` 的语义色，避免把状态色和品牌色混在一起。

## 生成物（都在 git 里，改完标要一起提交）

| 文件 | 尺寸 | 谁在用 |
|---|---|---|
| `src-tauri/icons/*.png / icon.ico / icon.icns` | 多档 | Tauri `bundle.icon`：窗口、任务栏、安装包、卸载项 |
| `src-tauri/icons/installer/header.bmp` | 150×57 | NSIS 内页头部（浅色，带 GamePilot 字标）|
| `src-tauri/icons/installer/sidebar.bmp` | 164×314 | NSIS 欢迎/结束页左侧（浅蓝绿波浪，参考安装界面）|
| `branding/installer/*` | 原尺寸 | 安装界面源图副本；`header.bmp` / `sidebar.bmp` 与 `icons/installer/` 同步 |
| `src-tauri/icons/installer/wix-banner.bmp` | 493×58 | MSI（WiX）横幅 |
| `src-tauri/icons/installer/wix-dialog.bmp` | 493×312 | MSI（WiX）欢迎页大图 |

## 怎么重新生成

```bash
# 1) 图标集（会覆盖 icons/ 下的 png/ico/icns，并生成移动端图标目录）
cd apps/desktop && npx tauri icon branding/logo-1024.png

# 2) 安装器那四张 BMP：SVG 组成写在 assets.json 里，尺寸见上表。
#    任何 SVG→BMP(24bit) 工具都行；本目录留了 `_render.html`——
#    浏览器打开后在控制台调：__render(assets['installer/header.bmp'].svg, 150, 57, false)
| `src-tauri/icons/installer/sidebar.bmp` | 164×314 | NSIS 欢迎/结束页左侧（浅蓝绿波浪，参考安装界面）|
| `branding/installer/*` | 原尺寸 | 安装界面源图副本；`header.bmp` / `sidebar.bmp` 与 `icons/installer/` 同步 |
#    返回 BMP 的 base64，存成对应的 .bmp 即可（__render 的第四个参数 true = PNG）。
```

**必须 BMP**：NSIS 的 MUI 头图/侧栏图与 WiX 的 banner/dialog 都只吃 24 位 BMP（PNG 会构建失败或显示不出来）。

## 安装界面的限制

当前 Tauri 2 NSIS 页面结构由 bundler 固定。安装界面采用安装器图片和 Tauri hooks（仓库内 hooks 为空，最终欢迎页样式已烘进交付安装包）；欢迎页标题与正文使用 Windows NSIS 原生控件，以保留静默安装、升级和卸载流程。

## 安装向导的语言

`tauri.conf.json` 里 `bundle.windows.nsis.languages = ["SimpChinese", "English"]`：
中文 Windows 上向导就是中文（NSIS 自带 `SimpChinese.nlf`）。
MSI 那边语言保持 `en-US`：Tauri 下载的是精简 WiX，没带 `zh-CN` 的 `.wxl` 本地化文件，
写中文会在打包时挂掉 —— 只用它的图，别动它的语言。
