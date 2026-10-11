"""边的判断条件。

一条边"能不能走"由条件决定。支持：

- ``all_of``：这些标签**全部**命中（默认；兼容原来的 ``when`` 单标签写法）
- ``any_of``：任一命中（"出现 A 或 B 都算进入下一界面"）
- ``none_of``：这些标签**都不得出现**（"没有弹窗时才走"）
- ``min_score``：命中分数门槛
- ``within_ms``：**限时等待** —— 从进入源节点开始计时；超过这个时间条件还没成立，
  这条边就不再可用（并上报超时），用来表达"等界面出现，最多等 10 秒"。

条件在每帧重新求值（非阻塞），所以低帧率下也不会把时序搞乱。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

# "无条件"边的 when 用这个哨兵值（它不是一个识别器标签，校验时要跳过）
ALWAYS_LABEL = "always"


@dataclass(frozen=True)
class Condition:
    all_of: tuple[str, ...] = ()
    any_of: tuple[str, ...] = ()
    none_of: tuple[str, ...] = ()
    min_score: float = 0.0
    within_ms: int = 0
    # 总是成立（录制出来的一步：不依赖任何识别器，进节点就做）
    always: bool = False

    # ---------------------------------------------------------------- #
    # 解析 / 序列化
    # ---------------------------------------------------------------- #

    @classmethod
    def parse(cls, spec: object, *, fallback: str | None = None) -> Condition:
        """从 graph.json 的 ``condition`` 字段解析；没有就和 ``when`` 等价。"""
        if spec is None or spec == {}:
            return cls(all_of=(fallback,)) if fallback else cls(always=True)
        if spec is True or spec == "always":
            return cls(always=True)
        if isinstance(spec, str):
            return cls(all_of=(spec,))
        if not isinstance(spec, dict):
            raise ValueError(f"condition 必须是对象，收到: {type(spec).__name__}")

        def labels(key: str) -> tuple[str, ...]:
            value = spec.get(key, [])
            if isinstance(value, str):
                return (value,)
            if isinstance(value, (list, tuple)):
                return tuple(str(item) for item in value if str(item).strip())
            raise ValueError(f"condition.{key} 必须是字符串或字符串数组")

        if spec.get("always") is True:
            always = True
            return cls(always=always, within_ms=_as_ms(spec.get("within_ms", 0)))

        all_of = labels("all_of")
        any_of = labels("any_of")
        none_of = labels("none_of")
        if not all_of and not any_of and fallback:
            all_of = (fallback,)
        if spec.get("when") is not None:
            all_of = (*all_of, str(spec["when"]))
        if not (all_of or any_of or none_of):
            raise ValueError("condition 至少要有一个 all_of / any_of / none_of 标签")

        min_score = spec.get("min_score", 0.0)
        within_ms = spec.get("within_ms", 0)
        if not isinstance(min_score, (int, float)):
            raise ValueError("condition.min_score 必须是数字")
        if not isinstance(within_ms, (int, float)):
            raise ValueError("condition.within_ms 必须是毫秒数")
        return cls(
            all_of=all_of,
            any_of=any_of,
            none_of=none_of,
            min_score=float(min_score),
            within_ms=int(within_ms),
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.always:
            out["always"] = True
            if self.within_ms:
                out["within_ms"] = self.within_ms
            return out
        if self.all_of:
            out["all_of"] = list(self.all_of)
        if self.any_of:
            out["any_of"] = list(self.any_of)
        if self.none_of:
            out["none_of"] = list(self.none_of)
        if self.min_score:
            out["min_score"] = self.min_score
        if self.within_ms:
            out["within_ms"] = self.within_ms
        return out

    # ---------------------------------------------------------------- #
    # 求值
    # ---------------------------------------------------------------- #

    @property
    def labels(self) -> tuple[str, ...]:
        """条件里引用的所有标签（校验用：必须都能在识别器里找到）。"""
        return tuple(dict.fromkeys((*self.all_of, *self.any_of, *self.none_of)))

    @property
    def primary(self) -> str:
        """用于显示/消息的主标签。"""
        return (self.all_of or self.any_of or self.none_of or ("?",))[0]

    def matches(self, detections: Mapping[str, Any], *, require_confirmed: bool = True) -> bool:
        """这一帧条件是否成立。detections 是 label → Detection 的映射。"""

        if self.always:
            return True

        def hit(label: str) -> bool:
            detection = detections.get(label)
            if detection is None:
                return False
            if require_confirmed and getattr(detection, "state", "confirmed") != "confirmed":
                return False
            return float(getattr(detection, "score", 0.0)) >= self.min_score

        if any(hit(label) for label in self.none_of):
            return False
        if self.all_of and not all(hit(label) for label in self.all_of):
            return False
        # any_of 为空表示"不要求任何标签"；只有 none_of 的条件到这里就算成立
        return not any(label for label in self.any_of) or any(hit(label) for label in self.any_of)

    def describe(self) -> str:
        if self.always:
            text = "无条件（进节点就做）"
            if self.within_ms:
                text += f"（限时 {self.within_ms}ms）"
            return text
        parts: list[str] = []
        if self.all_of:
            parts.append(" 且 ".join(self.all_of))
        if self.any_of:
            parts.append("(" + " 或 ".join(self.any_of) + ")")
        if self.none_of:
            parts.append("非 " + "/".join(self.none_of))
        text = " ".join(parts) if parts else "无条件"
        if self.min_score:
            text += f" ≥{self.min_score:.2f}"
        if self.within_ms:
            text += f"（限时 {self.within_ms}ms）"
        return text


@dataclass
class ConditionTimer:
    """限时等待的计时状态（每个边一份，随节点进入重置）。"""

    armed_at: dict[str, float] = field(default_factory=dict)
    timed_out: set[str] = field(default_factory=set)
    # 进入节点的时间：限时等待从这里开始算，而不是"这一帧第一次检查"时
    node_armed: dict[str, float] = field(default_factory=dict)

    def arm(self, node_id: str | None, now: float) -> None:
        """进入节点：给该节点的所有边重新计时。"""
        if node_id:
            self.node_armed[node_id] = now
        for key in list(self.armed_at):
            if key.startswith(f"{node_id}:"):
                del self.armed_at[key]
        self.timed_out = {item for item in self.timed_out if not item.startswith(f"{node_id}:")}

    def check(self, node_id: str | None, edge_id: str, within_ms: int, now: float) -> str:
        """返回 ``ok`` / ``wait`` / ``timeout``。"""
        if within_ms <= 0:
            return "ok"
        key = f"{node_id}:{edge_id}"
        started = self.armed_at.setdefault(key, self.node_armed.get(node_id or "", now))
        if now - started >= within_ms / 1000.0:
            self.timed_out.add(key)
            return "timeout"
        return "wait"


def _as_ms(value: object) -> int:
    if not isinstance(value, (int, float)):
        return 0
    return int(value)
