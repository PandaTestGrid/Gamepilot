"""执行证据（`core/evidence.py`）：每一步的截图与参数要能落到磁盘、事后拿得到。

必须钉住的点：
  - 目录在 `<工作流>/.runs/<时间戳>/` 下，事件流水一行一条 JSON；
  - 截图文件名带步号，且 `image_bytes` 只认本目录里的单层文件名（防目录穿越）；
  - 只保留最近 N 次运行（截图很占地方，跑一天就是几个 GB）。
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from gamepilot.core.evidence import RunEvidence


def _image() -> np.ndarray:
    return np.zeros((8, 8, 3), dtype=np.uint8)


def test_step_writes_screenshot_and_record(tmp_path: Path) -> None:
    evidence = RunEvidence(tmp_path, stamp="20261018-200000")
    record = evidence.step(3, "s3", "click", _image(), message="点一下")
    evidence.event({"seq": 1, "type": "step_started", "node": "s3"})
    evidence.close()

    assert record["screenshot"].startswith("003_")
    assert record["stepId"] == "s3"
    shots = sorted(item.name for item in evidence.dir.glob("*.jpg"))
    assert shots == [record["screenshot"]]
    lines = [json.loads(line) for line in (evidence.dir / "trace.jsonl").read_text(encoding="utf-8").splitlines()]
    assert lines == [{"seq": 1, "type": "step_started", "node": "s3"}]


def test_to_dict_and_image_bytes(tmp_path: Path) -> None:
    evidence = RunEvidence(tmp_path, stamp="20261018-200001")
    record = evidence.step(1, "s1", "click", _image())
    evidence.close()

    bundle = evidence.to_dict()
    assert bundle["dir"] == str(Path(".runs") / "20261018-200001")
    assert bundle["steps"][0]["stepId"] == "s1"
    assert evidence.image_bytes(str(record["screenshot"])) is not None
    # 目录穿越 / 非图片一律拒绝
    assert evidence.image_bytes("../trace.jsonl") is None
    assert evidence.image_bytes("trace.jsonl") is None
    assert evidence.image_bytes("不存在.jpg") is None


def test_step_id_is_sanitized_for_the_file_name(tmp_path: Path) -> None:
    evidence = RunEvidence(tmp_path, stamp="20261018-200002")
    record = evidence.step(2, "步骤/一 a", "key", None)
    evidence.close()
    assert record["screenshot"] == ""
    evidence2 = RunEvidence(tmp_path, stamp="20261018-200003")
    record2 = evidence2.step(2, "步骤/一 a", "key", _image())
    evidence2.close()
    assert "/" not in record2["screenshot"]


def test_prunes_old_runs(tmp_path: Path) -> None:
    for index in range(4):
        RunEvidence(tmp_path, stamp=f"2026101{index}-000000", keep=2).close()
    runs = sorted(item.name for item in (tmp_path / ".runs").iterdir())
    assert runs == ["20261012-000000", "20261013-000000"]
