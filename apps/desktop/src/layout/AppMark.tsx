/**
 * GamePilot 的小尺寸品牌标。
 *
 * 和安装包/图标用的是同一个标（`apps/desktop/branding/logo.svg`）：
 * 深墨底、浅黄绿色线框和 G 形航迹，呼应 Fieldnotes / Automation 的品牌参考。
 */
import { type ReactNode } from 'react';

export function AppMark({ size = 18, monochrome = false }: { size?: number; monochrome?: boolean }): ReactNode {
  const stroke = monochrome ? 'currentColor' : '#c0cbaa';
  const background = monochrome ? 'transparent' : '#171b1a';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      data-testid="app-mark"
      aria-label="GamePilot"
      role="img"
      className={monochrome ? 'shrink-0 text-brand' : 'shrink-0'}
    >
      <title>GamePilot</title>
      <rect width="1024" height="1024" rx="96" fill={background} />
      <rect x="170" y="120" width="684" height="784" fill="none" stroke={stroke} strokeWidth={38} />
      <path
        d="M694 344 A250 250 0 1 0 710 620 H548"
        fill="none"
        stroke={stroke}
        strokeWidth={68}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M335 562 C422 466 520 382 631 302 M631 302 H713 V384"
        fill="none"
        stroke={stroke}
        strokeWidth={52}
        strokeLinecap="butt"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
