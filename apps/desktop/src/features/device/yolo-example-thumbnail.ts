import type { CSSProperties } from 'react';

/**
 * YOLOE receives the full reference frame plus a normalized prompt rectangle.
 * The thumbnail must show only that rectangle, letterboxed rather than stretched.
 * Keep the viewport equal to the button's *inner* 40px (44px including 2px borders).
 */
export function exampleThumbnailStyle(
  image: string,
  rect: readonly [number, number, number, number],
  width: number,
  height: number,
  viewport = 40,
): CSSProperties {
  const frameW = Math.max(1, width);
  const frameH = Math.max(1, height);
  const cropW = Math.max(1, rect[2] * frameW);
  const cropH = Math.max(1, rect[3] * frameH);
  const scale = Math.min(viewport / cropW, viewport / cropH);
  const offsetX = (viewport - cropW * scale) / 2;
  const offsetY = (viewport - cropH * scale) / 2;
  return {
    backgroundImage: `url(${image})`,
    backgroundSize: `${frameW * scale}px ${frameH * scale}px`,
    backgroundPosition: `${offsetX - rect[0] * frameW * scale}px ${offsetY - rect[1] * frameH * scale}px`,
    backgroundRepeat: 'no-repeat',
    // Background-position does not crop adjacent pixels: mask the letterbox
    // margins; otherwise the box appears larger than the prompt rectangle.
    clipPath: `inset(${offsetY}px ${offsetX}px)`,
  };
}
