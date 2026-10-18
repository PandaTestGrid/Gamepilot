"""步骤链模型与校验（与状态图并存、不互转）。

首步须为触发器；条件块 cond / else? / condend、循环块 loop / loopend，均严格 LIFO 嵌套（可相互嵌套）。
"""

from __future__ import annotations

from typing import Any

#: 触发器：决定"什么时候开始跑"
TRIGGER_KINDS = ("manual", "schedule", "interval")

#: 引擎认识的步骤类型（前端的目录照着这份来）
STEP_KINDS = (
    # 触发
    "manual",
    "schedule",
    "interval",
    # 界面同步 —— 游戏特有：点完是**异步**切界面，没有任何回调告诉你"到了"
    "wait",
    # 动作
    "click",
    "hold",
    "swipe",
    "key",
    "text",
    # 流程
    "delay",
    "cond",
    "else",
    "condend",
    "loop",
    "loopend",
    "loopbreak",
    "end",
    "call",
    "setvar",
)

#: 参数里带识别器引用的步骤：`params.rec` 必须是已定义的识别器
_NEEDS_RECOGNIZER = ("wait", "cond")

#: 隐藏的块边界：不能停用（停用会让分支失去边界）。循环/条件头可以停用 = 跳过整块。
_BLOCK_MARKS = ("else", "condend", "loopend")


def cond_recognizer_labels(params: object) -> list[str]:
    """条件模块引用的识别器：groups 内且、组间或；兼容 params.rec。"""
    if not isinstance(params, dict):
        return []
    found: list[str] = []
    groups = params.get("groups")
    if isinstance(groups, list):
        for group in groups:
            if not isinstance(group, dict):
                continue
            all_of = group.get("all")
            if not isinstance(all_of, list):
                continue
            for item in all_of:
                label = str(item).strip() if item is not None else ""
                if label:
                    found.append(label)
    if found:
        return found
    rec = params.get("rec")
    if rec:
        return [str(rec)]
    return []


def _validate_loopbreak(params: dict[str, Any], frames: list[tuple[str, str]]) -> None:
    """strict 模式下卡「跳出循环」的位置：必须在某个仍打开的循环体里，且 back 指回它。"""
    if not any(frame[0] == "loop" for frame in frames):
        raise ValueError("「跳出循环」必须写在「循环」和「循环结束」之间")
    back = params.get("back")
    if back and not any(frame == ("loop", back) for frame in frames):
        raise ValueError("「跳出循环」的 back 必须指向当前仍打开的某个「循环」")


def validate_flow(raw: object, labels: set[str], *, strict: bool = True) -> dict[str, Any]:
    """校验并归一化。`strict=False` 时允许未闭合的条件（编辑中草稿）。"""
    if not isinstance(raw, dict):
        raise ValueError("flow 必须是对象")
    steps = raw.get("steps")
    if not isinstance(steps, list):
        raise ValueError("flow.steps 必须是数组")
    seen: set[str] = set()
    frames: list[tuple[str, str]] = []
    cond_has_else: set[str] = set()
    kept: list[Any] = []
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValueError("flow.steps 的每一项都必须是对象")
        step_id = step.get("id")
        if not isinstance(step_id, str) or not step_id:
            raise ValueError(f"第 {index + 1} 步缺少 id")
        if step_id in seen:
            raise ValueError(f"步骤 id 重复: {step_id}")
        seen.add(step_id)

        kind = step.get("type")
        if kind not in STEP_KINDS:
            raise ValueError(f"第 {index + 1} 步的类型不认识: {kind}")
        params = step.get("params", {})
        if not isinstance(params, dict):
            raise ValueError(f"第 {index + 1} 步的 params 必须是对象")

        if index == 0 and kind not in TRIGGER_KINDS:
            raise ValueError("第一步必须是触发器（手动 / 定时 / 每隔一段）")

        if kind == "loopbreak" and isinstance(params, dict) and params.get("_implicit"):
            continue

        kept.append(step)

        if kind in _NEEDS_RECOGNIZER:
            refs = cond_recognizer_labels(params) if kind == "cond" else [params.get("rec")]
            for label in refs:
                if label and label not in labels:
                    raise ValueError(f"第 {index + 1} 步引用了不存在的识别器: {label}")
            if kind == "cond" and strict and not refs:
                raise ValueError(f"第 {index + 1} 步的「条件」没有配置识别器")

        if step.get("disabled") and kind in _BLOCK_MARKS:
            raise ValueError(f"第 {index + 1} 步是块的标记，不能停用")

        if kind == "setvar" and strict:
            name = str(params.get("name") or "").strip()
            if not name:
                raise ValueError(f"第 {index + 1} 步的「赋值」没写变量名")

        if kind == "cond":
            frames.append(("cond", step_id))
        elif kind == "loop":
            frames.append(("loop", step_id))
        elif kind == "else":
            if not frames or frames[-1][0] != "cond":
                raise ValueError("「否则」只能放在「条件」块里（在「条件」和「条件结束」之间）")
            if frames[-1][1] in cond_has_else:
                raise ValueError("这个「条件」已经有「否则」了")
            cond_has_else.add(frames[-1][1])
        elif kind == "condend":
            back = params.get("back")
            if not frames or frames[-1] != ("cond", back):
                raise ValueError("「条件结束」只能关掉最近那个还没结束的「条件」")
            frames.pop()
        elif kind == "loopend":
            back = params.get("back")
            if not frames or frames[-1] != ("loop", back):
                raise ValueError("「循环结束」只能关掉最近那个还没结束的「循环」")
            frames.pop()
        elif kind == "loopbreak" and strict:
            # 保存/草稿用 strict=False：允许链尾未接入的「跳出循环」；开跑时 strict=True 再卡位置
            _validate_loopbreak(params, frames)

    if frames and strict:
        if frames[-1][0] == "cond":
            raise ValueError("有「条件」没有对应的「条件结束」")
        raise ValueError("有「循环」没有对应的「循环结束」")
    return {"steps": [dict(step) for step in kept]}
