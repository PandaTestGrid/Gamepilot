# 引擎 sidecar 打包（Windows x64）

发布安装包前会构建 PyInstaller 单文件，并作为 Tauri `externalBin` 与桌面壳一起分发。内置：

- **Python 运行时与引擎依赖**（用户无需安装 Python 或创建虚拟环境）
- **adb**（adbutils 自带 `adb.exe` + `AdbWinApi.dll` / `AdbWinUsbApi.dll` 配套库）
- **scrcpy-server** 3.3.4（首次构建从 GitHub 下载到 `engine/vendor/`）
- **OCR**（PP-OCRv4 ONNX，从 `rapidocr-onnxruntime` wheel 复制到 `src/gamepilot/assets/ppocr_v4/`）

用户无需另装 adb、Python、Node.js、Rust，也无需配置这些工具的 PATH。
`track-devices` 由引擎内部监听 ADB 服务，用户不需要在命令行执行。
Windows 安装器会检测 WebView2；缺失时自动下载安装，因此该步骤需要联网。
ADB 的配套 DLL 不等于设备的 Windows USB 驱动；连接 USB 真机仍需系统正确识别设备并允许 USB 调试。

## 手动构建 sidecar

```bash
cd engine
uv sync --extra ocr --group packaging
uv run python packaging/build_sidecar.py
```

产出：`apps/desktop/src-tauri/binaries/gamepilot-engine-x86_64-pc-windows-msvc.exe`

## adb 从哪来（用户机器上不用装 platform-tools）

安装包用 `--add-data ...;adb` 带上 adbutils 的 `adb.exe` + `AdbWinApi.dll` + `AdbWinUsbApi.dll`，
冻结态启动时 `configure_frozen_environment()` 把它解压目录钉进 `ADBUTILS_ADB_PATH`。

**顺序是第三方库定的**（`.venv\...\adbutils\_utils.py: adb_path`）：`ADBUTILS_ADB_PATH` → 系统 PATH → 自带。
所以自带的被杀软删掉时会**静默退回系统 adb**（用户机器上通常没有 → 设备列表空）。
`gamepilot/devices/env_report.py` 会在日志里标出这次用的是哪一种（`bundled` / `env` / `system-path` / `missing`），
自带的缺失时还会单独 warning 一次 —— 排查"别人电脑上扫不到设备"先看那两行。

## 同一个 exe 也是 OCR 子进程的宿主（`--ocr-worker`）

打包后 `sys.executable` 就是 sidecar 本体，所以 OCR 要开子进程时**不能再写**
`python -m gamepilot.core.ocr_worker` —— PyInstaller 会把 `-m` 之后的东西当普通参数丢掉，
于是又拉起一个**完整引擎**：它一启动就把 `engine.ready` 写进 stdout，而 OCR 父进程正照着
pickle 帧头去读那 4 个字节（`{"js` = 2065853043 > 64MiB），直接报 **"OCR 消息过大"**。

约定：

| 谁 | 用什么 |
|---|---|
| `gamepilot/core/ocr.py: _worker_command()` | 冻结态 `[sys.executable, "--ocr-worker"]`；开发态 `[sys.executable, "-m", "gamepilot.core.ocr_worker"]` |
| `packaging/engine_sidecar_entry.py` | 认 `--ocr-worker`（也兼容老的 `-m ...`）→ 跑 `gamepilot.core.ocr_worker.main()`；否则跑 `gamepilot.rpc.stdio.main()` |

以后再加"自己启动自己"的子进程，**照这个模式加 argv 开关 + 在入口分派**，
别指望 `-m` 在冻结态还能用。两侧的约定有测试守着：`engine/tests/test_ocr.py`
（`test_frozen_spawn_argv_is_understood_by_the_sidecar_entry`）。

## Windows 中文环境下的通信编码

RPC 固定使用 UTF-8。`configure_stdio_encoding()` 在普通 Python 入口和 PyInstaller 入口最早执行，
不依赖系统代码页或 `PYTHONIOENCODING`（冻结态可能忽略 Python 环境变量）。否则 GBK 系统上
`engine.ready` 的英文可以读到，紧接着中文工作区路径 / 错误 / 日志会让 Rust 的 UTF-8 读取失败，
表现为“stdout 已关闭”及所有请求超时，实际引擎可能仍然存活。

排查这类问题先看通信读取错误及引擎退出码；单纯延长超时无法修复编码不一致。

## AI（YOLO）组件：CPU / CUDA 两个变体

AI 识别是可选下载的独立 worker（onedir，内含 torch + 模型），不进主安装包：

```bash
# CPU 版（约 400MB zip）：没 NVIDIA 显卡的机器
python packaging/build_yolo_component.py --model-dir <模型目录> --version 0.2.0 --variant cpu
# CUDA 版（约 3GB zip / 解压 4~5GB）：有 NVIDIA 显卡时用，推理快 3~5 倍
python packaging/build_yolo_component.py --model-dir <模型目录> --version 0.2.0 --variant cuda
```

产物在 `packaging/dist/gamepilot-yolo-<version>-<platform>-<variant>.zip`；应用里用
`yolo.install`（或弹窗「安装组件 → 选择文件」）装。**构建环境里装的是哪个 torch，
就打出哪种变体**（CUDA 版要用 `torch==...+cuXXX` 的构建 venv，且目标机器装好 NVIDIA 驱动）；
manifest 会记录 `variant` 与 `torch` 版本。

- 同一时间只生效一个版本（`current.json`）；装错变体可以重新装另一个 zip；
- `--skip-pyinstaller` 复用已有 `dist/` 产物打包（不重新构建）；
- 引擎日志在 worker 就绪时会打印 `device=cuda` / `device=cpu`，CPU 上会额外 warning；
- 弹窗「实时检测」的行尾会显示 GPU/CPU 与单次耗时，方便判断装错变体。

## 完整安装包

在仓库根目录：

```bash
pnpm install
pnpm build:release
```

安装包在 `apps/desktop/src-tauri/target/release/bundle/`（或当前 `CARGO_TARGET_DIR`）。
