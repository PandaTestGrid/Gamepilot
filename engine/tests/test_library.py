"""脚本库（多状态图）与 `project.*` RPC 的测试。

全部在 `tmp_path` 上跑，**不碰仓库里的 `projects/`**：

- library 层：名称校验、列举（跳过 `.trash`/无 graph.json、排序、计数字段）、
  create / duplicate / rename / trash 的落盘行为；
- RPC 层：`RpcServer` + `io.StringIO`（不拉起子进程）跑通
  `project.create → project.list → project.rename → project.delete`，
  断言 `{items, current}` 契约与"当前脚本"的切换。
"""

from __future__ import annotations

import io
import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from gamepilot import library
from gamepilot.core.graph import Graph
from gamepilot.project import resolve_project
from gamepilot.rpc.stdio import RpcServer

# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #


def _write_script(
    base: Path,
    name: str,
    *,
    nodes: int = 0,
    edges: int = 0,
    recognizers: int = 0,
    templates: int = 0,
) -> Path:
    """造一个**合法**的脚本目录（graph.json + templates/），用于列举的计数断言。"""
    root = base / name
    (root / "templates").mkdir(parents=True)
    labels = [f"r{index}" for index in range(recognizers)]
    specs = {
        label: {"type": "color", "target_bgr": [10, 20, 30], "tolerance": 30, "min_pixels": 10} for label in labels
    }
    node_list = [
        {"id": f"n{index}", "name": f"界面{index}", "enter": [labels[index % len(labels)]] if labels else []}
        for index in range(nodes)
    ]
    edge_list = [
        {
            "id": f"e{index}",
            "when": labels[index % len(labels)],
            "action": {"type": "click", "target": labels[index % len(labels)]},
        }
        for index in range(edges)
    ]
    graph = Graph.from_dict({"nodes": node_list, "edges": edge_list, "recognizers": specs}, base_dir=str(root))
    graph.save(str(root / library.SCRIPT_FILE))
    for index in range(templates):
        (root / "templates" / f"t{index}.png").write_bytes(b"png")
    return root


def _call(server: RpcServer, out: io.StringIO, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """走一次真实 JSON-RPC 往返（handle_line），返回 result。"""
    out.seek(0)
    out.truncate(0)
    server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}))
    frames = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
    assert frames, f"{method} 没有任何响应"
    response = frames[-1]
    assert "error" not in response, response
    result = response["result"]
    assert isinstance(result, dict), f"result 必须是对象: {result!r}"
    return result


def _call_error(
    server: RpcServer, out: io.StringIO, method: str, params: dict[str, Any] | None = None
) -> dict[str, Any]:
    out.seek(0)
    out.truncate(0)
    server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}))
    response = json.loads(out.getvalue().splitlines()[-1])
    assert "error" in response, response
    error = response["error"]
    assert isinstance(error, dict)
    return error


# --------------------------------------------------------------------------- #
# 名称校验
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("name", ["主页", "home", "home-1", "a b", "x_y.z", "A" * library.MAX_NAME_LEN])
def test_validate_name_accepts_legal_names(name: str) -> None:
    assert library.validate_name(name) == name


@pytest.mark.parametrize(
    "name",
    [
        "",
        "a/b",
        "a\\b",
        "a:b",
        "a*b",
        "a?b",
        'a"b',
        "a<b",
        "a>b",
        "a|b",
        ".hidden",
        "trailing.",
        ".",
        "A" * (library.MAX_NAME_LEN + 1),
    ],
)
def test_validate_name_rejects_with_chinese_message(name: str) -> None:
    with pytest.raises(ValueError) as excinfo:
        library.validate_name(name)
    message = str(excinfo.value)
    assert message, "错误信息不能为空"
    assert any("\u4e00" <= char <= "\u9fff" for char in message), f"错误信息要是中文、能直接给用户看: {message}"


# --------------------------------------------------------------------------- #
# 列举
# --------------------------------------------------------------------------- #


