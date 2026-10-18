/**
 * 运行记录（时间轴 Tab）：把引擎落盘的证据读出来给用户看。
 *
 * 三条契约：
 * 1. 没跑过 → 明确的空状态，不是空白面板；
 * 2. 有记录 → 每步一行（步号 / 类型 / 耗时），默认选中最后一步；
 * 3. 选中哪步 → 才去取那一步的截图（几十步全量拉 base64 会卡界面），并显示实际参数与识别分数。
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelinePane } from '@/features/events/TimelinePane';
import type { RunEvidenceBundle } from '@/lib/rpc';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';

type EvidenceBundle = { evidence: RunEvidenceBundle | null };

const runEvidence = vi.fn<() => Promise<EvidenceBundle>>();
const evidenceImage = vi.fn<() => Promise<{ jpeg: string }>>();

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock('@/lib/rpc', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/rpc');
  return {
    ...actual,
    runEvidence: () => runEvidence(),
    evidenceImage: () => evidenceImage(),
  };
});

function connect(): void {
  useDeviceStore.setState({
    devices: [
      {
        id: 'dev-1',
        name: '测试机',
        kind: 'android',
        uri: 'Android://127.0.0.1:5037/dev-1',
        resolution: [1080, 1920],
        fps: 20,
        status: 'connected',
      },
    ],
    activeId: 'dev-1',
  });
  useSessionStore.setState({ running: {} });
}

const BUNDLE = {
  dir: '.runs/20261018-201233',
  steps: [
    {
      index: 1,
      stepId: 's1',
      kind: 'click',
      ts: 1,
      screenshot: '001_step_s1.jpg',
      message: '',
      params: { by: '坐标', x: 0.5, y: 0.5 },
      result: '点击 · 0.50, 0.50',
      score: 0.9321,
      matchedRect: [0.1, 0.2, 0.3, 0.4],
      durationMs: 42,
    },
    {
      index: 2,
      stepId: 's2',
      kind: 'key',
      ts: 2,
      screenshot: '',
      message: '按键 back 失败',
      params: { value: 'back' },
      result: '',
      score: null,
      matchedRect: null,
      durationMs: 7,
    },
  ],
};

beforeEach(() => {
  runEvidence.mockReset();
  evidenceImage.mockReset();
  evidenceImage.mockResolvedValue({ jpeg: 'AAAA' });
});

describe('TimelinePane', () => {
  it('没有运行记录时给出空状态与刷新入口', async () => {
    connect();
    runEvidence.mockResolvedValue({ evidence: null });
    render(<TimelinePane />);
    expect(await screen.findByText(/还没有运行记录/)).toBeTruthy();
    expect(screen.getByText('刷新')).toBeTruthy();
  });

  it('列出每一步，默认选中最后一步并显示参数/耗时', async () => {
    connect();
    runEvidence.mockResolvedValue({ evidence: BUNDLE });
    render(<TimelinePane />);

    const rows = await screen.findAllByTestId('run-record-row');
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.textContent).toContain('click');
    expect(first.textContent).toContain('42ms');
    // 默认选中最后一步（失败的那一步）：参数里能看到 key
    await waitFor(() => expect(screen.getByText(/"value": "back"/)).toBeTruthy());
    // 行里与详情里各出现一次
    expect(screen.getAllByText('按键 back 失败').length).toBeGreaterThan(0);
  });

  it('选中第一步时按需取截图并显示识别分数', async () => {
    connect();
    runEvidence.mockResolvedValue({ evidence: BUNDLE });
    render(<TimelinePane />);

    const rows = await screen.findAllByTestId('run-record-row');
    (rows[0] as HTMLElement).click();
    expect(await screen.findByText('0.932')).toBeTruthy();
    await waitFor(() => expect(evidenceImage).toHaveBeenCalled());
    const image = await screen.findByAltText('第 1 步截图');
    expect(image.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
  });
});
