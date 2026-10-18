# GamePilot — 常用命令一键入口（需已安装 make、Node≥20、pnpm、Rust、uv）
# 用法：make run（首次/全量）或 make start（已装依赖时）

.PHONY: help install engine deps start dev web build check test clean

.DEFAULT_GOAL := help

PNPM ?= pnpm
UV   ?= uv

help:
	@echo GamePilot Makefile
	@echo.
	@echo   make run     安装前端+引擎依赖并启动桌面开发态（推荐首次）
	@echo   make start   启动桌面 App：Tauri + Vite + Python 引擎
	@echo   make dev     仅前端 Vite（浏览器预览，无 RPC）
	@echo   make deps    仅安装依赖（pnpm install + uv sync）
	@echo   make install 仅 pnpm install
	@echo   make engine  仅 engine/.venv（uv sync）
	@echo   make build   构建桌面端
	@echo   make check   全量检查（format/lint/test/引擎）
	@echo   make test    运行测试
	@echo.

install:
	$(PNPM) install

engine:
	cd engine && $(UV) sync

deps: install engine

run: deps start

start:
	$(PNPM) tauri dev

dev:
	$(PNPM) dev

web: dev

build:
	$(PNPM) build

check:
	$(PNPM) check

test:
	$(PNPM) test

clean:
	-$(PNPM) exec rimraf node_modules apps/desktop/node_modules 2>/dev/null || true
	-rm -rf engine/.venv
