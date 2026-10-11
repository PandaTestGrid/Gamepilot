/**
 * 调试抽屉的内容区：按 `ui.store.dockTab` 渲染四个 Tab 之一。
 *
 * 为什么把调试信息收到下面：事件/日志/控制台是"跑起来之后偶尔盯一眼"的东西，
 * 常驻会一直占着宝贵的纵向空间；抽屉平时只占 28px（由 layout/BottomDock.tsx 负责展开/收起），
 * 需要时拉开、拉开的高度还能拖（`layout-specs.ts` 的 DOCK_LAYOUT 会记住）。
 */
import { type ReactNode } from 'react';

import { ConsolePane } from '@/features/debug/ConsolePane';
import { LogFeed } from '@/features/debug/LogFeed';
import { EventFeed } from '@/features/events/EventFeed';
import { TimelinePane } from '@/features/events/TimelinePane';
import { useUiStore } from '@/stores/ui.store';

export function DebugDrawer(): ReactNode {
  const tab = useUiStore((state) => state.dockTab);

  switch (tab) {
    case 'logs':
      return <LogFeed />;
    case 'console':
      return <ConsolePane />;
    case 'timeline':
      return <TimelinePane />;
    default:
      return <EventFeed />;
  }
}
