# 引擎 sidecar 打包（Windows x64）

发布安装包前会构建 PyInstaller 单文件，并作为 Tauri `externalBin` 与桌面壳一起分发。内置：

- **adb**（adbutils 自带 `adb.exe` + USB 驱动 DLL）
- **scrcpy-server** 3.3.4（首次构建从 GitHub 下载到 `engine/vendor/`）
- **OCR**（PP-OCRv4 ONNX，从 `rapidocr-onnxruntime` wheel 复制到 `src/gamepilot/assets/ppocr_v4/`）

## 手动构建 sidecar

```bash
cd engine
uv sync --extra ocr --group packaging
uv run python packaging/build_sidecar.py
```

产出：`apps/desktop/src-tauri/binaries/gamepilot-engine-x86_64-pc-windows-msvc.exe`

## 完整安装包

在仓库根目录：

```bash
pnpm install
pnpm build:release
```

安装包在 `apps/desktop/src-tauri/target/release/bundle/`（或当前 `CARGO_TARGET_DIR`）。
