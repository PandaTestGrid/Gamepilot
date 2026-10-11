/**
 * UI store：录制状态机 + 弹层/布局等跨面板的界面状态。
 *
 * 录制是「手感」的核心（DESIGN.md §4.4），流程写在这里而不是散在组件里：
 *   off ──点录制──▶ marquee / pick ──框选或点选──▶ draft ──确认──▶ 写入 graph + 事件 ──▶ 回到 marquee
 *                                        └──取消（Esc）──┘
 */
import { create } from 'zustand';

import { useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { useSessionStore } from '@/stores/session.store';
import type { DockTab, RecordDraft, RecordMode, RightTab } from '@/types';

const DEFAULT_THRESHOLD = 0.82;

interface UiState {
  readonly recordMode: RecordMode;
  readonly draft: RecordDraft | null;
  readonly devicePopoverOpen: boolean;
  readonly rightTab: RightTab;
  /** 底部调试抽屉：当前 Tab + 是否展开（点同一个 Tab = 收起） */
  readonly dockTab: DockTab;
  readonly dockOpen: boolean;
  readonly sequence: number;
  readonly setRecordMode: (mode: RecordMode) => void;
  readonly toggleRecording: () => void;
  /** 控制模式：开启后画面栏的鼠标操作会直接作用于设备（scrcpy 那样） */
  readonly controlMode: boolean;
  readonly toggleControl: () => void;
  /** 录操作：把画面上的每次点击/滑动录成脚本里的一步 */
  readonly recordActionMode: boolean;
  readonly toggleRecordAction: () => void;
  readonly toggleDevicePopover: (open?: boolean) => void;
  readonly setRightTab: (tab: RightTab) => void;
  readonly toggleDock: (tab: DockTab) => void;
  readonly closeDock: () => void;
  readonly beginDraft: (input: { rect: readonly [number, number, number, number]; score: number }) => void;
  readonly updateDraft: (patch: Partial<RecordDraft>) => void;
  readonly cancelDraft: () => void;
  /** 确认草稿：一次交互内同时落 识别器 + 节点 + 边，并写事件（可撤销的原子操作） */
  readonly commitDraft: () => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  recordMode: 'off',
  controlMode: true,
  recordActionMode: false,
  draft: null,
  devicePopoverOpen: false,
  rightTab: 'library',
  dockTab: 'events',
  dockOpen: false,
  sequence: 1,

  setRecordMode: (mode) => set({ recordMode: mode, draft: mode === 'off' ? null : get().draft }),
  toggleRecording: () =>
    set((state) => ({ recordMode: state.recordMode === 'off' ? 'marquee' : 'off', draft: null })),
  toggleControl: () => set((state) => ({ controlMode: !state.controlMode })),
  toggleRecordAction: () => set((state) => ({ recordActionMode: !state.recordActionMode })),
  toggleDevicePopover: (open) => set((state) => ({ devicePopoverOpen: open ?? !state.devicePopoverOpen })),
  setRightTab: (rightTab) => set({ rightTab }),
  toggleDock: (tab) =>
    set((state) =>
      state.dockOpen && state.dockTab === tab ? { dockOpen: false } : { dockTab: tab, dockOpen: true },
    ),
  closeDock: () => set({ dockOpen: false }),

  beginDraft: ({ rect, score }) => {
    const sequence = get().sequence;
    set({
      sequence: sequence + 1,
      draft: {
        rect,
        label: '',
        threshold: DEFAULT_THRESHOLD,
        score,
        asEnter: true,
        asActionTarget: true,
        targetMode: 'new',
        targetNodeId: null,
        newNodeName: '新界面',
        newNodeId: `node_${sequence}`,
      },
    });
  },

  updateDraft: (patch) => set((state) => (state.draft ? { draft: { ...state.draft, ...patch } } : state)),

  cancelDraft: () => set({ draft: null }),

  commitDraft: () => {
    const { draft } = get();
    const deviceId = useDeviceStore.getState().activeId;
    if (!draft || !deviceId) {
      return;
    }
    // 录制需要真实画面：没连设备就明确告诉用户，而不是偷偷改本地假数据
    if (!useSessionStore.getState().isReady(deviceId)) {
      useEventStore.getState().append(deviceId, 'error', {
        message: '录制需要先连接设备：顶栏「未连接设备」→ 选择设备 → 连接',
      });
      return;
    }
    void useSessionStore.getState().record(deviceId, draft);
    set({ draft: null });
  },
}));
