# gamepilot-engine

GamePilot 的引擎进程：负责**感知 + 决策 + 执行 + 事件**，不含任何 UI 逻辑。
由 Tauri 壳作为 sidecar 拉起，通过 **stdio + NDJSON JSON-RPC 2.0** 通信。

## 环境

- Python **3.11+**（不要用 DSH bundled Python 或系统 Python 3.9，见 `docs/DESIGN.md` §10）
- 依赖管理：**uv**

```bash
cd engine
uv sync --all-extras      # 或 uv sync（不装 OCR/scrcpy 可选依赖）
```

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

## 铁律

1. **stdout 只能出现协议帧**，日志一律 stderr（见 `src/gamepilot/rpc/stdio.py` 模块文档）。
2. **依赖方向单向**：`rpc → core ← devices`，core 不得反向依赖。
3. **坐标一律归一化**到 `[0,1]`；像素坐标只能出现在 `devices` 层内部。
4. 契约变更（删字段/改语义/改事件名）必须升 `PROTOCOL_VERSION` 并同步 `docs/rpc.md` 与前端类型。

目录职责与命名规范详见 [`docs/CONVENTIONS.md`](../docs/CONVENTIONS.md)。
