"""步骤链（`flow.steps`）：数据模型、校验、以及和 `graph.json` 的往返。

这条链和状态图（nodes/edges）**并存**，所以最要紧的两件事是：
  1. 有 flow 的图存了能读回来；
  2. **没有 flow 的老图完全不受影响**（读回来是 None，写出去也不会多一个键）。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from gamepilot.core.flow_model import validate_flow
from gamepilot.core.graph import Graph


def flow(*steps: dict[str, Any]) -> dict[str, Any]:
    return {"steps": list(steps)}


def step(step_id: str, kind: str, **params: Any) -> dict[str, Any]:
    return {"id": step_id, "type": kind, "params": params}


def test_accepts_a_normal_chain() -> None:
    raw = flow(
        step("s1", "schedule", at="06:00"),
        step("s2", "wait", rec="主城"),
        step("s3", "click", rec="挑战按钮"),
        step("s4", "delay", ms=500),
    )
    out = validate_flow(raw, {"主城", "挑战按钮"})
    assert [item["type"] for item in out["steps"]] == ["schedule", "wait", "click", "delay"]


def test_legacy_wires_are_dropped() -> None:
    """旧文件里的 wires 不再保留：连线由步骤顺序推导。"""
    raw = flow(step("s1", "manual"), step("s2", "delay", ms=1))
    raw["wires"] = [{"source": "s1", "target": "s2"}]
    out = validate_flow(raw, set())
    assert set(out) == {"steps"}


def test_first_step_must_be_a_trigger() -> None:
    # 没有触发器，这条链就不知道该什么时候开始跑（Automa 也是硬要求）
    with pytest.raises(ValueError, match="第一步必须是触发器"):
        validate_flow(flow(step("s1", "click", x=0.5, y=0.5)), set())


def test_rejects_unknown_kind_duplicate_id_and_broken_params() -> None:
    with pytest.raises(ValueError, match="类型不认识"):
        validate_flow(flow(step("s1", "manual"), step("s2", "teleport")), set())
    with pytest.raises(ValueError, match="id 重复"):
        validate_flow(flow(step("s1", "manual"), step("s1", "delay")), set())
    with pytest.raises(ValueError, match="params 必须是对象"):
        validate_flow({"steps": [{"id": "s1", "type": "manual", "params": 1}]}, set())


def test_rejects_unknown_recognizer_reference() -> None:
    with pytest.raises(ValueError, match="不存在的识别器"):
        validate_flow(flow(step("s1", "manual"), step("s2", "wait", rec="不存在的界面")), {"主城"})


def test_empty_condition_is_rejected_when_running_but_allowed_in_draft() -> None:
    raw = flow(
        step("s1", "manual"),
        step("c", "cond"),
        step("ce", "condend", back="c"),
    )
    with pytest.raises(ValueError, match="没有配置识别器"):
        validate_flow(raw, set())
    draft = validate_flow(raw, set(), strict=False)
    assert [item["type"] for item in draft["steps"]] == ["manual", "cond", "condend"]
    legacy = flow(
        step("s1", "manual"),
        step("c", "cond", rec="公告弹窗"),
        step("ce", "condend", back="c"),
    )
    assert validate_flow(legacy, {"公告弹窗"}, strict=True) is not None


def test_rejects_unknown_step_kind() -> None:
    with pytest.raises(ValueError, match="类型不认识"):
        validate_flow(flow(step("s1", "manual"), step("s2", "bogus_kind")), set())


def test_loop_block_pairs_loop_loopend() -> None:
    raw = flow(
        step("s1", "manual"),
        step("lp", "loop", count=3),
        step("d", "delay", ms=1),
        step("le", "loopend", back="lp"),
    )
    out = validate_flow(raw, set())
    assert [item["type"] for item in out["steps"]] == ["manual", "loop", "delay", "loopend"]


def test_nested_loop_and_cond_lifo() -> None:
    raw = flow(
        step("s1", "manual"),
        step("lp", "loop", count=2),
        step("c", "cond", rec="主城"),
        step("inner", "loop", count=2),
        step("d", "delay", ms=1),
        step("ile", "loopend", back="inner"),
        step("ce", "condend", back="c"),
        step("le", "loopend", back="lp"),
    )
    assert len(validate_flow(raw, {"主城"})["steps"]) == 8


def test_loopbreak_must_be_inside_a_loop_when_strict() -> None:
    with pytest.raises(ValueError, match="跳出循环"):
        validate_flow(flow(step("s1", "manual"), step("b", "loopbreak")), set(), strict=True)


def test_loopbreak_outside_loop_allowed_in_draft_save() -> None:
    out = validate_flow(flow(step("s1", "manual"), step("b", "loopbreak")), set(), strict=False)
    assert [s["type"] for s in out["steps"]] == ["manual", "loopbreak"]


def test_loop_end_must_close_nearest_open_loop() -> None:
    with pytest.raises(ValueError, match="只能关掉最近那个还没结束的「循环」"):
        validate_flow(
            flow(
                step("s1", "manual"),
                step("a", "loop", count=1),
                step("b", "loop", count=1),
                step("le", "loopend", back="a"),
            ),
            set(),
        )


def test_graph_round_trip_keeps_flow(tmp_path: Path) -> None:
    """存了再读，flow 一模一样（这是"点节点配参数之后能不能存下来"的前提）。"""
    data = {
        "version": 1,
        "nodes": [{"id": "n_1", "name": "主城", "enter": []}],
        "edges": [],
        "recognizers": {},
        "variables": {},
        "flow": flow(step("s1", "manual"), step("s2", "delay", ms=500)),
    }
    graph = Graph.from_dict(data, str(tmp_path), str(tmp_path / "graph.json"))
    graph.save()
    again = Graph.load(str(tmp_path / "graph.json"))
    assert again.flow == {"steps": [step("s1", "manual"), step("s2", "delay", ms=500)]}


def test_old_graph_without_flow_is_untouched(tmp_path: Path) -> None:
    """老图（没有 flow 键）不能被这次改动影响：读回来是 None，写出去也不多一个键。"""
    data = {"version": 1, "nodes": [{"id": "n_1", "name": "A", "enter": []}], "edges": [], "recognizers": {}}
    graph = Graph.from_dict(data, str(tmp_path), str(tmp_path / "graph.json"))
    assert graph.flow is None
    graph.save()
    written = json.loads((tmp_path / "graph.json").read_text(encoding="utf-8"))
    assert "flow" not in written


def test_empty_flow_is_kept_on_purpose(tmp_path: Path) -> None:
    """`{"steps": []}` = "用过步骤链、还一步没加"，和"从来没启用过"不是一回事。"""
    graph = Graph.from_dict(
        {"version": 1, "nodes": [], "edges": [], "recognizers": {}, "flow": {"steps": []}},
        str(tmp_path),
        str(tmp_path / "graph.json"),
    )
    graph.save()
    assert json.loads((tmp_path / "graph.json").read_text(encoding="utf-8"))["flow"] == {"steps": []}


def test_save_refuses_a_chain_that_breaks_the_rules(tmp_path: Path) -> None:
    """落盘前自检：坏链不许写出去（不然应用下次启动读盘就崩）。"""
    graph = Graph.from_dict(
        {"version": 1, "nodes": [], "edges": [], "recognizers": {}, "flow": {"steps": []}},
        str(tmp_path),
        str(tmp_path / "graph.json"),
    )
    graph.flow = {"steps": [{"id": "s1", "type": "teleport", "params": {}}]}
    with pytest.raises(ValueError, match="类型不认识"):
        graph.save()


def test_condition_block_pairs_cond_else_condend() -> None:
    """完整的 if/else：条件 … 否则 … 条件结束。"""
    raw = flow(
        step("s1", "manual"),
        step("c", "cond", rec="公告弹窗"),
        step("t1", "click", x=0.5, y=0.5),
        step("e", "else"),
        step("f1", "key", value="back"),
        step("ce", "condend", back="c"),
    )
    out = validate_flow(raw, {"公告弹窗"})
    assert [item["type"] for item in out["steps"]] == ["manual", "cond", "click", "else", "key", "condend"]


def test_condition_block_without_else_is_allowed() -> None:
    """没写「否则」= 没命中就整块跳过。"""
    raw = flow(
        step("s1", "manual"),
        step("c", "cond", rec="公告弹窗"),
        step("t1", "click", x=0.5, y=0.5),
        step("ce", "condend", back="c"),
    )
    assert len(validate_flow(raw, {"公告弹窗"})["steps"]) == 4


def test_condition_end_must_close_the_nearest_open_condition() -> None:
    with pytest.raises(ValueError, match="只能关掉最近那个还没结束的「条件」"):
        validate_flow(flow(step("s1", "manual"), step("ce", "condend", back="nope")), set())
    with pytest.raises(ValueError, match="只能关掉最近那个还没结束的「条件」"):
        # 跳过内层去关外层 → 拒（和循环同一条规矩）
        validate_flow(
            flow(
                step("s1", "manual"),
                step("a", "cond", rec="主城"),
                step("b", "cond", rec="公告弹窗"),
                step("e", "else"),
                step("ce1", "condend", back="a"),
                step("ce2", "condend", back="b"),
            ),
            {"主城", "公告弹窗"},
        )


def test_else_must_be_inside_a_condition_and_only_once() -> None:
    with pytest.raises(ValueError, match="「否则」只能放在「条件」块里"):
        validate_flow(flow(step("s1", "manual"), step("e", "else")), set())
    with pytest.raises(ValueError, match="已经有「否则」了"):
        validate_flow(
            flow(
                step("s1", "manual"),
                step("c", "cond", rec="主城"),
                step("e1", "else"),
                step("e2", "else"),
                step("ce", "condend", back="c"),
            ),
            {"主城"},
        )


def test_unclosed_condition_is_rejected() -> None:
    with pytest.raises(ValueError, match="没有对应的「条件结束」"):
        validate_flow(flow(step("s1", "manual"), step("c", "cond", rec="主城")), {"主城"})


def test_condition_reference_must_exist() -> None:
    with pytest.raises(ValueError, match="不存在的识别器"):
        validate_flow(
            flow(step("s1", "manual"), step("c", "cond", rec="没有这个"), step("ce", "condend", back="c")),
            {"主城"},
        )


def test_disabled_step_is_kept_and_block_marks_cannot_be_disabled() -> None:
    """`disabled` = "这一步先不跑"：普通步骤、循环/条件头能停用；隐藏的块边界不行。"""
    ok = validate_flow(
        {"steps": [step("s1", "manual"), {"id": "s2", "type": "click", "params": {}, "disabled": True}]},
        set(),
    )
    assert ok["steps"][1]["disabled"] is True

    loop_ok = validate_flow(
        {
            "steps": [
                step("s1", "manual"),
                {"id": "lp", "type": "loop", "params": {"count": 2}, "disabled": True},
                step("d", "delay", ms=1),
                step("le", "loopend", back="lp"),
            ]
        },
        set(),
    )
    assert loop_ok["steps"][1]["disabled"] is True

    with pytest.raises(ValueError, match="不能停用"):
        validate_flow(
            {
                "steps": [
                    step("s1", "manual"),
                    step("c", "cond", rec="x"),
                    {"id": "ce", "type": "condend", "params": {"back": "c"}, "disabled": True},
                ]
            },
            {"x"},
        )


def test_end_step_is_a_known_kind_and_anywhere_in_the_chain() -> None:
    """「结束」是普通步骤：没有配对标记，可以出现在条件支里（= Python 的 return）。"""
    data = flow(
        step("s1", "manual"),
        step("s2", "cond", rec="主城"),
        step("s3", "end"),
        step("s4", "else"),
        step("s5", "condend", back="s2"),
    )
    kept = validate_flow(data, labels={"主城"})["steps"]
    assert [item["id"] for item in kept] == ["s1", "s2", "s3", "s4", "s5"]
