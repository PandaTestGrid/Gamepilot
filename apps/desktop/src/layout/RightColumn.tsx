/**
 * 右栏：Tab 容器。
 *
 * 右栏直接是工作区列表（工作区（文件夹）› 工作流），不再有 Tab 条。
 * 识别器/素材那套搬到**画面下方的「素材区」**了（缩略图 + 分数 + 阈值 + 改名 + 删除都在那儿），
 * 这里不再重复一份 —— 以前右栏也有个「识别器」Tab，同一批东西两处显示，看着像两套。
 */
import { type ReactNode } from 'react';

import { WorkspaceLibraryPane } from '@/features/library/WorkspaceLibraryPane';

export function RightColumn(): ReactNode {
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <WorkspaceLibraryPane />
    </div>
  );
}