def test_list_scripts_skips_trash_and_dirs_without_graph(tmp_path: Path) -> None:
    _write_script(tmp_path, "beta", nodes=2, edges=1, recognizers=1, templates=3)
    _write_script(tmp_path, "alpha")
    (tmp_path / "no-graph").mkdir()  # 没有 graph.json：不是脚本
    (tmp_path / library.TRASH_DIR / "old-20240101-000000").mkdir(parents=True)  # 回收站不算脚本
    (tmp_path / "graph.json").write_text("{}", encoding="utf-8")  # 库根自己的文件更不算
    (tmp_path / "beta" / "templates" / "sub").mkdir()  # templates 只数文件，不数目录

    items = library.list_scripts(str(tmp_path))

    assert [item["name"] for item in items] == ["alpha", "beta"], "按 name 排序"
    assert set(items[0]) == {"name", "root", "nodes", "edges", "recognizers", "templates"}
    assert (items[0]["nodes"], items[0]["edges"], items[0]["recognizers"], items[0]["templates"]) == (0, 0, 0, 0)
    assert (items[1]["nodes"], items[1]["edges"], items[1]["recognizers"], items[1]["templates"]) == (2, 1, 1, 3)
    assert items[1]["root"] == str(tmp_path / "beta")


def test_list_scripts_on_missing_base_is_empty(tmp_path: Path) -> None:
    assert library.list_scripts(str(tmp_path / "nope")) == []


def test_library_root_is_parent_of_current_script(tmp_path: Path) -> None:
    assert library.library_root(str(tmp_path / "alpha")) == str(tmp_path)


# --------------------------------------------------------------------------- #
# 新建 / 复制 / 改名 / 回收站
# --------------------------------------------------------------------------- #


def test_create_script_makes_empty_graph_and_templates(tmp_path: Path) -> None:
    root = library.create_script(str(tmp_path), "新脚本")

    assert root == str(tmp_path / "新脚本")
    assert (tmp_path / "新脚本" / "templates").is_dir()
    graph = Graph.load(str(tmp_path / "新脚本" / library.SCRIPT_FILE))
    assert graph.nodes == {} and graph.edges == [] and graph.specs == {}

    listing = library.list_scripts(str(tmp_path))
    assert [item["name"] for item in listing] == ["新脚本"]
    assert listing[0]["templates"] == 0


def test_create_script_rejects_bad_name_duplicate_and_missing_base(tmp_path: Path) -> None:
    library.create_script(str(tmp_path), "alpha")

    with pytest.raises(ValueError, match="已经有"):
        library.create_script(str(tmp_path), "alpha")
    with pytest.raises(ValueError, match="不能包含"):
        library.create_script(str(tmp_path), "a/b")
    with pytest.raises(ValueError, match="不存在"):
        library.create_script(str(tmp_path / "nope"), "alpha")


def test_duplicate_script_copies_graph_and_whole_templates_dir(tmp_path: Path) -> None:
    source = _write_script(tmp_path, "alpha", nodes=2, edges=1, recognizers=1, templates=1)
    (source / "templates" / "logo.png").write_bytes(b"png-bytes")

    copy = library.duplicate_script(str(source), str(tmp_path), "alpha-copy")

    assert copy == str(tmp_path / "alpha-copy")
    assert (tmp_path / "alpha-copy" / library.SCRIPT_FILE).read_text(encoding="utf-8") == (
        source / library.SCRIPT_FILE
    ).read_text(encoding="utf-8")
    assert sorted(item.name for item in (tmp_path / "alpha-copy" / "templates").iterdir()) == [
        "logo.png",
        "t0.png",
    ]
    assert (tmp_path / "alpha-copy" / "templates" / "logo.png").read_bytes() == b"png-bytes"

    counted = {item["name"]: item for item in library.list_scripts(str(tmp_path))}
    assert (counted["alpha-copy"]["nodes"], counted["alpha-copy"]["templates"]) == (2, 2)

    # 副本是独立的一份：改副本不影响原脚本
    (tmp_path / "alpha-copy" / library.SCRIPT_FILE).write_text("{}", encoding="utf-8")
    assert set(Graph.load(str(source / library.SCRIPT_FILE)).nodes) == {"n0", "n1"}


