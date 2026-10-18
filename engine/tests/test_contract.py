"""契约一致性：同一份接口有 5 份手抄副本，这条测试是唯一守着它们的东西。

都踩过（2026-10-19 那轮审计）：
  - `record.ocr` 加了 RPC 却没人写进 `docs/rpc.md`；
  - `double_click` 引擎支持、前端白名单没有 → 用户动作被静默改写成单击；
  - `graph.edge.add` 等 4 个 legacy 方法前端删了封装、引擎还留着。

这里断言四个集合的关系，改接口时忘了同步会立刻红：
  1. `protocol.py` 的 `METHOD_*` 常量 == `rpc/` 里实际注册的 handler（两个方向）；
  2. `docs/rpc.md` 提到每一个方法（`METHOD_*` 全集 ⊆ 文档里出现的反引号名字）；
  3. 前端 `apps/desktop/src/lib/rpc.ts` 里 `rpc('x')` 的每个 `x` 都在引擎方法表里；
  4. 步骤类型 `flow_model.STEP_KINDS` == 前端 `flow-step-meta.ts` 的 `FLOW_STEP_TYPES`。

解析用 `ast`（Python）与正则（TS / markdown），**不 import 也不起引擎**：测试要能在只装了引擎依赖的
环境里跑，所以前端文件不存在时跳过对应断言，而不是失败。
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
ENGINE_PKG = REPO_ROOT / "engine" / "src" / "gamepilot"
RPC_DOC = REPO_ROOT / "docs" / "rpc.md"
FRONTEND_RPC = REPO_ROOT / "apps" / "desktop" / "src" / "lib" / "rpc.ts"
FRONTEND_STEPS = REPO_ROOT / "apps" / "desktop" / "src" / "features" / "graph" / "flow" / "flow-step-meta.ts"
FRONTEND_REQUIRED = REPO_ROOT / "apps" / "desktop" / "src" / "lib" / "engine-methods.ts"


def _constants(prefix: str) -> dict[str, str]:
    """`protocol.py` 里 `prefix` 开头的常量名 → 字符串值。"""
    tree = ast.parse((ENGINE_PKG / "protocol.py").read_text(encoding="utf-8"))
    consts: dict[str, str] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name) or not target.id.startswith(prefix):
            continue
        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            consts[target.id] = node.value.value
    return consts


def _protocol_constants() -> dict[str, str]:
    """`protocol.py` 里的 `METHOD_*` → 字符串。"""
    return _constants("METHOD_")


def _notification_constants() -> dict[str, str]:
    """`protocol.py` 里的 `NOTIFY_*` → 字符串。"""
    return _constants("NOTIFY_")


def _registered_methods() -> dict[str, str]:
    """扫 `rpc/*.py` 里 `@server.method(...)` 的实参，解析成字符串。"""
    consts = _protocol_constants()
    names: dict[str, str] = {}
    for path in sorted((ENGINE_PKG / "rpc").glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not (
                    isinstance(decorator, ast.Call)
                    and isinstance(decorator.func, ast.Attribute)
                    and decorator.func.attr == "method"
                    and decorator.args
                ):
                    continue
                arg = decorator.args[0]
                if isinstance(arg, ast.Name):
                    value = consts.get(arg.id)
                    if value is None:
                        pytest.fail(f"{path.name} 注册了 {arg.id}，但它不是 protocol.py 里的 METHOD_* 常量")
                elif isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    value = arg.value
                else:
                    continue
                names[value] = f"{path.name}:{node.name}"
    return names


def test_protocol_constants_match_registered_handlers() -> None:
    declared = _protocol_constants()
    registered = _registered_methods()

    assert set(declared.values()) == set(registered), (
        "protocol.py 与 rpc/ 注册的 handler 不一致：\n"
        f"  只在 protocol.py：{sorted(set(declared.values()) - set(registered))}\n"
        f"  只在注册处：{sorted(set(registered) - set(declared.values()))}"
    )


def test_protocol_constant_values_are_unique() -> None:
    declared = _protocol_constants()
    seen: dict[str, str] = {}
    for name, value in declared.items():
        assert value not in seen, f"{name} 与 {seen[value]} 都是 {value!r}"
        seen[value] = name


@pytest.mark.skipif(not RPC_DOC.exists(), reason="没有 docs/rpc.md（可能只 checkout 了 engine/）")
def test_rpc_doc_documents_every_method() -> None:
    doc = RPC_DOC.read_text(encoding="utf-8")
    # 方法名一律写成反引号包起来的 `domain.action`
    documented = set(re.findall(r"`([a-z][a-z0-9]*\.[a-z][a-z0-9.]*)`", doc))
    declared = set(_protocol_constants().values())
    missing = sorted(declared - documented)
    assert not missing, "docs/rpc.md 没写这几个方法（新增 RPC 必须同步文档）：\n  " + "\n  ".join(missing)


def test_rpc_doc_documents_every_notification() -> None:
    if not RPC_DOC.exists():
        pytest.skip("没有 docs/rpc.md")
    documented = set(re.findall(r"`([a-z][a-z0-9]*\.[a-z][a-z0-9.]*)`", RPC_DOC.read_text(encoding="utf-8")))
    missing = sorted(set(_notification_constants().values()) - documented)
    assert not missing, "docs/rpc.md 的「通知表」没写这几个通知（新增 notify 必须同步文档）：\n  " + "\n  ".join(
        missing
    )


@pytest.mark.skipif(not FRONTEND_RPC.exists(), reason="没有前端源码")
def test_frontend_rpc_calls_exist_in_protocol() -> None:
    source = FRONTEND_RPC.read_text(encoding="utf-8")
    called = set(re.findall(r"rpc(?:<[^>]*>)?\(\s*'([a-zA-Z][\w.]*)'", source))
    declared = set(_protocol_constants().values())
    unknown = sorted(called - declared)
    assert not unknown, "前端调了引擎没有的方法（拼错，或引擎侧还没注册）：\n  " + "\n  ".join(unknown)
    assert called, "没扫到任何 rpc('x') 调用：解析规则可能过期了"


def _step_kinds() -> tuple[str, ...]:
    from gamepilot.core.flow_model import STEP_KINDS

    return tuple(STEP_KINDS)


@pytest.mark.skipif(not FRONTEND_STEPS.exists(), reason="没有前端源码")
def test_step_kinds_match_frontend_catalog() -> None:
    source = FRONTEND_STEPS.read_text(encoding="utf-8")
    match = re.search(r"FLOW_STEP_TYPES\s*=\s*\[(.*?)\]\s*as const", source, re.S)
    assert match, "flow-step-meta.ts 里找不到 FLOW_STEP_TYPES"
    frontend = tuple(re.findall(r"'([a-z_]+)'", match.group(1)))
    assert frontend == _step_kinds(), (
        "步骤类型两边不一致（引擎 STEP_KINDS ↔ 前端 FLOW_STEP_TYPES）：\n"
        f"  引擎独有：{sorted(set(_step_kinds()) - set(frontend))}\n"
        f"  前端独有：{sorted(set(frontend) - set(_step_kinds()))}"
    )


@pytest.mark.skipif(not FRONTEND_REQUIRED.exists(), reason="没有前端源码")
def test_required_engine_methods_exist() -> None:
    """`engine-methods.ts` 是握手时的兼容清单：写错一个就等于"永远提示引擎太旧"或永不提示。"""
    source = FRONTEND_REQUIRED.read_text(encoding="utf-8")
    match = re.search(r"REQUIRED_ENGINE_METHODS[^=]*=\s*\[(.*?)\];", source, re.S)
    assert match, "engine-methods.ts 里找不到 REQUIRED_ENGINE_METHODS"
    required = set(re.findall(r"'([a-z][\w.]*)'", match.group(1)))
    unknown = sorted(required - set(_protocol_constants().values()))
    assert not unknown, "握手清单里写了引擎没有的方法：\n  " + "\n  ".join(unknown)
