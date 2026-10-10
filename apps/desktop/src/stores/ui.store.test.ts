import { beforeEach, describe, expect, it } from 'vitest';

import { MOCK_DEVICES } from '@/mock/seed';
import { useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { useGraphStore } from '@/stores/graph.store';
import { useUiStore } from '@/stores/ui.store';

const DEVICE = 'dev-a';

function reset(): void {
  useDeviceStore.setState({ devices: MOCK_DEVICES, activeId: DEVICE, gridView: false });
  useGraphStore.setState({ graphs: {}, selectedEdgeId: null });
  useEventStore.setState({ events: {}, filter: 'all', seq: 0 });
  useUiStore.setState({ recordMode: 'off', draft: null, devicePopoverOpen: false, sequence: 1 });
  useGraphStore.getState().ensure(DEVICE);
  useEventStore.getState().ensure(DEVICE);
}

describe('录制流程（一次交互 = 识别器 + 节点 + 边 + 事件）', () => {
  beforeEach(reset);

  it('toggleRecording 在 off 与 marquee 之间切换，并清掉未确认的草稿', () => {
    const ui = useUiStore.getState();
    expect(ui.recordMode).toBe('off');

    ui.toggleRecording();
    expect(useUiStore.getState().recordMode).toBe('marquee');

    useUiStore.getState().beginDraft({ rect: [0.1, 0.2, 0.3, 0.1], score: 0.9 });
    expect(useUiStore.getState().draft).not.toBeNull();

    useUiStore.getState().toggleRecording();
    expect(useUiStore.getState().recordMode).toBe('off');
    expect(useUiStore.getState().draft).toBeNull();
  });

  it('beginDraft 用规范里约定的默认值（阈值 0.82、默认当作状态判定）', () => {
    useUiStore.getState().beginDraft({ rect: [0.4, 0.4, 0.2, 0.1], score: 0.93 });
    const draft = useUiStore.getState().draft;

    expect(draft?.threshold).toBe(0.82);
    expect(draft?.asEnter).toBe(true);
    expect(draft?.asActionTarget).toBe(true);
    expect(draft?.targetMode).toBe('new');
    expect(draft?.score).toBe(0.93);
  });

  it('commitDraft 原子性地写入识别器 / 新节点 / 边，并各写一条事件', () => {
    const graphBefore = useGraphStore.getState().graphs[DEVICE];
    const eventsBefore = useEventStore.getState().events[DEVICE]?.length ?? 0;

    useUiStore.getState().beginDraft({ rect: [0.4, 0.4, 0.2, 0.1], score: 0.93 });
    useUiStore.getState().updateDraft({ label: 'main_reward', newNodeName: '奖励页', newNodeId: 'node_x' });
    useUiStore.getState().commitDraft();

    const graph = useGraphStore.getState().graphs[DEVICE];
    expect(graph?.recognizers.some((item) => item.label === 'main_reward')).toBe(true);
    expect(graph?.nodes.some((node) => node.id === 'node_x' && node.enter.includes('main_reward'))).toBe(
      true,
    );

    // 边：从活动节点指向新节点，触发条件就是刚录的识别器
    const edge = graph?.edges.find((item) => item.id === 'e_main_reward');
    expect(edge?.from).toBe('main');
    expect(edge?.to).toBe('node_x');
    expect(edge?.when).toBe('main_reward');

    const events = useEventStore.getState().events[DEVICE] ?? [];
    const added = events.slice(eventsBefore).map((event) => event.type);
    expect(added).toEqual(['recognizer_added', 'node_added', 'edge_added']);

    // 草稿确认后清空，录制模式保持（方便连续录多个元素）
    expect(useUiStore.getState().draft).toBeNull();
    expect(graphBefore?.recognizers.length).toBe((graph?.recognizers.length ?? 0) - 1);
  });

  it('targetMode=existing 时只往现有节点加判定标签，不新建节点', () => {
    const nodesBefore = useGraphStore.getState().graphs[DEVICE]?.nodes.length ?? 0;

    useUiStore.getState().beginDraft({ rect: [0.1, 0.1, 0.1, 0.1], score: 0.9 });
    useUiStore.getState().updateDraft({ label: 'main_extra', targetMode: 'existing', targetNodeId: 'shop' });
    useUiStore.getState().commitDraft();

    const graph = useGraphStore.getState().graphs[DEVICE];
    expect(graph?.nodes.length).toBe(nodesBefore);
    expect(graph?.nodes.find((node) => node.id === 'shop')?.enter).toContain('main_extra');
  });

  it('标签留空时回退成 region_N，不会写出空标签的识别器', () => {
    useUiStore.getState().beginDraft({ rect: [0.1, 0.1, 0.1, 0.1], score: 0.9 });
    useUiStore.getState().commitDraft();

    const labels = useGraphStore.getState().graphs[DEVICE]?.recognizers.map((item) => item.label) ?? [];
    expect(labels.some((label) => label.startsWith('region_'))).toBe(true);
  });

  it('cancelDraft 不动状态图', () => {
    const before = useGraphStore.getState().graphs[DEVICE];
    useUiStore.getState().beginDraft({ rect: [0.1, 0.1, 0.1, 0.1], score: 0.9 });
    useUiStore.getState().cancelDraft();

    expect(useUiStore.getState().draft).toBeNull();
    expect(useGraphStore.getState().graphs[DEVICE]).toBe(before);
  });
});
