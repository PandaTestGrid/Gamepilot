"""组合服务边界回归：旧入口可用，真实状态只属于 DeviceSession。

不按重构后的文本快照断言实现；只固定旧调用契约、职责归属和会影响行为的边界。
耗时/线程调度回归由 test_session_scheduling 覆盖。
"""

from __future__ import annotations

import ast
import base64
import importlib
import inspect
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from gamepilot import session as facade
from gamepilot.core.frame import Frame
from gamepilot.core.graph import Graph
from gamepilot.devices.synthetic_test import SyntheticController
from gamepilot.project import Project

# 属性、模块、类型及该服务实际拥有的代表方法；不是 mixin/继承拆文件。
_SERVICES = (
    ("_capture", "capture", "CaptureService", ("_capture_loop", "_emit_frame", "set_stream_fps")),
    ("_execution", "execution", "ExecutionService", ("_execution_loop", "_execute_frame", "start_run", "stop_run")),
    ("_recordings", "recordings", "RecordingService", ("_recording_loop", "_record_frame", "start_recording")),
    ("_history", "history", "HistoryService", ("frame_meta", "frame_at", "frame_history")),
    ("_inputs", "input", "InputService", ("touch", "tap", "swipe", "press", "run_action")),
    (
        "_editing",
        "editing",
        "GraphEditingService",
        ("graph_node_add", "graph_node_update", "save_graph", "record_action"),
    ),
    ("_materials", "materials", "MaterialRecordingService", ("record_template", "record_ocr")),
    ("_yolo", "yolo", "YoloService", ("add_example", "recognizer_detail", "preview_yolo")),
)


@pytest.fixture()
def session(tmp_path: Path) -> Iterator[Any]:
    controller = SyntheticController()
    controller.connect()
    instance = facade.DeviceSession(
        "synthetic:module-boundaries",
        controller,
        Project(root=str(tmp_path)).ensure(),
        lambda _method, _params: None,
    )
    try:
        yield instance
    finally:
        instance.stop()


def test_legacy_entrypoint_exports_original_objects() -> None:
    device = importlib.import_module("gamepilot.sessions.device")
    models = importlib.import_module("gamepilot.sessions.models")
    graph_ops = importlib.import_module("gamepilot.sessions.graph_ops")
    assert facade.DeviceSession is device.DeviceSession
    for name in (
        "WorkflowRunner",
        "FRAME_HISTORY",
        "FRAME_HISTORY_BYTES",
        "SCRCPY_LOOP_FPS",
        "TIMING_LOG_SECONDS",
        "SLEEP_BIAS_MAX",
        "SLEEP_BIAS_ALPHA",
        "PUSH_TOLERANCE",
        "Emit",
        "LEGACY_GRAPH_EDIT_ERROR",
        "_env_int",
        "flow_steps",
        "_load_graph",
        "describe_graph_error",
    ):
        assert getattr(facade, name) is getattr(models, name), name
    for name in (
        "_node_ref",
        "reject_legacy_graph_edit",
        "next_node_id",
        "graph_node_add",
        "graph_node_update",
        "graph_node_remove",
        "graph_edge_add",
        "graph_rename_recognizer",
        "graph_remove_recognizer",
    ):
        assert getattr(facade, name) is getattr(graph_ops, name), name
    yolo = importlib.import_module("gamepilot.sessions.yolo")
    for name in ("graph_recognizer_detail", "_decode_frame_data_url"):
        assert getattr(facade, name) is getattr(yolo, name), name


