/**
 * 识别器的"数据流"：谁在用它。
 *
 * 为什么需要：模板被节点/边引用着时，引擎会**拒绝删除**（直接删会让脚本引用不存在的东西）。
 * 但"点一下才知道删不掉"太晚了 —— 用户还得自己回去翻是哪个界面引用的。
 * 所以面板上把它先算出来：这一行被哪些界面 / 哪些边引用，
 * 删除按钮据此**置灰并说明原因**（见 `features/recognizers/RecognizerPane.tsx`）。
 *
 * 规则必须和引擎 `session.py: remove_recognizer` 保持一致，否则会出现
 * "界面说能删、引擎说不能删"。唯一对不齐的是动作里的 `$score` 引用：
 * 界面模型里看不到它，所以这里只是**预判**，最终仍然以引擎为准。
 *
 * 纯函数，可单测。
 */
import type { GraphData } from '@/types';

export interface RecognizerNodeUser {
  readonly id: string;
  readonly name: string;
}

export interface RecognizerEdgeUser {
  readonly id: string;
  /** 这条边拿它做什么：判断条件 / 动作目标（可能同时是两者） */
  readonly reasons: readonly string[];
}

export interface RecognizerUsage {
  readonly nodes: readonly RecognizerNodeUser[];
  readonly edges: readonly RecognizerEdgeUser[];
  /** 引用处数（界面 + 边）。0 = 没人用，删掉不影响脚本 */
  readonly total: number;
}

const UNUSED: RecognizerUsage = { nodes: [], edges: [], total: 0 };

/** 节点在提示里的称呼：**重名时带上 id**（编辑过两个都叫「新界面」的节点，光写名字等于没说）。 */
export function nodeRef(node: RecognizerNodeUser): string {
  const name = node.name || node.id;
  return name === node.id ? name : `${name}（${node.id}）`;
}

/**
 * 收集一个识别器标签被哪些界面 / 边引用。
 *
 * 注意 `when` 和 `condition.allOf` 常常是**同一条判断条件**（界面模型在没有显式 condition 时
 * 会用 `when` 合成 all_of，见 `lib/graph-adapter.ts`），所以按"边"去重、把原因合并，
 * 否则一条边会被数成两处引用。
 */
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
  return { nodes, edges, total: nodes.length + edges.length };
}

/** 面板上那行小字：被谁用着（最多列 3 处，多的用"等 N 处"收尾）。 */
export function describeRecognizerUsage(usage: RecognizerUsage): string {
  if (usage.total === 0) {
    return '还没有被引用 · 删掉不影响脚本';
  }
  const parts = [
    ...usage.nodes.map((node) => nodeRef(node)),
    ...usage.edges.map((edge) => `${edge.id}（${edge.reasons.join(' + ')}）`),
  ];
  const head = parts.slice(0, 3).join('、');
  return `正在被引用：${head}${parts.length > 3 ? ` 等 ${parts.length} 处` : ''}`;
}
