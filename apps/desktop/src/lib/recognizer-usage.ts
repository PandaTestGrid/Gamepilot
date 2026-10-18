/**
 * 识别器的"数据流"：谁在用它。
 *
 * 步骤链工作流：引用来自 `flow.steps` 里的 `params.rec`（等待/条件/点击识别器）。
 * 旧状态图：节点的 enter、边的 when/condition/动作 target。
 */
import { condRecognizerLabels } from '@/features/graph/flow/flow-cond-params';
import { flowStepTitle } from '@/features/graph/flow/flow-step-meta';
import type { FlowStep, GraphData } from '@/types';

export interface RecognizerNodeUser {
  readonly id: string;
  readonly name: string;
}

export interface RecognizerEdgeUser {
  readonly id: string;
  readonly reasons: readonly string[];
}

export interface RecognizerFlowStepUser {
  readonly id: string;
  readonly label: string;
}

export interface RecognizerUsage {
  readonly nodes: readonly RecognizerNodeUser[];
  readonly edges: readonly RecognizerEdgeUser[];
  readonly flowSteps: readonly RecognizerFlowStepUser[];
  readonly total: number;
}

const UNUSED: RecognizerUsage = { nodes: [], edges: [], flowSteps: [], total: 0 };

export function nodeRef(node: RecognizerNodeUser): string {
  const name = node.name || node.id;
  return name === node.id ? name : `${name}（${node.id}）`;
}

function stepUsesRecognizer(step: FlowStep, label: string): boolean {
  const params = step.params ?? {};
  if (params.rec === label) {
    return true;
  }
  if (step.type === 'cond') {
    return condRecognizerLabels(params).includes(label);
  }
  return false;
}

export function collectRecognizerUsage(graph: GraphData | undefined, label: string): RecognizerUsage {
  if (!graph || !label) {
    return UNUSED;
  }
  const nodes = (graph.nodes ?? [])
    .filter((node) => node.enter.includes(label))
    .map((node) => ({ id: node.id, name: node.name }));

  const edges: RecognizerEdgeUser[] = [];
  for (const edge of graph.edges ?? []) {
    const reasons = new Set<string>();
    const condition = edge.condition;
    if (
      edge.when === label ||
      condition.allOf.includes(label) ||
      condition.anyOf.includes(label) ||
      condition.noneOf.includes(label)
    ) {
      reasons.add('判断条件');
    }
    if (edge.actionSpec.target === label || edge.actionSpec.toTarget === label) {
      reasons.add('动作目标');
    }
    if (reasons.size > 0) {
      edges.push({ id: edge.id, reasons: [...reasons] });
    }
  }

  const flowSteps = (graph.flow?.steps ?? [])
    .filter((step) => stepUsesRecognizer(step, label))
    .map((step) => ({ id: step.id, label: flowStepTitle(step) }));

  return { nodes, edges, flowSteps, total: nodes.length + edges.length + flowSteps.length };
}

export function describeRecognizerUsage(usage: RecognizerUsage): string {
  if (usage.total === 0) {
    return '还没有被引用 · 删掉不影响脚本';
  }
  const parts = [
    ...usage.flowSteps.map((step) => `模块 · ${step.label}（${step.id}）`),
    ...usage.nodes.map((node) => `界面 · ${nodeRef(node)}`),
    ...usage.edges.map((edge) => `${edge.id}（${edge.reasons.join(' + ')}）`),
  ];
  const head = parts.slice(0, 3).join('、');
  return `正在被引用：${head}${parts.length > 3 ? ` 等 ${parts.length} 处` : ''}`;
}
