/**
 * 把一个可拖拽区域接上「布局记忆 + 预设/恢复默认」。
 *
 * 用法（每个 Group 三行）：
 *   const { defaultLayout, onLayoutChanged, groupRef } = useLayoutGroup(SHELL_LAYOUT);
 *   <Group id={SHELL_LAYOUT.id} orientation="horizontal" defaultLayout={defaultLayout}
 *          onLayoutChanged={onLayoutChanged} groupRef={groupRef}>
 *
 * `onlySaveAfterUserInteractions` 是关键：画布编辑区会随"有没有选中节点"自动收起/展开，
 * 那是程序化改的尺寸，不应该覆盖用户亲手拖出来的比例。
 */
import { type RefObject, useEffect } from 'react';
import {
  useDefaultLayout,
  useGroupRef,
  type GroupImperativeHandle,
  type Layout,
  type LayoutChangedMeta,
} from 'react-resizable-panels';

import { registerLayoutGroup, type LayoutSpec } from '@/layout/layout-specs';

export interface LayoutGroupBinding {
  readonly defaultLayout: Layout | undefined;
  readonly onLayoutChanged: (layout: Layout, meta: LayoutChangedMeta) => void;
  readonly groupRef: RefObject<GroupImperativeHandle | null>;
}

export function useLayoutGroup(spec: LayoutSpec): LayoutGroupBinding {
  const stored = useDefaultLayout({
    id: spec.id,
    onlySaveAfterUserInteractions: true,
  });
  const groupRef = useGroupRef();

  useEffect(
    () => registerLayoutGroup(spec.id, (panels) => groupRef.current?.setLayout({ ...panels })),
    [spec.id, groupRef],
  );

  // 记忆里若是空对象（历史脏数据/写到一半），传给 Group 会因"key 数与面板数不符"直接抛错，
  // 表现是"打开就白屏"。宁可退回默认比例，也不要让一条脏记录把界面锁死。
  const defaultLayout =
    stored.defaultLayout && Object.keys(stored.defaultLayout).length > 0 ? stored.defaultLayout : undefined;

  return { defaultLayout, onLayoutChanged: stored.onLayoutChanged, groupRef };
}
