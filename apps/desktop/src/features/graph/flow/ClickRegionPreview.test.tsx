import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ClickRegionPreview } from '@/features/graph/flow/ClickRegionPreview';

describe('ClickRegionPreview', () => {
  it('有 rect 时渲染示意图，不用截图', () => {
    render(<ClickRegionPreview params={{ rect: [0.2, 0.3, 0.15, 0.4] }} />);
    expect(screen.getByTestId('click-region-preview')).toBeTruthy();
    expect(screen.getByText('区域')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('竖屏宽高比：外框高度大于宽度', () => {
    render(<ClickRegionPreview params={{ rect: [0.2, 0.3, 0.15, 0.4], screenAspect: 1080 / 1920 }} />);
    const frame = screen.getByTestId<HTMLElement>('click-region-frame');
    const w = Number.parseInt(frame.style.width, 10);
    const h = Number.parseInt(frame.style.height, 10);
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(h);
  });

  it('高亮块按归一化位置摆放，尺寸读数与区间都写出来', () => {
    render(<ClickRegionPreview params={{ rect: [0.04, 0.58, 0.9, 0.23] }} compact />);
    const area = screen.getByTestId('click-region-area');
    expect(area.style.left).toBe('4%');
    expect(area.style.top).toBe('58%');
    expect(area.style.width).toBe('90%');
    expect(area.style.height).toBe('23%');
    expect(screen.getByText('0.90 × 0.23')).toBeTruthy();
    expect(screen.getByText('X 0.04–0.94')).toBeTruthy();
    expect(screen.getByText('Y 0.58–0.81')).toBeTruthy();
  });

  it('无 rect 不渲染', () => {
    const { container } = render(<ClickRegionPreview params={{}} />);
    expect(container.firstChild).toBeNull();
  });
});
