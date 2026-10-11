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

import { GraphContextMenu } from '@/features/graph/GraphContextMenu';
import { TemplateMini } from '@/features/recognizers/TemplateThumb';
import { PIN_KEYS, togglePin } from '@/lib/param-vars';
import type { ActionPin } from '@/lib/action-pins';
import { toActionPayload } from '@/lib/graph-adapter';
import { actionRun as runAction } from '@/lib/rpc';
import { cn } from '@/lib/utils';
import { useEventStore } from '@/stores/event.store';
import { useGraphStore } from '@/stores/graph.store';
import { useUiStore } from '@/stores/ui.store';
import type { EdgeAction } from '@/types';

/**
 * 节点卡片尺寸档位（用户在画布头部切 小/中/大）。
 * 卡片宽度、字号、缩略图、引脚一起缩放 —— 只放大框不改字，等于没放大。
 */
const SIZES = {
  sm: {
    card: 'w-[132px] px-2 py-1',
    title: 'text-badge',
    meta: 'text-[10px]',
    thumb: 16,
    pin: 'text-[10px]',
  },
  md: { card: 'w-[168px] px-2 py-1', title: 'text-body', meta: 'text-badge', thumb: 20, pin: 'text-badge' },
  lg: {
    card: 'w-[220px] px-2.5 py-1.5',
    title: 'text-title',
    meta: 'text-body',
    thumb: 26,
    pin: 'text-body',
  },
} as const;

/**
 * "＋操作"菜单里的动作类型（对齐引擎 ActionSpec.type，见 docs/rpc.md）。
 * 参数和目标都在下方详情面板里绑 —— 菜单只负责"加哪一类"。
 */
