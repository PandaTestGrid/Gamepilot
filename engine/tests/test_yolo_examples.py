"""AI 识别器多示例：追加示例框 → spec 里累计 examples，参考帧落盘。"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import pytest

from gamepilot.devices.synthetic_test import SyntheticController
from gamepilot.project import Project
from gamepilot.session import DeviceSession


def _wait(predicate: Any, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


@pytest.fixture()
def session(tmp_path: Path) -> Any:
    controller = SyntheticController()
    controller.connect()
    instance = DeviceSession(
        "synthetic:test-1",
        controller,
        Project(root=str(tmp_path)).ensure(),
        lambda method, params: None,
        fps=20.0,
    )
    instance.start()
    instance.set_stream_fps(20.0)  # 帧缓冲只在推流时累积
    assert _wait(lambda: instance.last_frame is not None)
    yield instance
    instance.stop()


def _spec(session: DeviceSession, label: str) -> dict[str, Any]:
    return dict(session.graph.specs.get(label) or {})


def test_add_recognizer_materializes_example_frame(session: DeviceSession, tmp_path: Path) -> None:
    result = session.add_recognizer(
        "monster",
        {
            "type": "yolo",
            "examples": [{"rect": [0.1, 0.1, 0.2, 0.2], "label": "monster"}],
            "threshold": 0.3,
        },
    )

    examples = _spec(session, "monster")["examples"]
    assert len(examples) == 1
    image = Path(tmp_path) / examples[0]["template"]
    assert image.is_file()
    assert result["label"] == "monster"


def test_add_example_appends_and_saves_new_frame(session: DeviceSession, tmp_path: Path) -> None:
    session.add_recognizer(
        "monster",
        {"type": "yolo", "examples": [{"rect": [0.1, 0.1, 0.2, 0.2], "label": "monster"}]},
    )

    result = session.add_example("monster", [0.4, 0.4, 0.2, 0.2])

    assert result["examples"] == 2
    examples = _spec(session, "monster")["examples"]
    assert [item["rect"] for item in examples] == [[0.1, 0.1, 0.2, 0.2], [0.4, 0.4, 0.2, 0.2]]
    assert all((Path(tmp_path) / item["template"]).is_file() for item in examples)


def test_add_example_rejects_non_yolo(session: DeviceSession) -> None:
    session.graph.add_recognizer(
        "plain",
        {"type": "template", "template": "templates/x.png", "threshold": 0.8},
    )

    with pytest.raises(RuntimeError):
        session.add_example("plain", [0, 0, 0.1, 0.1])


def test_decode_frame_data_url() -> None:
    import base64

    import cv2
    import numpy as np

    from gamepilot.session import _decode_frame_data_url

    image = np.zeros((8, 8, 3), dtype=np.uint8)
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    url = "data:image/png;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")
    decoded = _decode_frame_data_url(url)
    assert decoded is not None
    assert decoded.shape == (8, 8, 3)

    assert _decode_frame_data_url("not-a-data-url") is None
    assert _decode_frame_data_url("data:image/png;base64,%%%%") is None


def test_frame_history_returns_recent_frames(session: DeviceSession) -> None:
    frames = session.frame_history(5)
    assert 1 <= len(frames) <= 5
    first = frames[-1]
    assert set(first) == {"index", "jpeg", "width", "height", "ts"}
    assert first["width"] > 0
    assert first["height"] > 0
    assert base64_ok(first["jpeg"])


def base64_ok(payload: str) -> bool:
    import base64

    try:
        return len(base64.b64decode(payload)) > 0
    except Exception:
        return False


def test_recognizer_detail_and_update(session: DeviceSession, tmp_path: Path) -> None:
    session.add_recognizer(
        "monster",
        {"type": "yolo", "examples": [{"rect": [0.1, 0.1, 0.2, 0.2], "label": "monster"}], "threshold": 0.3, "roi": [0.2, 0.1, 0.5, 0.7]},
    )

    detail = session.recognizer_detail("monster")
    assert detail["threshold"] == 0.3
    assert detail["roi"] == [0.2, 0.1, 0.5, 0.7]
    assert len(detail["examples"]) == 1
    example = detail["examples"][0]
    assert example["rect"] == [0.1, 0.1, 0.2, 0.2]
    assert example["image"].startswith("data:image/jpeg;base64,")
    assert example["width"] > 0 and example["height"] > 0

    session.recognizer_update(
        "monster",
        {
            "type": "yolo",
            "threshold": 0.4,
            "search": "full",
            "imgsz": 960,
            "tile": True,
            "tile_size": 640,
            "tile_overlap": 0.3,
            "examples": [
                {"rect": [0.2, 0.2, 0.3, 0.3], "label": "monster", "image": example["image"]},
                {"rect": [0.4, 0.4, 0.2, 0.2], "label": "monster", "image": example["image"]},
            ],
        },
    )
    spec = session.graph.specs["monster"]
    assert spec["threshold"] == 0.4
    assert spec["tile"] is True
    assert len(spec["examples"]) == 2
    assert (tmp_path / "templates" / "monster_ai1.png").is_file()

    session.recognizer_update(
        "monster",
        {
            "type": "yolo",
            "examples": [{"rect": [0.2, 0.2, 0.3, 0.3], "label": "monster", "image": example["image"]}],
        },
    )
    assert len(session.graph.specs["monster"]["examples"]) == 1
    assert not (tmp_path / "templates" / "monster_ai1.png").exists()

    # 没带 roi = 不动它；显式传 null = 用户点了「清除 ROI」，旧值必须删掉
    assert session.graph.specs["monster"]["roi"] == [0.2, 0.1, 0.5, 0.7]
    session.recognizer_update(
        "monster",
        {
            "type": "yolo",
            "roi": None,
            "examples": [{"rect": [0.2, 0.2, 0.3, 0.3], "label": "monster", "image": example["image"]}],
        },
    )
    assert "roi" not in session.graph.specs["monster"]
    assert session.recognizer_detail("monster")["roi"] is None


def test_recognizer_detail_rejects_non_yolo(session: DeviceSession) -> None:
    session.graph.add_recognizer("plain", {"type": "template", "template": "templates/x.png"})
    with pytest.raises(RuntimeError):
        session.recognizer_detail("plain")


def test_frame_meta_and_frame_at(session: DeviceSession) -> None:
    meta = session.frame_meta()
    assert meta["count"] >= 1
    assert meta["lastIndex"] >= meta["firstIndex"]
    frame = session.frame_at(meta["lastIndex"])
    assert frame["index"] == meta["lastIndex"]
    assert frame["requestedIndex"] == meta["lastIndex"]
    assert frame["width"] > 0 and frame["height"] > 0
    assert base64_ok(frame["jpeg"])
    with pytest.raises(RuntimeError):
        session.frame_at(-12345)


def test_frame_at_nearest_returns_closest_retained_frame(session: DeviceSession) -> None:
    # 停推流后用固定缓冲构造场景，避免后台截图线程继续往 _frame_history 追加帧
    session.set_stream_fps(0.0)
    time.sleep(0.1)
    with session.lock:
        session._frame_history.clear()
        session._history_bytes = 0
        for index, ts in ((1000, 1.0), (1002, 2.0), (1005, 3.0)):
            session._frame_history.append((index, b"\xff\xd8\xff\xd9", 4, 3, ts))

    exact = session.frame_at(1002)
    assert exact["index"] == 1002
    assert exact["requestedIndex"] == 1002

    # 默认 nearest=False：帧已滚出缓冲仍然报错（旧行为不变）
    with pytest.raises(RuntimeError):
        session.frame_at(999)

    older = session.frame_at(995, nearest=True)
    assert older["index"] == 1000  # 比 first 还老 → first
    assert older["requestedIndex"] == 995

    newer = session.frame_at(1105, nearest=True)
    assert newer["index"] == 1005  # 比 last 还新 → last
    assert newer["requestedIndex"] == 1105

    gap = session.frame_at(1003, nearest=True)
    assert gap["index"] == 1002  # 跳号空隙：绝对差最小的那帧

    # 缓冲为空时即使 nearest=True 也报错
    with session.lock:
        session._frame_history.clear()
    with pytest.raises(RuntimeError, match="还没有可用的历史帧"):
        session.frame_at(1000, nearest=True)
