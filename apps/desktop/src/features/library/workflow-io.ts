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

export function pickWorkflowJsonFile(): Promise<string | null> {
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
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsText(file, 'utf-8');
    };
    input.click();
  });
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
