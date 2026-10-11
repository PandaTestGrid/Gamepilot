/**
 * 状态图的节点卡片（从 GraphPane 拆出来：它已经长到 140 行，值得单独一个文件 + 单独测样式）。
 *
 * 视觉状态（设计语言：层次只靠"底色 + 1px 描边"，不用阴影）：
 *   默认      border-line / bg-panel
 *   悬停      border 提亮到 brand 55% + 底色抬一级 —— 以前只有 grab 光标，
 *             鼠标放上去没有任何变化，用户直接反馈"看着像 bug"
 *   拖拽中    border-brand + bg-raised（规则在 graph.css 的 `.dragging`）
 *   选中      border-brand + bg-active（正在下方编辑器里编辑的就是它，并摊开引脚）
 *   当前节点  运行中停在这个界面 → border-brand 实线；pending 目标节点虚线
 *
 * 节点上的操作：
 *   - 双击就地改名（最常用的一次编辑，不该每次都跑到下面的面板）
 *   - 选中/当前时摊开"引脚"：这一步的参数是字面量还是变量，一眼看出、点一下切换
 */
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { type ReactNode, useState } from 'react';

import { TemplateMini } from '@/features/recognizers/TemplateThumb';
import { PIN_KEYS, togglePin } from '@/lib/param-vars';
import type { ActionPin } from '@/lib/action-pins';
import { toActionPayload } from '@/lib/graph-adapter';
import { cn } from '@/lib/utils';
import { useGraphStore } from '@/stores/graph.store';
import type { EdgeAction } from '@/types';

export interface StateNodeData extends Record<string, unknown> {
  label: string;
  sub: string;
  deviceId: string;
  /** 这个界面靠哪些模板认出来（有截图的才列）——画布上直接画缩略图 */
  enterTemplates?: readonly string[];
  /** 图里所有有截图的模板（节点上就地挂/摘识别器时用） */
  allTemplates?: readonly string[];
  /** 这个界面的出口操作（选中时摊开成"引脚"） */
  pins: ReadonlyArray<{
    key: string;
    title: string;
    action: EdgeAction;
    /** 这一步点的是哪个模板（有截图就在画布上给一张） */
    template?: string;
    pins: readonly ActionPin[];
  }>;
  expanded?: boolean;
  visits: number;
  active: boolean;
  pending: boolean;
}

export type StateNodeType = Node<StateNodeData, 'state'>;

