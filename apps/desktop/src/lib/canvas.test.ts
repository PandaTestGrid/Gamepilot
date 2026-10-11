import { describe, expect, it } from 'vitest';

import { containBox, pointToCanvas, canvasRectToPixels } from '@/lib/canvas';

describe('画面坐标换算', () => {
  it('竖屏画面放进横容器：两侧留黑边，画面矩形居中', () => {
    // 720x1280 的手机画面放进 615x557 的面板（和真机实测尺寸一致）
    const box = containBox({ width: 615, height: 557 }, { width: 720, height: 1280 });

    expect(box).not.toBeNull();
    // 高度撑满，宽度按比例缩到 313.2
    expect(box?.height).toBeCloseTo(557, 1);
    expect(box?.width).toBeCloseTo((720 / 1280) * 557, 1);
    expect(box?.left).toBeCloseTo((615 - (720 / 1280) * 557) / 2, 1);
    expect(box?.top).toBeCloseTo(0, 1);
  });

  it('画面左下角映射到 (0, 1)，不是容器的左下角', () => {
    const box = containBox({ width: 615, height: 557 }, { width: 720, height: 1280 });
    if (!box) {
      throw new Error('box 不该为空');
    }

    // 容器最左侧那一列其实落在黑边上 → 不算数（返回 null）
    expect(pointToCanvas(box, { x: 0, y: 557 }, false)).toBeNull();
    // 画面矩形的左下角才是 (0, 1)
    expect(pointToCanvas(box, { x: box.left, y: box.top + box.height }, false)).toEqual([0, 1]);
    // 画面矩形正中心是 (0.5, 0.5)
    const center = pointToCanvas(box, { x: box.left + box.width / 2, y: box.top + box.height / 2 }, false);
    expect(center?.[0]).toBeCloseTo(0.5, 6);
    expect(center?.[1]).toBeCloseTo(0.5, 6);
  });

  it('背景区域（黑边）一律不响应', () => {
    const box = containBox({ width: 615, height: 557 }, { width: 720, height: 1280 });
    if (!box) {
      throw new Error('box 不该为空');
    }

    // 左侧黑边、右侧黑边、画面上方之外
    expect(pointToCanvas(box, { x: box.left - 5, y: 200 }, false)).toBeNull();
    expect(pointToCanvas(box, { x: box.left + box.width + 5, y: 200 }, false)).toBeNull();
    expect(pointToCanvas(box, { x: box.left + 10, y: box.top - 5 }, false)).toBeNull();
  });

  it('拖动中夹紧到 [0, 1]：手指滑出画面也不中断手势', () => {
    const box = containBox({ width: 400, height: 400 }, { width: 200, height: 400 });
    if (!box) {
      throw new Error('box 不该为空');
    }

    expect(pointToCanvas(box, { x: -100, y: -100 }, true)).toEqual([0, 0]);
    expect(pointToCanvas(box, { x: 9999, y: 9999 }, true)).toEqual([1, 1]);
  });

  it('尺寸无效时不给坐标（避免除零后点到屏幕左上角）', () => {
    expect(containBox({ width: 0, height: 0 }, { width: 720, height: 1280 })).toBeNull();
    expect(containBox({ width: 600, height: 500 }, { width: 0, height: 0 })).toBeNull();
    expect(pointToCanvas({ left: 0, top: 0, width: 0, height: 0 }, { x: 1, y: 1 }, true)).toBeNull();
  });
});

describe('canvasRectToPixels（画面矩形 → 容器像素）', () => {
  const box = { left: 148, top: 0, width: 353, height: 766 };

  it('把画面归一化矩形换算成容器像素（黑边不参与）', () => {
    expect(canvasRectToPixels(box, [0.25, 0.5, 0.1, 0.2])).toEqual({
      left: 148 + 0.25 * 353,
      top: 0.5 * 766,
      width: 0.1 * 353,
      height: 0.2 * 766,
    });
  });

  it('整幅画面 → 正好是画面区域', () => {
    expect(canvasRectToPixels(box, [0, 0, 1, 1])).toEqual(box);
  });

  it('和 pointToCanvas 互为逆运算', () => {
    const [x, y, w, h] = [0.2, 0.3, 0.4, 0.25];
    const pixels = canvasRectToPixels(box, [x, y, w, h]);
    expect(pixels).not.toBeNull();
    if (!pixels) return;
    const topLeft = pointToCanvas(box, { x: pixels.left, y: pixels.top }, false);
    const bottomRight = pointToCanvas(
      box,
      { x: pixels.left + pixels.width, y: pixels.top + pixels.height },
      false,
    );
    expect(topLeft).not.toBeNull();
    expect(bottomRight).not.toBeNull();
    // 浮点误差：用近似比较
    expect(topLeft?.[0]).toBeCloseTo(x, 10);
    expect(topLeft?.[1]).toBeCloseTo(y, 10);
    expect(bottomRight?.[0]).toBeCloseTo(x + w, 10);
    expect(bottomRight?.[1]).toBeCloseTo(y + h, 10);
  });

  it('没有画面区域时返回 null（还没量出画面就别画）', () => {
    expect(canvasRectToPixels(null, [0, 0, 1, 1])).toBeNull();
    expect(canvasRectToPixels({ left: 0, top: 0, width: 0, height: 0 }, [0, 0, 1, 1])).toBeNull();
  });
});
