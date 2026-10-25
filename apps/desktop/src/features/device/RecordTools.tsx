/**
 * 录制工具：框选 / 点选 / 文字识别 / 录操作（录操作开着时另外多出「+等 0.5s / 1s / 3s」）。
 *
 * 四个都作用在**画面**上，产出的是**素材**（图像模板 / OCR 识别器）和工作流步骤，
 * 所以挂在「素材区」头部右侧 —— 跟它产出的东西待在一起，离画面也只有一行的距离。
 * （以前挂在工作流详情坞的「配置」Tab 前面：离画面远、离素材也远，找个框选要跨两个栏。）
 */
import { MousePointerSquareDashed, ScanLine, ScanText, Video } from 'lucide-react';
import { type ReactNode } from 'react';

import { FLOW_EDIT_LOCKED_HINT } from '@/lib/flow-edit-lock';
import { useCurrentWorkflowLive } from '@/lib/useLiveWorkflow';
import { cn } from '@/lib/utils';
import { activeDevice, useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

/** 图标按钮：三个录制动作共用一套样式（`active` = 正在录制，点亮） */
const ICON_BUTTON = 'flex size-5 shrink-0 items-center justify-center rounded-sm';

export function RecordTools({ deviceId }: { deviceId: string }): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const device = activeDevice(devices, deviceId);
  const isConnected = useSessionStore((state) => Boolean(state.ready[deviceId]));
  const recordStep = useSessionStore((state) => state.recordStep);
  const recordMode = useUiStore((state) => state.recordMode);
  const recordKind = useUiStore((state) => state.recordKind);
  const setRecordMode = useUiStore((state) => state.setRecordMode);
  const beginOcr = useUiStore((state) => state.beginOcrRecognizerCapture);
  const recordActionMode = useUiStore((state) => state.recordActionMode);
  const toggleRecordAction = useUiStore((state) => state.toggleRecordAction);
  const lockEdits = useCurrentWorkflowLive();
  const canRecord = isConnected && !lockEdits;

  const tools = [
    {
      mode: 'marquee' as const,
      label: '框选录制',
      hint: '框选录制：在设备画面上拖一个矩形生成识别器（点到别处或 Esc 关闭）',
      Icon: MousePointerSquareDashed,
    },
    {
      mode: 'pick' as const,
      label: '点选录制',
      hint: '点选录制：在设备画面上单击取 3×3% 邻域小模板（点到别处或 Esc 关闭）',
      Icon: ScanLine,
    },
  ];
  const ocrOn = recordMode === 'marquee' && recordKind === 'ocr';
  return (
    <div
      className="ml-auto flex shrink-0 items-center gap-0.5"
      role="group"
      aria-label="录制工具"
      data-capture-keep
    >
      {tools.map(({ mode, label, hint, Icon }) => {
        // 文字识别也走 marquee 框选，但产出的是 OCR 表单，不能和「框选录制」同时点亮
        const active = recordMode === mode && !(mode === 'marquee' && recordKind === 'ocr');
        return (
          <button
            key={mode}
            type="button"
            aria-label={label}
            aria-pressed={active}
            data-testid={`record-${mode}`}
            disabled={!canRecord}
            title={
              lockEdits
                ? FLOW_EDIT_LOCKED_HINT
                : isConnected
                  ? hint
                  : `设备未连接：先连上设备才能${label}（当前 ${device?.name ?? '无设备'}）`
            }
            onClick={() => setRecordMode(active ? 'off' : mode)}
            className={cn(
              ICON_BUTTON,
              active ? 'bg-brand/20 text-brand' : 'text-dim hover:bg-raised hover:text-fg',
              !canRecord && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-dim',
            )}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
      {/*
        文字识别**不跟着禁用**：点了没反应比报错更难查（store 里会给一句人话，
        没连设备时顺手把设备选择器打开）；框选/点选/录操作没有设备时确实无从下手，才置灰。
      */}
      <button
        type="button"
        aria-label="文字识别"
        aria-pressed={ocrOn}
        data-testid="record-ocr"
        onClick={() => (ocrOn ? setRecordMode('off') : beginOcr())}
        title={
          ocrOn ? '正在框选文字识别区域：再点一次或按 Esc 关闭' : '文字识别：框住要读字的区域，填上要认的字'
        }
        className={cn(
          ICON_BUTTON,
          ocrOn ? 'bg-brand/20 text-brand' : 'text-dim hover:bg-raised hover:text-fg',
        )}
      >
        <ScanText className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="录操作"
        aria-pressed={recordActionMode}
        data-testid="record-action"
        disabled={!canRecord}
        onClick={toggleRecordAction}
        title={
          lockEdits
            ? FLOW_EDIT_LOCKED_HINT
            : isConnected
              ? recordActionMode
                ? '正在录操作：画面上的每次点击/滑动都会变成工作流里的一步（点到别处或 Esc 关闭）'
                : '录操作：把画面上的点击/滑动录成工作流里的一步'
              : `设备未连接：先连上设备才能录操作（当前 ${device?.name ?? '无设备'}）`
        }
        className={cn(
          ICON_BUTTON,
          recordActionMode ? 'bg-brand/20 text-brand' : 'text-dim hover:bg-raised hover:text-fg',
          !canRecord && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-dim',
        )}
      >
        <Video className="size-3.5" />
      </button>
      {recordActionMode &&
        isConnected &&
        [0.5, 1, 3].map((seconds) => (
          <button
            key={seconds}
            type="button"
            data-testid={`record-wait-${seconds}`}
            onClick={() => void recordStep(deviceId, { type: 'wait', seconds })}
            className="h-5 shrink-0 rounded-sm border border-line px-1 text-badge text-dim hover:bg-raised hover:text-fg"
            title={`录一步"等待 ${seconds}s"`}
          >
            +等{seconds}s
          </button>
        ))}
    </div>
  );
}
