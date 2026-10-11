/**
 * 状态图 → **线性脚本步骤**。
 *
 * 图是给状态机看的（节点=界面、边=操作），但人读脚本时想要的是"第一步做什么、
 * 第二步做什么"。这一层把图按**执行顺序**展开成步骤列表，和图双向联动：
 *
 * - 点步骤 → 选中对应的节点/边（图上高亮、底部打开编辑器）
 * - 图上选中 → 步骤列表高亮并滚动到那一步
 *
 * 顺序规则（和引擎一致）：从"没有入边的起点"开始，每个界面按 **优先级从高到低**
 * 展开它的出口操作，已经展开过的界面不重复展开；走不到的节点单独列在最后并标注。
 */
import { describeAction, describeCondition } from '@/lib/graph-logic';
import type { GraphData } from '@/types';

export interface ScriptStep {
  readonly kind: 'node' | 'edge';
  readonly id: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  /** 缩进层级：界面 0，它下面的操作 1 */
  readonly depth: number;
  readonly title: string;
  readonly detail: string;
  /** 会不会真的被执行（从起点走不到的就是 false） */
  readonly reachable: boolean;
}

/** 从哪个界面开始跑：没有入边的节点；都是环的话取第一个。 */
export function findStartNode(graph: GraphData | undefined): string | null {
  if (!graph || graph.nodes.length === 0) {
    return null;
  }
  const withIncoming = new Set((graph.edges ?? []).map((edge) => edge.to).filter(Boolean) as string[]);
  const roots = graph.nodes.filter((node) => !withIncoming.has(node.id));
  const start = roots[0] ?? graph.nodes[0];
  return start ? start.id : null;
}

export function buildScriptSteps(graph: GraphData | undefined): ScriptStep[] {
  if (!graph || graph.nodes.length === 0) {
    return [];
  }
  const steps: ScriptStep[] = [];
  const expanded = new Set<string>();
  const queue: string[] = [];
  const start = findStartNode(graph);
  if (start) {
    queue.push(start);
  }

  while (queue.length > 0) {
    const nodeId = queue.shift() as string;
    if (expanded.has(nodeId)) {
      continue;
    }
    expanded.add(nodeId);
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node) {
      continue;
    }
    steps.push({
      kind: 'node',
      id: node.id,
      nodeId: node.id,
      depth: 0,
      title: `界面『${node.name}』`,
      detail:
        node.enter.length > 0
          ? `识别：${node.enter.map((label) => `『${label}』`).join(' 或 ')}`
          : '还没有识别器（框选一个元素给它，状态机才认得出来）',
      reachable: true,
    });

    // 出口操作：优先级高的先试（和引擎的 _guard_ok 顺序一致）
    const outgoing = (graph.edges ?? [])
      .filter((edge) => edge.from === node.id)
      .slice()
      .sort((a, b) => b.priority - a.priority);
    for (const edge of outgoing) {
      const target = edge.to ? graph.nodes.find((item) => item.id === edge.to) : undefined;
      steps.push({
        kind: 'edge',
        id: edge.id,
        edgeId: edge.id,
        nodeId: node.id,
        depth: 1,
        title: `${edge.kind === 'recovery' ? '⚡ ' : ''}${describeAction(edge.actionSpec)}`,
        detail: `${describeCondition(edge)}${target ? ` → 进入『${target.name}』` : '（不切界面）'}`,
        reachable: true,
      });
      if (edge.to && !expanded.has(edge.to)) {
        queue.push(edge.to);
      }
    }
  }

  // 从起点走不到的界面也列出来（标灰），否则用户会以为它们不存在
  for (const node of graph.nodes) {
    if (expanded.has(node.id)) {
      continue;
    }
    steps.push({
      kind: 'node',
      id: node.id,
      nodeId: node.id,
      depth: 0,
      title: `界面『${node.name}』`,
      detail: '从起点走不到这里（检查连线，或者它本来就是独立入口）',
      reachable: false,
    });
    for (const edge of (graph.edges ?? []).filter((item) => item.from === node.id)) {
      steps.push({
        kind: 'edge',
        id: edge.id,
        edgeId: edge.id,
        nodeId: node.id,
        depth: 1,
        title: describeAction(edge.actionSpec),
        detail: describeCondition(edge),
        reachable: false,
      });
    }
  }

  return steps;
}

/** 选中态：图上选中的是节点还是边。 */
export function selectedStepId(selectedNodeId: string | null, selectedEdgeId: string | null): string | null {
  return selectedEdgeId ?? selectedNodeId ?? null;
}