def test_duplicate_script_rejects_bad_source_duplicate_name_and_bad_name(tmp_path: Path) -> None:
    source = _write_script(tmp_path, "alpha")
    library.duplicate_script(str(source), str(tmp_path), "beta")

    with pytest.raises(ValueError, match="已经有"):
        library.duplicate_script(str(source), str(tmp_path), "beta")
    with pytest.raises(ValueError, match="缺少"):
        library.duplicate_script(str(tmp_path / "nope"), str(tmp_path), "gamma")
    with pytest.raises(ValueError, match="不能以"):
        library.duplicate_script(str(source), str(tmp_path), ".hidden")


def test_rename_script_moves_the_directory(tmp_path: Path) -> None:
    source = _write_script(tmp_path, "alpha", nodes=1, recognizers=1)

    renamed = library.rename_script(str(source), "beta")

    assert renamed == str(tmp_path / "beta")
    assert not source.exists(), "旧目录必须消失"
    assert set(Graph.load(str(tmp_path / "beta" / library.SCRIPT_FILE)).nodes) == {"n0"}
    assert [item["name"] for item in library.list_scripts(str(tmp_path))] == ["beta"]


def test_rename_script_rejects_existing_target_and_missing_source(tmp_path: Path) -> None:
    library.create_script(str(tmp_path), "alpha")
    library.create_script(str(tmp_path), "beta")

    with pytest.raises(ValueError, match="已经有"):
        library.rename_script(str(tmp_path / "alpha"), "beta")
    with pytest.raises(ValueError, match="不能包含"):
        library.rename_script(str(tmp_path / "alpha"), "a:b")
    with pytest.raises(ValueError, match="不存在"):
        library.rename_script(str(tmp_path / "nope"), "gamma")

    # 改成同名：幂等，而不是报"已存在"（界面的改名框原样提交时会走到这里）
    assert library.rename_script(str(tmp_path / "alpha"), "alpha") == str(tmp_path / "alpha")


def test_trash_script_moves_into_timestamped_trash_dir(tmp_path: Path) -> None:
    source = _write_script(tmp_path, "alpha", nodes=1, recognizers=1, templates=1)

    target = library.trash_script(str(source))

    assert not source.exists(), "原目录必须消失（但没被真删除）"
    assert Path(target).parent == tmp_path / library.TRASH_DIR
    assert re.fullmatch(r"alpha-\d{8}-\d{6}", Path(target).name), f"回收站目录名要带时间戳: {target}"
    assert (Path(target) / library.SCRIPT_FILE).is_file(), "内容原样保留，用户能恢复"
    assert (Path(target) / "templates" / "t0.png").is_file()
    assert library.list_scripts(str(tmp_path)) == [], "回收站里的脚本不再出现在列表里"


def test_trash_script_twice_in_the_same_second_does_not_overwrite(tmp_path: Path) -> None:
    first = library.trash_script(str(_write_script(tmp_path, "alpha")))
    second = library.trash_script(str(_write_script(tmp_path, "alpha")))

    assert first != second
    assert Path(first).is_dir() and Path(second).is_dir()


def test_trash_script_rejects_missing_dir(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="不存在"):
        library.trash_script(str(tmp_path / "nope"))


# --------------------------------------------------------------------------- #
# RPC 层：project.* 全流程
# --------------------------------------------------------------------------- #


@pytest.fixture()
def rpc(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[RpcServer, io.StringIO]]:
    """真实 RpcServer + StringIO（不拉子进程）；当前脚本指向 tmp_path 下的 default。"""
    monkeypatch.setenv("GAMEPILOT_PROJECT_DIR", str(tmp_path / "default"))
    out = io.StringIO()
    server = RpcServer(io.StringIO(), out)
    yield server, out


