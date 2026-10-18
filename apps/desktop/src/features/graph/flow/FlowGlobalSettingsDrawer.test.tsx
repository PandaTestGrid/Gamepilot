import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowGlobalSettingsDrawer } from '@/features/graph/flow/FlowGlobalSettingsDrawer';
import { SCRIPT_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useUiStore } from '@/stores/ui.store';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

describe('FlowGlobalSettingsDrawer 基础 / 拟人 Tab', () => {
  beforeEach(() => {
    useUiStore.setState({ flowGlobalSettingsOpen: true });
    useGraphStore.setState({
      raws: {
        [SCRIPT_SCOPE]: {
          version: 1,
          nodes: [],
          edges: [],
          recognizers: {},
          flow: { steps: [] },
          defaults: { swipe_bezier: true },
        },
      },
    });
  });

  it('默认打开基础列，拟人参数在另一个 Tab', () => {
    render(<FlowGlobalSettingsDrawer />);

    expect(screen.getByTestId('global-settings-tab-basic')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('global-settings-pane-basic')).toBeInTheDocument();
    expect(screen.getByText('步骤间隔')).toBeInTheDocument();
    expect(screen.getByText('单击按下')).toBeInTheDocument();
    expect(screen.queryByTestId('global-settings-pane-human')).toBeNull();
    expect(screen.queryByTestId('global-swipe-bezier')).toBeNull();

    fireEvent.click(screen.getByTestId('global-settings-tab-human'));

    expect(screen.getByTestId('global-settings-tab-human')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('global-settings-pane-human')).toBeInTheDocument();
    expect(screen.getByText('坐标偏移')).toBeInTheDocument();
    expect(screen.getByText('触点微移')).toBeInTheDocument();
    expect(screen.getByTestId('global-swipe-bezier')).toBeInTheDocument();
    expect(screen.queryByTestId('global-settings-pane-basic')).toBeNull();
    expect(screen.queryByText('步骤间隔')).toBeNull();
  });
});
