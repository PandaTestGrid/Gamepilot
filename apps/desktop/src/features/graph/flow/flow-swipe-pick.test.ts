/**
 * 录制滑动 → 写入流程步骤的落点逻辑。
 *
 * 守两件事：
 * - 拖出弯的路线时要连 `path` 一起写（否则回放还是直线，用户"录了但没生效"）；
 * - 重录成一条直线时要**清掉**旧 `path`（否则回放还在走上一把的弧线）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { commitSwipePick } from '@/features/graph/flow/flow-swipe-pick';
import { WORKFLOW_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useUiStore } from '@/stores/ui.store';
import type { FlowStep } from '@/types';

const DEVICE = 'mock:1';
const STEP_ID = 'sw1';

function swipeStep(params: Record<string, unknown> = {}): FlowStep {
  return { id: STEP_ID, type: 'swipe', params: { x: 0.1, y: 0.1, to_x: 0.1, to_y: 0.2, ...params } };
}

describe('commitSwipePick', () => {
  const updateFlowStep = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    updateFlowStep.mockClear();
    useGraphStore.setState({
      graphs: {
        [WORKFLOW_SCOPE]: {
          deviceId: WORKFLOW_SCOPE,
          nodes: [],
          edges: [],
          recognizers: [],
          variables: [],
          activeNodeId: null,
          pendingNodeId: null,
          flow: { steps: [swipeStep()] },
        },
      },
      // 只关心"写进去什么"：落盘与选中都打桩
      updateFlowStep,
      selectNode: vi.fn(),
    });
    useUiStore.setState({ pendingFlowSwipeStepId: STEP_ID });
  });

  it('拖出轨迹：写入 path 与 hold_ms，并清掉待录制态', async () => {
    await commitSwipePick(DEVICE, STEP_ID, 0.2, 0.8, 0.6, 0.6, 300, {
      path: [
        [0.2, 0.8],
        [0.4, 0.8],
        [0.6, 0.6],
      ],
      holdMs: 412,
    });

    const params = (updateFlowStep.mock.calls.at(-1) as unknown[])[1] as {
      params: Record<string, unknown>;
    };
    expect(params.params.path).toEqual([
      [0.2, 0.8],
      [0.4, 0.8],
      [0.6, 0.6],
    ]);
    expect(params.params.hold_ms).toBe(412);
    expect(params.params.duration_ms).toBe(300);
    expect(useUiStore.getState().pendingFlowSwipeStepId).toBeNull();
  });

  it('拖成直线（只有起止两点）：不带 path，且把旧的弧线清掉', async () => {
    useGraphStore.setState({
      graphs: {
        [WORKFLOW_SCOPE]: {
          deviceId: WORKFLOW_SCOPE,
          nodes: [],
          edges: [],
          recognizers: [],
          variables: [],
          activeNodeId: null,
          pendingNodeId: null,
          flow: {
            steps: [
              swipeStep({
                path: [
                  [0.1, 0.1],
                  [0.3, 0.5],
                  [0.1, 0.2],
                ],
                hold_ms: 800,
              }),
            ],
          },
        },
      },
      updateFlowStep,
      selectNode: vi.fn(),
    });

    await commitSwipePick(DEVICE, STEP_ID, 0.1, 0.1, 0.1, 0.2, 120, {
      path: [
        [0.1, 0.1],
        [0.1, 0.2],
      ],
      holdMs: 0,
    });

    const params = (updateFlowStep.mock.calls.at(-1) as unknown[])[1] as {
      params: Record<string, unknown>;
    };
    // key 还在但值为 undefined：落盘时 JSON 序列化会丢掉，语义上是"没有轨迹"
    expect(params.params.path).toBeUndefined();
    expect(params.params.hold_ms).toBeUndefined();
  });

  it('不是滑动步骤：不写、但把待录制态清掉（不留悬挂的引导条）', async () => {
    useGraphStore.setState({
      graphs: {
        [WORKFLOW_SCOPE]: {
          deviceId: WORKFLOW_SCOPE,
          nodes: [],
          edges: [],
          recognizers: [],
          variables: [],
          activeNodeId: null,
          pendingNodeId: null,
          flow: { steps: [{ id: STEP_ID, type: 'click', params: {} }] },
        },
      },
      updateFlowStep,
      selectNode: vi.fn(),
    });

    await commitSwipePick(DEVICE, STEP_ID, 0.1, 0.1, 0.2, 0.2, 200);

    expect(updateFlowStep).not.toHaveBeenCalled();
    expect(useUiStore.getState().pendingFlowSwipeStepId).toBeNull();
  });
});
