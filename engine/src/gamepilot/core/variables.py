"""变量（"黑板"）与参数引用。

蓝图里最有用的东西不是连线本身，而是**把值抽出来共享**：一个坐标、一个阈值、
一个重试次数，写在变量里，改一处全脚本生效。

`graph.json` 增量长这样（老脚本不带这段，一样能跑）：

    "variables": {
      "点击X":   {"type": "number", "value": 0.5},
      "目标模板": {"type": "key",    "value": "icon"},
      "循环次数": {"type": "number", "value": 0}
    }

动作参数里可以把字面量换成引用：

    {"type": "click", "x": {"$var": "点击X"}, "y": 0.8}
    {"type": "set", "name": "循环次数", "value": {"$expr": "循环次数 + 1"}}

- `$var`  取变量当前值
- `$expr` 对变量做简单算术/比较（只支持 + - * / 和比较，不引入表达式语言）
- 求值发生在**执行那一刻**，所以变量的运行期取值不会影响脚本文件的干净

变量分两层：**默认值**（存在 graph.json 里）和**运行时值**（跑起来后被 `set` 改），
每次 run.start 会把运行期值重置成默认值。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("gamepilot.variables")

VARIABLE_TYPES: tuple[str, ...] = ("number", "text", "key")

# 表达式只允许：变量名、数字、括号、四则运算、比较、字符串字面量
_EXPR_ALLOWED = re.compile(r"^[\w\u4e00-\u9fff\s+\-*/().<>=!&|'\"]+$")

VarValue = float | int | str | bool


@dataclass
class Variable:
    name: str
    type: str = "number"
    value: VarValue = 0

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, "value": self.value}

    @property
    def num(self) -> float:
        try:
            return float(self.value)
        except (TypeError, ValueError):
            return 0.0


def parse_variables(payload: object) -> dict[str, Variable]:
    """从 graph.json 的 variables 段解析；容错，坏数据跳过并记日志。"""
    out: dict[str, Variable] = {}
    if not isinstance(payload, dict):
        return out
    for name, spec in payload.items():
        key = str(name).strip()
        if not key:
            continue
        if isinstance(spec, dict):
            kind = str(spec.get("type", "number"))
            value = spec.get("value", 0)
        else:  # 允许写 {"点击X": 0.5} 这种简写
            kind, value = "number", spec
        if kind not in VARIABLE_TYPES:
            logger.warning("变量 %s 的类型不认识: %s（按 number 处理）", key, kind)
            kind = "number"
        out[key] = Variable(
            name=key, type=kind, value=value if isinstance(value, (int, float, str, bool)) else str(value)
        )
    return out


class VariableStore:
    """运行期变量值（默认值来自脚本，跑起来后可被 set 改）。"""

    def __init__(self, defaults: dict[str, Variable] | None = None) -> None:
        self._defaults: dict[str, Variable] = dict(defaults or {})
        self._values: dict[str, VarValue] = {name: var.value for name, var in self._defaults.items()}

    @property
    def defaults(self) -> dict[str, Variable]:
        return self._defaults

    def reset(self, defaults: dict[str, Variable] | None = None) -> None:
        if defaults is not None:
            self._defaults = dict(defaults)
            self._values = {name: var.value for name, var in self._defaults.items()}
        else:
            self._values = {name: var.value for name, var in self._defaults.items()}

    def get(self, name: str) -> VarValue | None:
        return self._values.get(name)

    def set(self, name: str, value: VarValue) -> None:
        """赋值：类型按默认值的类型走（数字变量存数字），没定义过的变量直接新增。"""
        spec = self._defaults.get(name)
        if spec is None:
            self._defaults[name] = Variable(
                name=name, type="number" if isinstance(value, (int, float)) else "text", value=value
            )
        elif spec.type == "number":
            try:
                numeric: VarValue = float(str(value))
            except (TypeError, ValueError):
                logger.warning("变量 %s 是数字类型，收到 %r，忽略", name, value)
                return
            self._values[name] = numeric
            return
        self._values[name] = value

    def snapshot(self) -> dict[str, VarValue]:
        return dict(self._values)


def evaluate_expr(text: str, store: VariableStore) -> VarValue:
    """极小的表达式求值：变量名/数字/字符串 + 四则运算 + 比较。

    刻意不做完整表达式语言（不做函数调用、属性访问、下标），避免变成"半个 Python"。
    """
    expr = text.strip()
    if not expr:
        return 0
    if not _EXPR_ALLOWED.match(expr):
        raise ValueError(f"表达式里有不支持的字符: {text}")
    names = {name: store.get(name) for name in store.defaults}
    # 把变量名换成 Python 名字能用的占位（支持中文变量名）
    mapping: dict[str, VarValue] = {}
    translated = expr
    for index, (name, value) in enumerate(sorted(names.items(), key=lambda item: -len(item[0]))):
        token = f"__v{index}__"
        if name in translated:
            translated = translated.replace(name, token)
            mapping[token] = value if value is not None else 0
    try:
        result = eval(translated, {"__builtins__": {}}, dict(mapping))
    except Exception as exc:  # 表达式写错不该让状态机崩
        raise ValueError(f"表达式求值失败: {text}（{exc}）") from exc
    if isinstance(result, bool):
        return result
    if isinstance(result, (int, float)):
        return float(result)
    return str(result)


def resolve_value(value: object, store: VariableStore, scores: dict[str, float] | None = None) -> object:
    """把一个参数值求出来：`$var` / `$expr` / `$score` / 字面量原样返回。

    `$score` 是"数据源"：把某个识别器**当前这一帧的相似度**当参数用
    （例：把识别得分接到条件阈值上做调试）。
    """
    if isinstance(value, dict):
        if "$score" in value:
            label = str(value["$score"])
            return float((scores or {}).get(label, 0.0))
        if "$var" in value:
            name = str(value["$var"])
            found = store.get(name)
            if found is None:
                raise ValueError(f"变量未定义: {name}")
            return found
        if "$expr" in value:
            return evaluate_expr(str(value["$expr"]), store)
        return {key: resolve_value(item, store) for key, item in value.items()}
    return value


def resolve_spec(spec: dict[str, Any], store: VariableStore, scores: dict[str, float] | None = None) -> dict[str, Any]:
    """动作参数整体求值（把里面的引用换成当前值）。"""
    return {key: resolve_value(value, store, scores) for key, value in spec.items()}


@dataclass
class VariableRefs:
    """从动作里收集引用，供保存时校验。"""

    vars: set[str] = field(default_factory=set)

    @classmethod
    def collect(cls, value: object) -> VariableRefs:
        refs = cls()
        refs._walk(value)
        return refs

    @staticmethod
    def collect_scores(value: object) -> set[str]:
        """收集动作里 `$score` 引用到的识别器标签。"""
        found: set[str] = set()

        def walk(node: object) -> None:
            if isinstance(node, dict):
                if "$score" in node:
                    found.add(str(node["$score"]))
                for item in node.values():
                    walk(item)
            elif isinstance(node, list):
                for item in node:
                    walk(item)

        walk(value)
        return found

    def _walk(self, value: object) -> None:
        if isinstance(value, dict):
            if "$var" in value:
                self.vars.add(str(value["$var"]))
            for item in value.values():
                self._walk(item)
        elif isinstance(value, list):
            for item in value:
                self._walk(item)


SET_ACTION = "set"
