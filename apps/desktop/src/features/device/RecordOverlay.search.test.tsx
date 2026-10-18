/**
 * 录制浮层的搜索范围开关。
 *
 * 默认必须是「原区域」（与老行为一致）：只有用户明确勾了「全屏查找」，
 * 目标才允许出现在屏幕任意位置 —— 全屏搜索更慢，也更可能碰到同分候选。
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RecordOverlay } from '@/features/device/RecordOverlay';
import { useUiStore } from '@/stores/ui.store';
import type { RecordDraft } from '@/types';

const DRAFT: RecordDraft = {
  deviceId: 'android:test',
  mode: 'marquee',
  rect: [0.1, 0.1, 0.2, 0.1],
  label: '按钮',
  threshold: 0.82,
  score: 0.9,
  asEnter: false,
  asActionTarget: false,
  search: 'region',
  targetMode: 'new',
  targetNodeId: null,
  newNodeName: '新界面',
  newNodeId: 'node_1',
};

describe('RecordOverlay 搜索范围', () => {
  it('默认原区域；勾选「全屏查找」后草稿变 full', () => {
    useUiStore.setState({ draft: { ...DRAFT } });
    try {
      render(<RecordOverlay deviceId="android:test" />);

      const control = screen.getByTestId('draft-search-control');
      const checkbox = within(control).getByRole('checkbox');
      expect(checkbox).not.toBeChecked();

      fireEvent.click(checkbox);

      expect(useUiStore.getState().draft?.search).toBe('full');
      expect(checkbox).toBeChecked();
    } finally {
      useUiStore.setState({ draft: null });
    }
  });
});
