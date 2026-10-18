#!/usr/bin/env bash
# 最终验收：引擎 + 前端 + 契约卫生。
#
# 用法：bash scripts/verify-all.sh
# 退出码：0 = 全过；非 0 = 有项目没通过（明细见输出）。
#
# 这是 Lead 跑"最后一次全量验收"用的，不替代各侧自己的测试。

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILED=()
PASSED=()

section() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()   { PASSED+=("$1"); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAILED+=("$1"); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

# 跑一条命令，成功记 PASS、失败记 FAIL（输出照原样打印）
run() {
  local name="$1"; shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}

section "引擎"
cd "$ROOT/engine"
run "pytest（全量）" .venv/bin/python -m pytest -q
run "ruff check" .venv/bin/python -m ruff check .
run "ruff format --check" .venv/bin/python -m ruff format --check .
run "mypy" .venv/bin/python -m mypy
cd "$ROOT"

section "前端"
cd "$ROOT/apps/desktop"
run "vitest" node_modules/.bin/vitest run
run "tsc --noEmit" node_modules/.bin/tsc --noEmit
run "eslint" node_modules/.bin/eslint .
cd "$ROOT"

section "契约卫生（下线的方法名/文案不许复活）"
# 只看**源码**（ts/tsx/py）：README 这类散文里出现「默认项目」是解释历史，不算残留。
SRC=(apps/desktop/src engine/src)
DEAD='workspaceCreate|workspaceMkdir|workspaceRmdir|workspace\.rmdir|workspace\.migrate|project\.(list|create|rename|delete)|script\.(create|rename|delete|duplicate)|＋工作区|新建工作区'
if grep -rnE "$DEAD" --include='*.ts' --include='*.tsx' --include='*.py' "${SRC[@]}" 2>/dev/null; then
  bad "下线命名残留（见上）"
else
  ok "下线命名零命中"
fi

# window.prompt 在 Tauri webview 里弹不出来（踩过两次），必须零使用（只查真代码）
if grep -rn "window\.prompt" --include='*.ts' --include='*.tsx' apps/desktop/src 2>/dev/null; then
  bad "还在用 window.prompt（Tauri 里弹不出来）"
else
  ok "零 window.prompt"
fi

section "旧路径不许复活"
if grep -rnE "projects/default|engine/projects" --include='*.ts' --include='*.tsx' --include='*.py' "${SRC[@]}" 2>/dev/null; then
  bad "旧工程路径残留（见上）"
else
  ok "旧工程路径零命中"
fi

section "我的独立冒烟（真实引擎子进程核 v4 契约）"
run "smoke-rpc.py" engine/.venv/bin/python scripts/smoke-rpc.py

section "结果"
printf '  通过 %d 项，失败 %d 项\n' "${#PASSED[@]}" "${#FAILED[@]}"
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '  失败：\n'
  printf '    - %s\n' "${FAILED[@]}"
  exit 1
fi
printf '\n\033[32m全部通过\033[0m\n'
