/**
 * 画面坐标换算。
 *
 * 为什么单独抽出来：控制坐标必须落在"**真正画出画面的那块区域**"上。
 * 画面是 `object-contain` 显示的，容器里会有黑边（letterbox）——
 * 竖屏手机放在横容器里时，两侧黑边能占掉一半宽度。
 * 如果按容器算，点画面左边缘会被映射成 x≈0.2，手机上就点偏了。
 */

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * 按 `object-fit: contain` 的规则算出画面在容器里的实际显示矩形（容器相对坐标）。
 * 容器或画面尺寸无效时返回 null（此时不应该接受控制操作）。
 */
/** 量画面区时优先用引擎帧分辨率：转横屏后 JPEG 可能还没 decode，naturalWidth 仍是旧竖屏。 */
export function screenImageSize(
  resolution: readonly [number, number] | undefined | null,
  image: { naturalWidth: number; naturalHeight: number } | null,
): Size | null {
  if (resolution && resolution[0] > 0 && resolution[1] > 0) {
    return { width: resolution[0], height: resolution[1] };
  }
  if (image && image.naturalWidth > 0 && image.naturalHeight > 0) {
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
  return null;
}

export function containBox(container: Size, image: Size): Box | null {
  if (container.width <= 0 || container.height <= 0 || image.width <= 0 || image.height <= 0) {
    return null;
  }
  const scale = Math.min(container.width / image.width, container.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height,
  };
}

/**
 * 容器内坐标（左上角为原点）→ 画面归一化坐标。
 *
 * - `clamp: false`（按下时用）：落在黑边上返回 `null` —— **背景区域不算**，直接不响应
 * - `clamp: true`（拖动中/抬手时用）：夹到 [0, 1]，手指滑出画面也不该中断手势
 */
export function pointToCanvas(
  box: Box,
  point: { x: number; y: number },
  clamp: boolean,
): [number, number] | null {
  if (box.width <= 0 || box.height <= 0) {
    return null;
  }
  let x = (point.x - box.left) / box.width;
  let y = (point.y - box.top) / box.height;
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) {
    return null;
  }
  x = Math.min(1, Math.max(0, x));
  y = Math.min(1, Math.max(0, y));
  return [x, y];
}

/** 容器像素矩形（绝对定位直接用这四个值）。 */
export interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** 容器像素点（绝对定位 `left/top` 直接用这两个值）。 */
export interface PixelPoint {
  readonly left: number;
  readonly top: number;
}

/**
 * **画面归一化点 → 容器像素点**：画"手指按/滑在哪里"这类反馈用。
 *
 * 和 `canvasRectToPixels` 同一条规矩 —— 必须按**实际画出来的画面区域**换算。
 * 有黑边时用容器百分比画反馈点，点会落在黑边上（"我明明点的这里，波纹却飘了"）。
 */
export function canvasPointToPixels(box: Box | null, point: readonly [number, number]): PixelPoint | null {
  if (!box || box.width <= 0 || box.height <= 0) {
    return null;
  }
  return { left: box.left + point[0] * box.width, top: box.top + point[1] * box.height };
}

/**
 * **画面归一化矩形 → 容器像素矩形**（`pointToCanvas` 的逆运算）。
 *
 * 界面上所有"按画面坐标画东西"的地方都必须走这里：
 * 框选、识别框、录制浮层等须统一走此换算，避免与 letterbox 后的画面错位。
 */
export function canvasRectToPixels(
  box: Box | null,
  rect: readonly [number, number, number, number],
): PixelRect | null {
  if (!box || box.width <= 0 || box.height <= 0) {
    return null;
  }
  const [x, y, width, height] = rect;
  return {
    left: box.left + x * box.width,
    top: box.top + y * box.height,
    width: width * box.width,
    height: height * box.height,
  };
}