export function StateNode({ data }: NodeProps<StateNodeType>): ReactNode {
  // 选中（或状态机停在这）时摊开这个界面的操作参数 —— 蓝图里的"引脚"，
  // 变量引用会高亮：一眼看出哪一步的参数是"活的"
  const showPins = (data.active || data.expanded) && data.pins.length > 0;
  const setVariables = useGraphStore((state) => state.setVariables);
  const saveEdge = useGraphStore((state) => state.saveEdge);
  /*
   * ⚠️ selector 里**不能**写 `?? []`：那样每次 getSnapshot 都返回新数组，
   * useSyncExternalStore 会认为状态一直在变 → 无限重渲染（"Maximum update depth exceeded"，
   * 图还没加载完时就会撞上）。先取稳定的 graph 对象，空值在组件里兜。
   */
  const graphVariables = useGraphStore((state) => state.graphs[String(data.deviceId)])?.variables ?? [];
  // 双击就地改名：这是最常用的一次编辑，不该每次都跑到下面的面板
  const updateNode = useGraphStore((state) => state.updateNode);
  // 就地改"进入识别器"与加操作（不用每次都跑到下面的详情面板）
  const enterLabels = useGraphStore(
    (state) => state.graphs[String(data.deviceId)]?.nodes.find((node) => node.id === data.sub)?.enter,
  );
  const addEdge = useGraphStore((state) => state.connectNodes);
  const selectEdge = useGraphStore((state) => state.selectEdge);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.label);

  const commit = (): void => {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== data.label) {
      // 节点 id 放在 data.sub 里（data 上没有 id 字段）：写成 data.id 会传成 "undefined"，改名静默失效
      void updateNode(String(data.deviceId), data.sub, { name });
    } else {
      setDraft(data.label);
    }
  };

  return (
    <div
      // data-testid：单测直接拿整张卡片断言描边/底色（比从文字往上找稳妥）
      data-testid="state-node"
      className={cn(
        // group：悬停卡片时，连线圆点跟着变亮（不然 10px 的点很难瞄准）
        'group relative w-[132px] rounded-sm border bg-panel px-2 py-1',
        // 悬停：描边提亮 + 底色抬一级（以前只有 grab 光标，鼠标放上去毫无变化）
        'transition-colors duration-120 hover:border-brand/60 hover:bg-raised',
        // 拖拽中（xyflow 给包裹层加 .dragging）：描边点亮，和"按住了"对上
        '[.dragging_&]:border-brand [.dragging_&]:bg-raised',
        data.active || data.expanded ? 'border-brand' : 'border-line',
        // 正在下方编辑器里编辑的节点：底色再抬一级（列表/标签也用 bg-active 表示"选中"）
        data.expanded && 'bg-active',
        data.pending && 'border-dashed',
      )}
      onDoubleClick={() => {
        setDraft(data.label);
        setEditing(true);
      }}
      title="双击改名"
    >
      {/* 圆点做大一点（原来 6px，很难抓住），并加一圈描边方便对准 */}
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2.5 !border-2 !border-canvas !bg-idle group-hover:!bg-brand"
      />
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit();
            }
            if (event.key === 'Escape') {
              setDraft(data.label);
              setEditing(false);
            }
            event.stopPropagation();
          }}
          className="w-full rounded-sm border border-brand bg-canvas px-1 text-body text-fg"
        />
      ) : (
        <div className="truncate text-body">{data.label}</div>
      )}
      <div className="flex items-center gap-1 text-badge text-faint">
        {/* 这个界面靠哪些模板认出来：画布上直接给截图，一眼看出"主界面长这样" */}
        {(data.enterTemplates ?? []).map((label) => (
          <TemplateMini key={label} label={label} size={20} />
        ))}
        <span className="truncate">
          {data.sub} · {data.visits} 次
        </span>
      </div>

      {/* 选中的节点：就地改配置 —— 挂/摘"进入识别器"、加一步操作 */}
      {data.expanded && (
        <div className="mt-1 flex flex-col gap-0.5 border-t border-line/60 pt-1">
          <div className="flex flex-wrap items-center gap-0.5">
            <span className="text-badge text-faint">认得这个界面：</span>
            {(data.allTemplates ?? []).map((label) => {
              const on = (enterLabels ?? []).includes(label);
              return (
                <button
                  key={label}
                  type="button"
                  title={on ? `摘掉 ${label}（不再用它认这个界面）` : `挂上 ${label}（命中就认为在这个界面）`}
                  onClick={(event) => {
                    event.stopPropagation();
                    const next = on
                      ? (enterLabels ?? []).filter((item) => item !== label)
                      : [...(enterLabels ?? []), label];
                    void updateNode(String(data.deviceId), data.sub, { enter: next });
                  }}
                  className={cn(
                    'flex items-center gap-0.5 rounded-sm border px-0.5 text-badge',
                    on ? 'border-confirmed text-confirmed' : 'border-line text-faint hover:text-fg',
                  )}
                >
                  <TemplateMini label={label} size={14} />
                  {label}
                </button>
              );
            })}
            {(data.allTemplates ?? []).length === 0 && (
              <span className="text-badge text-faint">（还没有模板：先去画面栏框选录制）</span>
            )}
          </div>
          <button
            type="button"
            title="从这一步加一个动作（原地动作：不切界面）；加完在下方详情里改参数"
            onClick={(event) => {
              event.stopPropagation();
              void addEdge(String(data.deviceId), data.sub, data.sub).then(() => {
                const edges = useGraphStore.getState().graphs[String(data.deviceId)]?.edges ?? [];
                const created = edges.filter((edge) => edge.from === data.sub).at(-1);
                if (created) {
                  selectEdge(created.id);
                }
              });
            }}
            className="self-start rounded-sm border border-line px-1 text-badge text-dim hover:bg-raised hover:text-fg"
          >
            + 操作
          </button>
        </div>
      )}

      {showPins &&
        data.pins.map((item) => (
          <div key={item.key} className="mt-0.5 flex flex-wrap items-center gap-0.5">
            {/* 这一步点的是哪个图标：画布上直接给缩略图，不用去翻识别器面板 */}
            {item.template && <TemplateMini label={item.template} size={18} />}
            <span className="text-badge text-dim">{item.title}</span>
            {item.pins.map((pin) => (
              <button
                key={`${item.key}-${pin.label}`}
                type="button"
                onClick={(event) => {
                  // 点引脚：字面量 ↔ 变量（"这一步的参数是活的"）
                  event.stopPropagation();
                  const key = PIN_KEYS[pin.label as keyof typeof PIN_KEYS];
                  if (!key) {
                    return;
                  }
                  void (async () => {
                    const result = togglePin(item.action, key, {
                      variables: graphVariables,
                      name: String(data.sub ?? '步骤'),
                    });
                    if (Object.keys(result.variables).length > 0) {
                      const merged: Record<string, { type: string; value: string | number | boolean }> = {};
                      for (const item of graphVariables) {
                        merged[item.name] = { type: item.type, value: item.value };
                      }
                      for (const [name, spec] of Object.entries(result.variables)) {
                        merged[name] = { type: spec.type, value: spec.value };
                      }
                      await setVariables(String(data.deviceId), merged);
                    }
                    await saveEdge(String(data.deviceId), item.key, {
                      action: toActionPayload(result.action),
                    });
                  })();
                }}
                className={cn(
                  'rounded-sm border px-0.5 text-badge',
                  pin.isVar ? 'border-brand text-brand' : 'border-line text-faint',
                  'hover:bg-raised',
                )}
                title={`${pin.label} = ${pin.value}${pin.isVar ? '（变量）' : ''}｜点一下切换：写死 ↔ 变量`}
              >
                {pin.label}:{pin.value}
              </button>
            ))}
          </div>
        ))}
      <Handle
        type="source"
        position={Position.Right}
        className="!size-2.5 !border-2 !border-canvas !bg-idle group-hover:!bg-brand"
      />
    </div>
  );
}
