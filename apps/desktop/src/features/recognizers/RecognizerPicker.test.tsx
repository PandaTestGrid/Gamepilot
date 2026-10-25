import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exampleThumbnailStyle } from '@/features/device/yolo-example-thumbnail';
import { RecognizerPicker } from '@/features/recognizers/RecognizerPicker';
import { YoloExampleGallery } from '@/features/recognizers/YoloExampleGallery';
import type * as Rpc from '@/lib/rpc';
import type { YoloRecognizerDetail } from '@/lib/rpc';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore, WORKFLOW_SCOPE } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import type { RecognizerView } from '@/types';

const { detailMock } = vi.hoisted(() => ({ detailMock: vi.fn<(_device: string, label: string) => Promise<YoloRecognizerDetail>>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock('@/lib/rpc', async (importOriginal) => ({ ...await importOriginal<typeof Rpc>(), recognizerDetail: detailMock }));
vi.mock('@/features/device/YoloRecognizerDialog', () => ({ YoloRecognizerDialog: () => null }));

let deviceId: string;
let sequence = 0;
const root = 'S:/flows/picker';
function ai(label = 'ai_12'): RecognizerView {
  return { label, type: 'yolo', classes: ['目标'], examplesCount: 2, threshold: 0.3,
    score: 0, state: 'idle', samples: 0, roi: [0, 0, 1, 1], search: 'region' };
}
function detail(hasExamples = true): YoloRecognizerDetail {
  return { label: 'ai_12', threshold: 0.3, search: 'region', imgsz: 640, tile: false, tileSize: 640,
    tileOverlap: 0.2, examples: hasExamples ? [{ image: 'data:image/png;base64,cropped',
      rect: [0.25, 0.1, 0.5, 0.2], width: 800, height: 600, label: '目标' }] : [] };
}
function setRows(rows: readonly RecognizerView[]) {
  useGraphStore.setState({ graphs: { [WORKFLOW_SCOPE]: { deviceId: WORKFLOW_SCOPE, recognizers: rows,
    nodes: [], edges: [], variables: [], activeNodeId: null, pendingNodeId: null } } });
}
function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: '选择' }));
  return screen.getByRole('dialog', { name: '选择图像模板' });
}
beforeEach(() => {
  deviceId = `picker-${++sequence}`;
  detailMock.mockReset().mockResolvedValue(detail());
  useDeviceStore.setState({ activeId: deviceId });
  useSessionStore.setState({ currentWorkflow: { root, graphPath: `${root}/graph.json`, nodes: 0,
    edges: 0, recognizers: 1, templates: 0 } });
  setRows([ai()]);
});
afterEach(cleanup);

