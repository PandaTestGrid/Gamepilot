"""Explicit one-shot migration of legacy click modes; never used by runtime loading.

Usage: python -m gamepilot.migrate_click_modes WORKSPACE [WORKSPACE ...] [--apply]
The default is a read-only preview. Apply backs up exact original bytes and changes
only recognized flow.steps[*].params.by string tokens, preserving formatting.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .core.graph import Graph

LEGACY_MODES = {"识别器": "recognizer", "坐标": "coord", "随机范围": "region"}
# JSON strings, including escaped quotes/unicode. Only key:value string pairs match.
_STRING = r'"(?:[^"\\]|\\.)*"'
_STRING_PAIR = re.compile(rf"(?P<key>{_STRING})(?P<gap>\s*:\s*)(?P<value>{_STRING})")


@dataclass(frozen=True)
class Migration:
    path: Path
    original: bytes
    updated: bytes
    changes: int


def plan_migration(path: Path) -> Migration | None:
    """Plan a lossless token edit; unrelated/unknown values remain strict errors."""
    original = path.read_bytes()
    text = original.decode("utf-8-sig")
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError(f"工作流必须是 JSON 对象: {path}")
    flow = data.get("flow")
    steps = flow.get("steps", []) if isinstance(flow, dict) else []
    expected: Counter[str] = Counter()
    for step in steps:
        if not isinstance(step, dict):
            continue
        params = step.get("params")
        if not isinstance(params, dict):
            continue
        value = params.get("by")
        if isinstance(value, str) and value in LEGACY_MODES:
            expected[value] += 1
    if not expected:
        return None

    found: Counter[str] = Counter()
    replacements: list[tuple[int, int, str]] = []
    for match in _STRING_PAIR.finditer(text):
        if json.loads(match["key"]) != "by":
            continue
        old = json.loads(match["value"])
        if old in LEGACY_MODES:
            found[old] += 1
            replacements.append((*match.span("value"), json.dumps(LEGACY_MODES[old])))
    if found != expected:
        raise ValueError(f"发现步骤参数以外的旧 by 值，拒绝自动修改: {path}")
    updated = text
    for start, end, replacement in reversed(replacements):
        updated = updated[:start] + replacement + updated[end:]

    # Loading validates the candidate without Graph.save rewriting unrelated data.
    Graph.from_dict(json.loads(updated), base_dir=str(path.parent), path=str(path))
    bom = b"\xef\xbb\xbf" if original.startswith(b"\xef\xbb\xbf") else b""
    return Migration(path, original, bom + updated.encode("utf-8"), sum(expected.values()))


def apply_migration(plan: Migration, *, backup_original: bool = True) -> Path | None:
    """Replace verified bytes; backup is opt-out only for disposable debug data."""
    if plan.path.read_bytes() != plan.original:
        raise RuntimeError(f"文件已改变，请重新预览: {plan.path}")
    backup: Path | None = None
    if backup_original:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        backup = plan.path.with_name(f"graph.json.before-click-modes-{stamp}.bak")
        with backup.open("xb") as handle:
            handle.write(plan.original)
            handle.flush()
            os.fsync(handle.fileno())
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=plan.path.parent, prefix=".click-modes-", delete=False) as handle:
            temporary = handle.name
            handle.write(plan.updated)
            handle.flush()
            os.fsync(handle.fileno())
        if plan.path.read_bytes() != plan.original:
            raise RuntimeError(f"备份后文件已改变，未覆盖，请重新预览: {plan.path}")
        os.replace(temporary, plan.path)
        temporary = None
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
    return backup


def workspace_graphs(root: Path) -> list[Path]:
    """Only this workspace and its direct workflows; never recurse into backups."""
    root = root.resolve(strict=True)
    paths = [root / "graph.json"]
    paths.extend(
        child / "graph.json" for child in sorted(root.iterdir()) if child.is_dir() and not child.name.startswith(".")
    )
    return [path for path in paths if path.is_file()]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workspaces", nargs="+", type=Path)
    parser.add_argument("--apply", action="store_true", help="写入；默认只预览")
    parser.add_argument("--no-backup", action="store_true", help="不保留备份，仅用于可丢弃的调试数据")
    args = parser.parse_args()
    plans: list[Migration] = []
    seen: set[Path] = set()
    for root in args.workspaces:
        for path in workspace_graphs(root):
            path = path.resolve()
            if path in seen:
                continue
            seen.add(path)
            plan = plan_migration(path)
            if plan is not None:
                plans.append(plan)
    # Plan/validate every candidate first; no writes if any candidate is invalid.
    report: list[dict[str, Any]] = []
    for plan in plans:
        item: dict[str, Any] = {"path": str(plan.path), "changes": plan.changes}
        if args.apply:
            backup = apply_migration(plan, backup_original=not args.no_backup)
            item["backup"] = str(backup) if backup is not None else None
        report.append(item)
    print(
        json.dumps(
            {"applied": args.apply, "files": report, "changes": sum(p.changes for p in plans)},
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
