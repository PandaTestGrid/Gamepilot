/**
 * 起一个**真实引擎子进程**并按 JSON-RPC 说话（测试用的小客户端）。
 *
 * `stores/session.engine.test.ts` 里那份还要假冒 Rust 桥（帧缓存、事件推送），
 * 这份只做"请求 → 响应"，给不关心事件流的端到端测试用（工作区 §4.4 那套）。
 *
 * 环境变量（契约 v3 §1）：
 *   GAMEPILOT_CONFIG_DIR    → 配置目录（**必须指向临时目录**，否则会读写用户真实的 config.json）
 *   GAMEPILOT_WORKSPACE_DIR → 当前工作区（给了就跳过配置读写）
 *   GAMEPILOT_PROJECT_DIR   → 当前脚本目录
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** 仓库内 venv 的解释器（和 Rust 桥 `resolve_engine_command` 同一套规则）。 */
export function enginePython(engineDir: string): string {
  const candidate =
    process.platform === 'win32'
      ? path.join(engineDir, '.venv', 'Scripts', 'python.exe')
      : path.join(engineDir, '.venv', 'bin', 'python');
  if (!existsSync(candidate)) {
    throw new Error(`找不到引擎解释器（先 cd engine && uv sync）: ${candidate}`);
  }
  return candidate;
}

export interface EngineOptions {
  /** 配置目录（必填：测试里一律指向临时目录） */
  readonly configDir: string;
  /** 当前工作区（可选；给了就跳过配置读写） */
  readonly workspaceDir?: string;
  /** 当前脚本目录（可选） */
  readonly projectDir?: string;
}

export class EngineProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(options: EngineOptions) {
    const engineDir = path.resolve(process.cwd(), '..', '..', 'engine');
    const env: NodeJS.ProcessEnv = { ...process.env, GAMEPILOT_LOG_LEVEL: 'ERROR' };
    // 别把父进程里可能存在的逃生口变量带进来（否则用例之间会互相影响）
    delete env.GAMEPILOT_WORKSPACE_DIR;
    delete env.GAMEPILOT_PROJECT_DIR;
    env.GAMEPILOT_CONFIG_DIR = options.configDir;
    if (options.workspaceDir) {
      env.GAMEPILOT_WORKSPACE_DIR = options.workspaceDir;
    }
    if (options.projectDir) {
      env.GAMEPILOT_PROJECT_DIR = options.projectDir;
    }

    this.child = spawn(enginePython(engineDir), ['-m', 'gamepilot.rpc'], {
      cwd: engineDir,
      env,
    });

    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id !== 'number') {
        return; // 通知（engine.ready / engine.log…）：这份客户端不关心
      }
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!waiter) {
        return;
      }
      if (message.error) {
        waiter.reject(new Error(JSON.stringify(message.error)));
      } else {
        waiter.resolve(message.result);
      }
    });
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  stop(): void {
    this.child.kill();
  }
}