describe('RecognizerPicker AI 图片磁贴', () => {
  it.each([true, false])('compact=%s 保持列数，用真实裁剪图和真实名称选择', async (compact) => {
    const onChange = vi.fn();
    render(<RecognizerPicker value="" labels={['ai_12']} compact={compact} onChange={onChange} />);
    const dialog = openPicker();
    const tile = within(dialog).getByRole('button', { name: '选择 ai_12' });
    expect(within(tile).getByRole('status')).toHaveTextContent('加载图片');
    const image = await within(tile).findByRole('img');
    const example = detail().examples[0]!;
    const size = compact ? 44 : 56;
    const style = exampleThumbnailStyle(example.image, example.rect, example.width, example.height, size);
    expect(image).toHaveStyle({ backgroundImage: style.backgroundImage, backgroundSize: style.backgroundSize,
      backgroundPosition: style.backgroundPosition, clipPath: style.clipPath, width: `${size}px`, height: `${size}px` });
    expect(tile.parentElement).toHaveStyle({ gridTemplateColumns: `repeat(${compact ? 2 : 3}, minmax(0, 1fr))` });
    expect(tile).toHaveTextContent('ai_12');
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    expect(tile.querySelector('button')).toBeNull();
    fireEvent.click(tile);
    expect(onChange).toHaveBeenCalledWith('ai_12');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('选中状态及完整Gallery共享缓存，新score不重拉，重开复用缓存', async () => {
    render(<RecognizerPicker value="ai_12" labels={['ai_12']} compact onChange={vi.fn()} />);
    await screen.findByRole('img'); // 内嵌Gallery预先请求同一缓存
    fireEvent.click(screen.getByRole('button', { name: '更换' }));
    const tile = screen.getByRole('button', { name: '选择 ai_12' });
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    await within(tile).findByRole('img');
    act(() => setRows([{ ...ai(), score: 0.95, state: 'confirmed' }]));
    expect(detailMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    fireEvent.click(screen.getByRole('button', { name: '更换' }));
    await within(screen.getByRole('dialog')).findByRole('img');
    expect(detailMock).toHaveBeenCalledTimes(1);
  });

  it('无示例仍可选择，错误不会嵌套重试按钮，重开失败项会重试', async () => {
    detailMock.mockResolvedValueOnce(detail(false));
    const view = render(<RecognizerPicker value="" labels={['ai_12']} onChange={vi.fn()} />);
    let dialog = openPicker();
    expect(await within(dialog).findByText('暂无标记图片')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '选择 ai_12' })).not.toBeDisabled();
    view.unmount();
    setRows([ai('failed_ai')]);
    detailMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(detail());
    render(<RecognizerPicker value="" labels={['failed_ai']} onChange={vi.fn()} />);
    dialog = openPicker();
    expect(await within(dialog).findByText('图片加载失败')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    dialog = openPicker();
    expect(await within(dialog).findByRole('img')).toBeInTheDocument();
  });

  it('改名后使用新label请求，workflow切换隔离相同label的缓存', async () => {
    const view = render(<RecognizerPicker value="" labels={['ai_12']} onChange={vi.fn()} />);
    openPicker();
    await within(screen.getByRole('dialog')).findByRole('img');
    act(() => setRows([ai('背包入口')]));
    view.rerender(<RecognizerPicker value="" labels={['背包入口']} onChange={vi.fn()} />);
    await within(screen.getByRole('dialog')).findByRole('img');
    expect(detailMock).toHaveBeenLastCalledWith(deviceId, '背包入口');
    expect(screen.queryByRole('button', { name: '选择 ai_12' })).not.toBeInTheDocument();
    act(() => useSessionStore.setState((state) => ({ currentWorkflow: { ...state.currentWorkflow!, root: 'S:/flows/other' } })));
    await waitFor(() => expect(detailMock).toHaveBeenCalledTimes(3));
    await within(screen.getByRole('dialog')).findByRole('img');
  });

  it('离线编辑已有工作流仍从磁盘加载AI示例；无设备且无工作流才显示提示', async () => {
    useDeviceStore.setState({ activeId: '' });
    const view = render(<RecognizerPicker value="" labels={['ai_12']} onChange={vi.fn()} />);
    openPicker();
    expect(await within(screen.getByRole('dialog')).findByRole('img')).toBeInTheDocument();
    expect(detailMock).toHaveBeenCalledWith('', 'ai_12');
    view.unmount();
    useSessionStore.setState({ currentWorkflow: null });
    render(<RecognizerPicker value="" labels={['ai_12']} onChange={vi.fn()} />);
    openPicker();
    expect(within(screen.getByRole('dialog')).getByText('未连接设备')).toBeInTheDocument();
    expect(detailMock).toHaveBeenCalledTimes(1);
  });

  it('与额外素材Gallery并发挂载共用同一请求', async () => {
    render(<><RecognizerPicker value="" labels={['ai_12']} onChange={vi.fn()} />
      <YoloExampleGallery deviceId={deviceId} label="ai_12" examplesCount={2} revision={`${root}:0`} /></>);
    openPicker();
    await within(screen.getByRole('dialog')).findByRole('img');
    expect(detailMock).toHaveBeenCalledTimes(1);
  });
});