@pytest.mark.parametrize("module", ["device", "models", "graph_ops", *(item[1] for item in _SERVICES)])
def test_module_can_be_imported_first_in_a_fresh_interpreter(module: str) -> None:
    # 本进程早已 import 门面；单纯 importlib.import_module 会掩盖循环导入。
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(str(path) for path in sys.path if path)
    result = subprocess.run(
        [sys.executable, "-c", f"import importlib; importlib.import_module('gamepilot.sessions.{module}')"],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def _has_typed_session(service_type: type[Any]) -> bool:
    tree = ast.parse(inspect.getsource(service_type))
    # 构造参数注解再赋给 self.session 同样能让 mypy 推导属性类型。
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "__init__":
            for argument in node.args.args:
                if (
                    argument.arg == "session"
                    and isinstance(argument.annotation, ast.Name)
                    and argument.annotation.id == "DeviceSession"
                ):
                    return True
    for node in ast.walk(tree):
        if not isinstance(node, ast.AnnAssign):
            continue
        target = node.target
        if not (
            (isinstance(target, ast.Name) and target.id == "session")
            or (
                isinstance(target, ast.Attribute)
                and isinstance(target.value, ast.Name)
                and target.value.id == "self"
                and target.attr == "session"
            )
        ):
            continue
        annotation = node.annotation
        if isinstance(annotation, ast.Constant):
            return annotation.value == "DeviceSession"
        return isinstance(annotation, ast.Name) and annotation.id == "DeviceSession"
    return False


@pytest.mark.parametrize(("attribute", "module", "class_name", "methods"), _SERVICES)
def test_service_owns_implementation_but_not_a_copy_of_session_state(
    session: Any, attribute: str, module: str, class_name: str, methods: tuple[str, ...]
) -> None:
    service_type = getattr(importlib.import_module(f"gamepilot.sessions.{module}"), class_name)
    service = getattr(session, attribute)
    assert type(service) is service_type
    assert service.session is session
    assert service_type.__bases__ == (object,)
    assert _has_typed_session(service_type), "组合服务必须显式标注其 DeviceSession 引用"
    assert "__getattr__" not in service_type.__dict__
    # 锁、runner、frame、graph 等状态不能在抽取时复制进 service 并逐渐分叉。
    assert not (vars(service).keys() & vars(session).keys())
    for method in methods:
        implementation = service_type.__dict__.get(method)
        assert callable(implementation), f"{class_name}.{method} 必须是服务自己的实现"
        implementation_module = inspect.getmodule(implementation)
        assert implementation_module is not None
        assert implementation_module.__name__ == f"gamepilot.sessions.{module}"
    # 所有抽取的方法（包括私有跨服务调用）必须保留显式入口与原参数约束。
    for name, implementation in inspect.getmembers(service_type, inspect.isfunction):
        # close 是原 stop() 内联清理提取出来的新服务接口，不是旧会话方法。
        if name == "__init__" or (module == "recordings" and name == "close"):
            continue
        delegate = type(session).__dict__.get(name)
        assert delegate is not None, f"缺少 {class_name}.{name} 的显式 delegate"
        if isinstance(delegate, staticmethod):
            delegate = delegate.__func__
        assert inspect.signature(delegate) == inspect.signature(implementation), name


def test_device_uses_explicit_composition_not_inheritance_or_dynamic_forwarding(session: Any) -> None:
    assert type(session).__bases__ == (object,)
    assert "__getattr__" not in type(session).__dict__
    for _attribute, _module, _class_name, methods in _SERVICES:
        for method in methods:
            assert method in type(session).__dict__, f"旧入口 {method} 必须保留显式 delegate"


@pytest.mark.parametrize(
    ("attribute", "method", "args", "kwargs"),
    [
        ("_capture", "set_stream_fps", (17.0,), {}),
        ("_execution", "start_run", (), {"from_step_id": "step-2", "workflow_root": "other"}),
        ("_execution", "stop_run", (), {"workflow_root": "other"}),
        ("_recordings", "recording_meta", ("recording",), {"after_index": 8, "limit": 2}),
        ("_history", "frame_at", (9,), {"nearest": True}),
        ("_inputs", "swipe", (0.1, 0.2, 0.3, 0.4, 0.5), {}),
        ("_editing", "graph_node_update", ("node", {"name": "changed"}), {}),
        ("_materials", "record_ocr", ("rect", "label", "text"), {"search": "full", "as_enter": False}),
        ("_yolo", "preview_yolo", ("preview", []), {"tile": True, "freeze": False}),
    ],
)
def test_old_method_calls_the_bound_service_and_propagates_errors(
    session: Any,
    monkeypatch: pytest.MonkeyPatch,
    attribute: str,
    method: str,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> None:
    service = getattr(session, attribute)
    expected = RuntimeError("service-boundary-sentinel")
    captured: list[dict[str, Any]] = []
    signature = inspect.signature(getattr(service, method))
    wanted = signature.bind(*args, **kwargs)
    wanted.apply_defaults()

    def fail(*actual_args: Any, **actual_kwargs: Any) -> None:
        actual = signature.bind(*actual_args, **actual_kwargs)
        actual.apply_defaults()
        captured.append(dict(actual.arguments))
        raise expected

    monkeypatch.setattr(service, method, fail)
    with pytest.raises(RuntimeError) as raised:
        getattr(session, method)(*args, **kwargs)
    assert raised.value is expected
    assert captured == [dict(wanted.arguments)]


@pytest.mark.parametrize(
    ("method", "declaration"),
    [
        ("__init__", "self, device_id, controller, project, emit, *, fps=8.0, jpeg_width=0, jpeg_quality=92"),
        ("start_run", "self, from_step_id=None, workflow_root=None"),
        ("stop_run", "self, workflow_root=None"),
        ("frame_at", "self, index, nearest=False"),
        ("frame_history", "self, count=20"),
        ("recording_meta", "self, recording_id, *, after_index=-1, limit=100"),
        ("stop_recording", "self, recording_id=None"),
        ("record_action", "self, action, *, to=None"),
        ("graph_edge_add", "self, *, src, dst, when=None, action=None, condition=None"),
        (
            "record_template",
            "self, rect, label, threshold=0.82, *, as_enter=True, as_action_target=True, "
            "node_id=None, node_name=None, allocate_node_id=False, search='region'",
        ),
        (
            "record_ocr",
            "self, rect, label, text, *, mode='contains', threshold=0.6, as_enter=True, "
            "as_action_target=True, node_id=None, node_name=None, allocate_node_id=False, search='region'",
        ),
        (
            "preview_yolo",
            "self, preview_id, examples, *, conf=0.3, iou=0.45, imgsz=640, tile=False, "
            "tile_size=640, tile_overlap=0.2, freeze=True",
        ),
    ],
)
def test_public_call_signature_is_preserved(method: str, declaration: str) -> None:
    namespace: dict[str, Any] = {}
    exec(f"def expected({declaration}): pass", namespace)
    actual = inspect.signature(getattr(facade.DeviceSession, method))
    # 类型字符串的 import 路径不是调用契约，参数顺序、kw-only 和默认值才是。
    actual = actual.replace(
        parameters=[parameter.replace(annotation=inspect.Parameter.empty) for parameter in actual.parameters.values()],
        return_annotation=inspect.Signature.empty,
    )
    assert actual == inspect.signature(namespace["expected"])


def test_history_service_reads_live_session_history_and_keeps_gap_semantics(session: Any) -> None:
    assert session.frame_meta()["count"] == 0
    with pytest.raises(RuntimeError, match="历史帧"):
        session.frame_at(1, nearest=True)
    with session._history_lock:
        session._frame_history.extend([(2, b"older", 16, 8, 1.25), (8, b"newer", 32, 16, 2.75)])
    assert session.frame_meta()["indices"] == [2, 8]
    with pytest.raises(RuntimeError, match="滚出缓冲"):
        session.frame_at(5)
    # 等距选较早帧，同时保留请求号；不能把 service 初始化时的空 deque 作为真源。
    payload = session.frame_at(5, nearest=True)
    assert (payload["index"], payload["requestedIndex"]) == (2, 5)
    assert base64.b64decode(payload["jpeg"]) == b"older"
    assert session.frame_history(1)[0]["index"] == 8
    with session._history_lock:
        session._frame_history.clear()
    assert session.frame_meta()["count"] == 0


def test_recording_service_uses_shared_lifecycle_state_and_rejects_stale_generation(session: Any) -> None:
    first = session.start_recording()["recordingId"]
    with pytest.raises(RuntimeError, match="正在进行"):
        session.start_recording()
    session.stop_recording(first)
    second = session.start_recording()["recordingId"]
    frame = Frame(np.zeros((8, 16, 3), dtype=np.uint8), size=(16, 8), index=7, ts=3.0)
    # 上一录屏排队的帧不能串入新录屏，即便实现已移至独立 service。
    session._record_frame(frame, recording_id=first)
    assert session.recording_meta(second)["count"] == 0
    session._record_frame(frame, recording_id=second)
    assert session.recording_meta(second)["indices"] == [7]
    assert session.recording_frame_at(second, 7)["width"] == 16
    with pytest.raises(ValueError, match="不存在"):
        session.recording_frame_at(second, 6)
    with pytest.raises(ValueError, match="无效"):
        session.recording_meta("../outside")
    session.stop_recording(second)
    session.stop()
    with pytest.raises(RuntimeError, match="已关闭"):
        session.start_recording()


def test_graph_helpers_work_without_a_device_and_keep_flow_edit_guard(tmp_path: Path) -> None:
    graph = Graph.empty(str(tmp_path), path=str(tmp_path / "graph.json"))
    first = facade.graph_node_add(graph, None, "first", None)["nodeId"]
    second = facade.graph_node_add(graph, None, "second", None)["nodeId"]
    facade.graph_node_remove(graph, first)
    third = facade.graph_node_add(graph, None, "third", None)["nodeId"]
    assert third != second
    assert graph.nodes[second].name == "second"
    assert not (tmp_path / "graph.json").exists(), "纯图操作不应自行落盘"
    graph.flow = {"steps": [{"id": "start", "type": "manual", "params": {}}]}
    before = graph.to_dict()
    with pytest.raises(ValueError, match="步骤链"):
        facade.graph_node_add(graph, None, "not-added", None)
    assert graph.to_dict() == before


def test_architecture_stays_small_without_hiding_logic_in_the_facade() -> None:
    facade_path = Path(inspect.getfile(facade))
    tree = ast.parse(facade_path.read_text(encoding="utf-8"))
    assert not any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) for node in ast.walk(tree))
    limits = [(facade_path, 100), (Path(inspect.getfile(facade.DeviceSession)), 850)]
    for _attribute, module, _class_name, _methods in _SERVICES:
        service_module = importlib.import_module(f"gamepilot.sessions.{module}")
        limits.append((Path(inspect.getfile(service_module)), 600))
    # 仅作为膨胀护栏，行为/契约断言在上面；不固定具体行数或格式。
    for path, exclusive_limit in limits:
        assert len(path.read_text(encoding="utf-8").splitlines()) < exclusive_limit, path.name