def test_project_lifecycle_over_rpc(rpc: tuple[RpcServer, io.StringIO], tmp_path: Path) -> None:
    server, out = rpc
    manager = server.sessions
    base = tmp_path  # 库根 = 当前脚本目录的父目录

    # create：新建空脚本、切过去、返回刷新后的整份列表
    created = _call(server, out, "project.create", {"name": "alpha", "base": str(base)})
    assert created["current"] == str(base / "alpha")
    assert [item["name"] for item in created["items"]] == ["alpha"]
    assert manager.project_info()["root"] == str(base / "alpha"), "create 之后当前脚本要切过去"
    assert (base / "alpha" / library.SCRIPT_FILE).is_file()
    assert (base / "alpha" / "templates").is_dir()

    # list：契约要带 templates 字段
    listing = _call(server, out, "project.list", {"base": str(base)})
    assert set(listing["items"][0]) == {"name", "root", "nodes", "edges", "recognizers", "templates"}

    # 不给 base：默认库根 = 当前脚本的父目录
    created = _call(server, out, "project.create", {"name": "beta"})
    assert created["current"] == str(base / "beta")
    assert [item["name"] for item in created["items"]] == ["alpha", "beta"]
    assert manager.project_info()["root"] == str(base / "beta")

    # duplicate：连 templates/ 一起复制，并切到副本
    (base / "alpha" / "templates" / "logo.png").write_bytes(b"png")
    duplicated = _call(server, out, "project.duplicate", {"dir": str(base / "alpha"), "name": "alpha-copy"})
    assert duplicated["current"] == str(base / "alpha-copy")
    assert (base / "alpha-copy" / "templates" / "logo.png").read_bytes() == b"png"
    assert [item["name"] for item in duplicated["items"]] == ["alpha", "alpha-copy", "beta"]
    assert next(item for item in duplicated["items"] if item["name"] == "alpha-copy")["templates"] == 1
    assert manager.project_info()["root"] == str(base / "alpha-copy")

    # rename 非当前脚本：当前脚本不动
    renamed = _call(server, out, "project.rename", {"dir": str(base / "alpha"), "name": "gamma"})
    assert renamed["current"] == str(base / "alpha-copy")
    assert (base / "gamma").is_dir() and not (base / "alpha").exists()
    assert [item["name"] for item in renamed["items"]] == ["alpha-copy", "beta", "gamma"]
    assert manager.project_info()["root"] == str(base / "alpha-copy")

    # rename 当前脚本：当前脚本跟着改
    renamed = _call(server, out, "project.rename", {"dir": str(base / "alpha-copy"), "name": "delta"})
    assert renamed["current"] == str(base / "delta")
    assert manager.project_info()["root"] == str(base / "delta")

    # delete 当前脚本：移到 .trash/ 并切到剩下的第一个（按 name 排序）
    deleted = _call(server, out, "project.delete", {"dir": str(base / "delta")})
    assert deleted["current"] == str(base / "beta")
    assert [item["name"] for item in deleted["items"]] == ["beta", "gamma"]
    assert manager.project_info()["root"] == str(base / "beta")
    assert not (base / "delta").exists()
    trashed = sorted(item.name for item in (base / library.TRASH_DIR).iterdir())
    assert len(trashed) == 1 and re.fullmatch(r"delta-\d{8}-\d{6}", trashed[0]), trashed

    # 删掉最后一个：回到 default（resolve_project）
    _call(server, out, "project.delete", {"dir": str(base / "beta")})
    last = _call(server, out, "project.delete", {"dir": str(base / "gamma")})
    assert last["items"] == []
    assert last["current"] == resolve_project().root
    assert manager.project_info()["root"] == resolve_project().root


def test_project_lifecycle_errors_are_user_facing(rpc: tuple[RpcServer, io.StringIO], tmp_path: Path) -> None:
    server, out = rpc

    bad_name = _call_error(server, out, "project.create", {"name": "坏/名字", "base": str(tmp_path)})
    assert bad_name["code"] == -32603
    assert "不能包含" in bad_name["message"]

    _call(server, out, "project.create", {"name": "alpha", "base": str(tmp_path)})
    duplicate = _call_error(server, out, "project.create", {"name": "alpha", "base": str(tmp_path)})
    assert "已经有" in duplicate["message"]

    missing_base = _call_error(server, out, "project.create", {"name": "beta", "base": str(tmp_path / "nope")})
    assert "不存在" in missing_base["message"]

    missing_script = _call_error(server, out, "project.delete", {"dir": str(tmp_path / "nope")})
    assert "不存在" in missing_script["message"]

    no_name = _call_error(server, out, "project.create", {"base": str(tmp_path)})
    assert "缺少参数 name" in no_name["message"]
