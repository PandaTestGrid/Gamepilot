from __future__ import annotations

import json
from pathlib import Path

import pytest

from gamepilot.core.flow_model import explicit_click_target_mode
from gamepilot.core.graph import Graph
from gamepilot.migrate_click_modes import apply_migration, plan_migration, workspace_graphs


def graph_text() -> str:
    return json.dumps(
        {
            "version": 1,
            "nodes": [],
            "edges": [],
            "recognizers": {},
            "flow": {
                "steps": [
                    {"id": "start", "type": "manual", "params": {}},
                    {"id": "click", "type": "click", "params": {"by": "识别器", "rec": ""}},
                    {"id": "coord", "type": "click", "params": {"by": "坐标", "x": 0.2, "y": 0.3}},
                    {"id": "region", "type": "click", "params": {"by": "随机范围", "rect": [0, 0, 1, 1]}},
                    {"id": "wait", "type": "wait", "params": {"by": "识别器", "rec": ""}},
                    {"id": "text", "type": "text", "params": {"value": 'literal "by": "识别器"'}},
                ]
            },
        },
        ensure_ascii=False,
        indent=2,
    )


@pytest.mark.parametrize("escaped", [False, True])
@pytest.mark.parametrize("bom", [b"", b"\xef\xbb\xbf"])
def test_backup_token_only_edit_load_and_idempotence(tmp_path: Path, escaped: bool, bom: bytes) -> None:
    path = tmp_path / "graph.json"
    text = graph_text().replace("\n", "\r\n")
    if escaped:
        text = text.replace('"by": "识别器"', '"by": "\\u8bc6\\u522b\\u5668"')
    original = bom + text.encode()
    path.write_bytes(original)
    plan = plan_migration(path)
    assert plan is not None and plan.changes == 4
    assert path.read_bytes() == original
    backup = apply_migration(plan)
    assert backup is not None
    assert backup.read_bytes() == original
    expected = (
        text.replace('"by": "识别器"', '"by": "recognizer"')
        .replace('"by": "\\u8bc6\\u522b\\u5668"', '"by": "recognizer"')
        .replace('"by": "坐标"', '"by": "coord"')
        .replace('"by": "随机范围"', '"by": "region"')
    )
    assert path.read_bytes() == bom + expected.encode()
    Graph.from_dict(json.loads(path.read_text(encoding="utf-8-sig")), str(tmp_path))
    assert plan_migration(path) is None
    assert len(list(tmp_path.glob("*.bak"))) == 1


def test_unknown_mode_is_never_guessed_or_backed_up(tmp_path: Path) -> None:
    path = tmp_path / "graph.json"
    original = graph_text().replace('"by": "坐标"', '"by": "未知方式"').encode()
    path.write_bytes(original)
    with pytest.raises(ValueError, match="by 必须是"):
        plan_migration(path)
    assert path.read_bytes() == original
    assert not list(tmp_path.glob("*.bak"))


def test_by_outside_step_params_refuses_lossy_global_replacement(tmp_path: Path) -> None:
    path = tmp_path / "graph.json"
    data = json.loads(graph_text())
    data["metadata"] = {"by": "识别器"}
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="步骤参数以外"):
        plan_migration(path)


def test_file_changed_since_preview_is_not_overwritten(tmp_path: Path) -> None:
    path = tmp_path / "graph.json"
    path.write_text(graph_text(), encoding="utf-8")
    plan = plan_migration(path)
    assert plan is not None
    changed = path.read_bytes() + b"\n"
    path.write_bytes(changed)
    with pytest.raises(RuntimeError, match="文件已改变"):
        apply_migration(plan)
    assert path.read_bytes() == changed
    assert not list(tmp_path.glob("*.bak"))


def test_workspace_scan_is_direct_and_ignores_hidden_folders(tmp_path: Path) -> None:
    paths = [tmp_path / "graph.json", tmp_path / "flow" / "graph.json"]
    for path in [*paths, tmp_path / ".backup" / "graph.json", tmp_path / "flow" / "nested" / "graph.json"]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}", encoding="utf-8")
    assert set(workspace_graphs(tmp_path)) == set(paths)


def test_explicit_no_backup_for_disposable_debug_data(tmp_path: Path) -> None:
    path = tmp_path / "graph.json"
    path.write_text(graph_text(), encoding="utf-8")
    plan = plan_migration(path)
    assert plan is not None
    assert apply_migration(plan, backup_original=False) is None
    assert not list(tmp_path.glob("*.bak"))
    assert plan_migration(path) is None
    Graph.load(str(path))


def test_runtime_stays_strict_after_adding_offline_migration() -> None:
    for value in ("识别器", "坐标", "随机范围"):
        with pytest.raises(ValueError, match="by 必须是"):
            explicit_click_target_mode({"by": value})
