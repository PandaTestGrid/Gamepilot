# gamepilot-engine

GamePilot 的引擎进程：负责**感知 + 决策 + 执行 + 事件**，不含任何 UI 逻辑。
由 Tauri 壳作为 sidecar 拉起，通过 **stdio + NDJSON JSON-RPC 2.0** 通信。

## 环境

- Python **3.11+**（不要用 DSH bundled Python 或系统 Python 3.9，见 `docs/DESIGN.md` §10）
- 依赖管理：**uv**

```bash
cd engine
uv sync --extra ocr --extra wgc   # OCR + Windows Graphics Capture 抓图通道
uv sync --extra ocr               # 只要 OCR
uv sync                           # 都不要时（窗口设备自动回退 PrintWindow/BitBlt）
```

`wgc` extra 是 **Windows Graphics Capture**（微软官方抓图 API，MIT 包 `windows-capture`）：
装了它，Windows 窗口设备的 `capture=auto` 会优先按窗口抓图（D3D/GPU/被遮挡窗口都行，
实测 UE 窗口 ~50fps）；没装或失败时无缝回退 `PrintWindow`/`BitBlt`。

离线 OCR 的 PP-OCRv4 ONNX 已内置在 `src/gamepilot/assets/ppocr_v4/`（约 16MB，随包分发、无需联网下载）。
若该目录缺失，安装 `uv sync --extra ocr` 后引擎会回退使用 `rapidocr-onnxruntime` wheel 内的同名模型。

## AI 识别（YOLO）的模型从哪来

AI 识别器是**可选组件**：引擎主进程不 import torch，组件装好之前 `yolo.status` 报未安装。

- **用户 / 发布态**：构建 `gamepilot-yolo` 组件包（worker + `yoloe-11s-seg.pt`，
  见 `packaging/build_yolo_component.py`），App 里「AI 识别」→「安装 AI 组件」/「从本地 zip 安装」。
  组件装到 `%APPDATA%/gamepilot/components/yolo/<版本>/`，worker 启动时自动把同级 `models/` 设为模型目录。
- **开发态（不装组件）**：让引擎进程自己加载模型：

  ```powershell
  uv pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu   # 显卡换 cu128
  uv pip install ultralytics
  # 模型二选一：放进 src/gamepilot/assets/yolo/，或启动 App 前设环境变量
  $env:GAMEPILOT_YOLO_MODEL_DIR = "S:\game\yolovlm\weights"
  ```

  重启引擎后 `yolo.status` 的 `runtime.available=true`，界面显示「开发模式：引擎自带模型可用」。
- 模型缺失时推理会直接报 `YOLO 模型缺失：<路径>`，不会静默返回空结果。

### 换模型（只支持 YOLOE 示例模型）

- **开发态**：把权重放进 `assets/yolo/`（或 `GAMEPILOT_YOLO_MODEL_DIR`），用
  `GAMEPILOT_YOLO_MODEL=yoloe-11m-seg.pt` 指定文件名；可用 `yoloe-11s/m/l-seg.pt`。
  更大 = 更准但更慢（CUDA 上 11s ≈ 28ms/帧）。
- **组件/发布态**：`--model-dir` 指向放了目标权重的目录重新构建组件；目录里可以放多个
  `.pt`，manifest 的 `defaultModel` 决定默认用哪个（构建时 `GAMEPILOT_YOLO_MODEL` 可覆盖），
  装新组件即完成切换。

## 常用命令

```bash
uv run pytest -q                       # 契约与逻辑测试
uv run ruff check . && uv run ruff format --check .
uv run mypy                            # src 严格模式
uv run python -m gamepilot             # 打印版本与协议信息
uv run python -m gamepilot.rpc         # 以 stdio 模式启动引擎（手工调试用）
```

手工发一帧请求：

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"engine.ping","params":{}}' | uv run python -m gamepilot.rpc
```


## Windows 安装包里的 iOS 原生依赖

PyInstaller 不会自动收集 `pytun_pmd3` 的 `wintun/bin/*/wintun.dll`。打包脚本显式使用
`--collect-all pytun_pmd3`，否则 Windows 上没有 iPhone、只用 Android 时也可能在导入
iOS 模块阶段报 `Failed to load dynlib/dll ... wintun.dll`。

iTunes 本身不是 GamePilot 的运行依赖；Windows 只需要系统的 `usbmuxd` 服务（通常由
Apple Mobile Device Support / Apple Devices 提供）来发现 iPhone。缺少该服务时，
iOS 扫描会单独报错/返回空列表，Android 扫描继续工作。
## 步骤链 vs 状态图

- **`flow.steps` 非空**：运行走 `FlowEngine`；`graph.node.*` / `graph.edge.*` 会拒绝（见 `session.reject_legacy_graph_edit`）。
- **无 flow**：仍可用 legacy nodes/edges RPC 与状态机（测试与旧脚本）。

契约说明见 [`docs/rpc.md`](../docs/rpc.md)。

## 铁律

1. **stdout 只能出现协议帧**，日志一律 stderr（见 `src/gamepilot/rpc/stdio.py` 模块文档）。
2. **依赖方向单向**：`rpc → core ← devices`，core 不得反向依赖。
3. **坐标一律归一化**到 `[0,1]`；像素坐标只能出现在 `devices` 层内部。
4. 契约变更（删字段/改语义/改事件名）必须升 `PROTOCOL_VERSION` 并同步 `docs/rpc.md` 与前端类型。

目录职责与命名规范详见 [`docs/CONVENTIONS.md`](../docs/CONVENTIONS.md)。