const ACTION_KINDS = [
  { type: 'click', label: '点击', hint: '坐标/模板目标' },
  { type: 'long_press', label: '长按', hint: '' },
  { type: 'swipe', label: '滑动', hint: '起点→终点' },
  { type: 'wait', label: '等待', hint: '秒' },
  { type: 'key', label: '按键', hint: 'back/home 等' },
  { type: 'text', label: '输入文字', hint: '' },
  { type: 'set', label: '赋值', hint: '写变量' },
  { type: 'call', label: '调用子脚本', hint: '' },
] as const;

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
  const selectEdge = useGraphStore((state) => state.selectEdge);
  const removeEdge = useGraphStore((state) => state.removeEdge);
  const addStep = useGraphStore((state) => state.addStep);
  const selectNode = useGraphStore((state) => state.selectNode);
  /** ＋操作菜单的锚点（屏幕坐标）；null = 关闭 */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** 正在执行的那一步（按钮转圈用） */
  const [running, setRunning] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.label);
  const scale = useUiStore((state) => state.nodeScale);
  const size = SIZES[scale];
  const thumb = size.thumb;

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

  /** 建一步操作：建完立刻在下方详情里选中它，参数/条件在那边绑 */
  const createStep = (patch: {
    action?: Record<string, unknown>;
    when?: string;
    condition?: Record<string, unknown>;
  }): void => {
    void addStep(String(data.deviceId), data.sub, data.sub, patch).then((edgeId) => {
      if (edgeId) {
        selectEdge(edgeId);
      }
    });
  };

  /** 直接执行一步（引擎 action.run）：执行结果记进事件流，出问题能回看 */
  const runStep = (item: StateNodeData['pins'][number]): void => {
    setRunning(item.key);
    void runAction(String(data.deviceId), toActionPayload(item.action))
      .then((result) => {
        useEventStore.getState().append(String(data.deviceId), 'action_executed', {
          message: `立即执行：${result.described || item.title}`,
        });
      })
      .catch((error: unknown) => {
        useEventStore.getState().append(String(data.deviceId), 'error', {
          message: `执行失败：${error instanceof Error ? error.message : String(error)}`,
        });
      })
      .finally(() => setRunning(null));
  };

  return (
    <div
      // data-testid：单测直接拿整张卡片断言描边/底色（比从文字往上找稳妥）
      data-testid="state-node"
      // 运行态动效（graph.css）：当前节点呼吸、待确认目标闪烁
      data-run={data.active ? 'active' : data.pending ? 'pending' : undefined}
      className={cn(
        // group：悬停卡片时，连线圆点跟着变亮（不然 10px 的点很难瞄准）
        'group relative rounded-sm border bg-panel',
        size.card,
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
          className={cn('w-full rounded-sm border border-brand bg-canvas px-1 text-fg', size.title)}
        />
      ) : (
        <div className={cn('truncate', size.title)}>{data.label}</div>
      )}
      <div className={cn('flex items-center gap-1 text-faint', size.meta)}>
        {/* 这个界面靠哪些模板认出来：画布上直接给截图，一眼看出"主界面长这样" */}
        {(data.enterTemplates ?? []).map((label) => (
          <TemplateMini key={label} label={label} size={thumb} />
        ))}
        <span className="truncate">
          {data.sub} · {data.visits} 次
        </span>
      </div>

      {/* 选中的节点：就地改配置 —— 挂/摘"进入识别器"、加一步操作 */}
      {data.expanded && (
        <div className="mt-1 flex flex-col gap-0.5 border-t border-line/60 pt-1">
          <div className="flex flex-wrap items-center gap-0.5">
            <span className={cn('text-faint', size.pin)}>认得这个界面：</span>
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
                    'flex items-center gap-0.5 rounded-sm border px-0.5',
                    size.pin,
                    on ? 'border-confirmed text-confirmed' : 'border-line text-faint hover:text-fg',
                  )}
                >
                  <TemplateMini label={label} size={Math.max(12, thumb - 6)} />
                  {label}
                </button>
              );
            })}
            {(data.allTemplates ?? []).length === 0 && (
              <span className="text-badge text-faint">（还没有模板：先去画面栏框选录制）</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/*
              ＋操作：**先出菜单选动作类型**（以前直接建一个 click，用户不知道建了什么、也不知道怎么改）。
              菜单里还能直接绑定识别器（"点击某个模板"），建完自动选中那一步，参数在下方详情里改。
            */}
            <button
              type="button"
              title="加一步操作：先选动作类型，也可以直接选一个模板当目标"
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ x: rect.left, y: rect.bottom + 4 });
              }}
              className={cn(
                'self-start rounded-sm border border-line px-1 text-dim hover:bg-raised hover:text-fg',
                size.pin,
              )}
            >
              ＋操作
            </button>
            <button
              type="button"
              title="加分支：识别器出现 → 去 A；不出现 → 去 B"
              onClick={(event) => {
                event.stopPropagation();
                selectNode(data.sub); // 分支在下方详情里配置（需要选目标节点）
              }}
              className={cn(
                'self-start rounded-sm border border-line px-1 text-dim hover:bg-raised hover:text-fg',
                size.pin,
              )}
            >
              分支
            </button>
          </div>
        </div>
      )}

      {showPins &&
        data.pins.map((item) => (
          <div key={item.key} className="mt-0.5 flex flex-wrap items-center gap-0.5">
            {/* 这一步点的是哪个图标：画布上直接给缩略图，不用去翻识别器面板 */}
            {item.template && <TemplateMini label={item.template} size={thumb} />}
            {/*
              点这一行 = 选中这一步操作（下方详情面板切到它的参数）。
              必须 stopPropagation：否则会冒泡到节点，节点选中被重置 → 引脚收起来（用户反馈的"收起"）。
            */}
            <button
              type="button"
              title="选中这一步操作（在下方详情里改参数）"
              onClick={(event) => {
                event.stopPropagation();
                selectEdge(item.key);
              }}
              className={cn('rounded-sm px-0.5 text-dim hover:bg-raised hover:text-fg', size.pin)}
            >
              {item.title}
            </button>
            {/* 直接执行这一步（引擎 action.run：先识别一次再执行，目标才解析得出来） */}
            <button
              type="button"
              title="立即执行这一步（不改状态机，只做一次动作）"
              disabled={running === item.key}
              onClick={(event) => {
                event.stopPropagation();
                void runStep(item);
              }}
              className={cn(
                'rounded-sm border border-line px-0.5 text-dim hover:bg-raised hover:text-fg',
                size.pin,
                running === item.key && 'text-brand',
              )}
            >
              {running === item.key ? '⋯' : '▶'}
            </button>
            {/* 删除这一步 */}
            <button
              type="button"
              title="删除这一步操作"
              onClick={(event) => {
                event.stopPropagation();
                void removeEdge(String(data.deviceId), item.key);
              }}
              className={cn(
                'rounded-sm border border-line px-0.5 text-faint hover:bg-raised hover:text-failed',
                size.pin,
              )}
            >
              ✕
            </button>
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
                  'rounded-sm border px-0.5',
                  size.pin,
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

      {/* ＋操作菜单：动作类型 + 直接绑定识别器（"点击某个模板"） */}
      {menu && (
        <div onMouseDown={(event) => event.stopPropagation()}>
          <GraphContextMenu
            anchor={{
              kind: 'node',
              flow: { x: 0, y: 0 },
              screen: menu,
              title: '加一步操作',
              items: [
                ...ACTION_KINDS.map((kind) => ({
                  label: `＋ ${kind.label}`,
                  hint: kind.hint,
                  onSelect: () => createStep({ action: { type: kind.type } }),
                })),
                ...(data.allTemplates ?? []).slice(0, 6).map((label) => ({
                  label: `点击「${label}」`,
                  hint: '绑定模板',
                  divider: label === (data.allTemplates ?? [])[0],
                  onSelect: () =>
                    createStep({
                      action: { type: 'click', target: label },
                      when: label,
                      condition: { all_of: [label] },
                    }),
                })),
              ],
            }}
            onClose={() => setMenu(null)}
          />
        </div>
      )}
    </div>
  );
}
