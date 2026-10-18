/**
 * 录制草稿的入口：按草稿的识别器种类选表单。
 *
 * 画面栏只管"框到了哪块区域"（`DraftSelectionBox`），表单长什么样由这里分流：
 * - `template`：图像匹配（名称、阈值、搜索范围、注册为…）
 * - `ocr`：文字识别（要识别的文字、匹配方式、置信度阈值…）
 *
 * 两种表单的浮层外壳/摆位/键盘行为共用 `DraftOverlayShell`。
 */
import { type ReactNode } from 'react';

import { type DraftAnchor } from '@/features/device/DraftOverlayShell';
import { OcrRecognizerDialog } from '@/features/device/OcrRecognizerDialog';
import { RecordOverlay } from '@/features/device/RecordOverlay';
import { useUiStore } from '@/stores/ui.store';

export function DraftForm({
  deviceId,
  anchor,
}: {
  deviceId: string;
  anchor?: DraftAnchor | null;
}): ReactNode {
  const draft = useUiStore((state) => state.draft);
  if (!draft) {
    return null;
  }
  return draft.kind === 'ocr' ? (
    <OcrRecognizerDialog deviceId={deviceId} anchor={anchor} />
  ) : (
    <RecordOverlay deviceId={deviceId} anchor={anchor} />
  );
}
