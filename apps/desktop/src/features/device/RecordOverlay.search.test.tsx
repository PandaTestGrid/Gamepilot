/**
 * 录制浮层不提供搜索范围。
 *
 * 搜索范围只在步骤上配置（StepSearchScope），默认「原区域」；
 * 录制时设「模板默认」会变成第二处配置，还会在界面上看不见的时候偷偷整帧搜。
 */
import { render, screen } from '@testing-library/react';
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

describe('RecordOverlay 录制表单', () => {
  it('没有搜索范围选项：只在步骤里配', () => {
    useUiStore.setState({ draft: { ...DRAFT } });
    try {
      render(<RecordOverlay deviceId="android:test" />);
      expect(screen.queryByTestId('draft-search-control')).toBeNull();
      expect(screen.queryByText('模板默认搜索范围')).toBeNull();
      expect(screen.queryByText('全屏')).toBeNull();
    } finally {
      useUiStore.setState({ draft: null });
    }
  });
});
