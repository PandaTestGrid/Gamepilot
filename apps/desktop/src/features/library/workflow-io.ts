/**
 * 工作流 graph.json 导出 / 导入（Automa 式 JSON 备份）。
 */
import type { GraphPayload } from '@/lib/rpc';

export function downloadWorkflowJson(filename: string, graph: GraphPayload): void {
  const blob = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.endsWith('.json') ? filename : `${filename}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export interface PickedWorkflowJson {
  /** 用户选的文件名（导入时用它预填工作流名） */
  readonly name: string;
  readonly text: string;
}

/** 选一个 graph.json：同时带回文件名，导入新工作流时能给出一个像样的默认名字。 */
export function pickWorkflowJsonFileNamed(): Promise<PickedWorkflowJson | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () =>
        resolve(typeof reader.result === 'string' ? { name: file.name, text: reader.result } : null);
      reader.onerror = () => resolve(null);
      reader.readAsText(file, 'utf-8');
    };
    input.click();
  });
}

export function pickWorkflowJsonFile(): Promise<string | null> {
  return pickWorkflowJsonFileNamed().then((picked) => picked?.text ?? null);
}

/** `斗技.json` → `斗技`（导入时预填；真正校验仍由 WorkflowNameForm/引擎负责）。 */
export function suggestedWorkflowName(fileName: string): string {
  const base = fileName
    .replace(/^.*[\\/]/, '')
    .replace(/\.json$/i, '')
    .trim();
  return base || '导入的工作流';
}

export function parseWorkflowJson(text: string): GraphPayload {
  const data = JSON.parse(text) as unknown;
  if (!data || typeof data !== 'object') {
    throw new Error('不是合法的 JSON 对象');
  }
  const graph = data as Record<string, unknown>;
  if (!Array.isArray(graph.nodes) && !graph.flow) {
    throw new Error('缺少 nodes 或 flow 字段，不像 graph.json');
  }
  if (graph.flow !== undefined && typeof graph.flow !== 'object') {
    throw new Error('flow 必须是对象');
  }
  return graph as unknown as GraphPayload;
}
