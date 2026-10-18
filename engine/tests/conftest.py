"""测试隔离：一律不读用户**真实的**配置目录。

为什么必须钉住：`SessionManager.__init__` 会 `_restore()` —— 读 `config.json` 里
"上次的工作区"并**枚举里面的工作流**（`workspace.first_workflow()` → `library.list_workflows()`）。
不隔离的话，开发机/用户机上某份 `graph.json` 一旦有问题（例如一条边引用了不存在的节点），
否则无关工作区数据会导致整套用例失败。

只钉 `GAMEPILOT_CONFIG_DIR`，**不动** `GAMEPILOT_WORKSPACE_DIR / GAMEPILOT_PROJECT_DIR`：
后两个是"跳过配置读写"的逃生口（见 tests/test_config.py），单测要按原样验它们的语义。
想验"没有配置时的默认行为"，照旧在用例里用 `monkeypatch.setenv/delenv` 覆盖即可。
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest


def pytest_configure() -> None:
    os.environ["GAMEPILOT_TEST_SYNTHETIC"] = "1"


@pytest.fixture(autouse=True)
def isolate_config_dir(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    config_dir = tmp_path_factory.mktemp("gamepilot-config")
    monkeypatch.setenv("GAMEPILOT_CONFIG_DIR", str(config_dir))
    yield
