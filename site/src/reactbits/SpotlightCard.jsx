import { useRef } from 'react';

/**
 * React Bits · SpotlightCard（无 Tailwind 改写版）
 * 光标在卡片内移动时，用径向高光跟随，边框同时提亮。
 */
export default function SpotlightCard({
  children,
  className = '',
  color = 'rgba(77, 163, 255, 0.18)',
  as: Tag = 'article',
  ...rest
}) {
  const ref = useRef(null);

  const handleMove = (event) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--spot-x', `${event.clientX - rect.left}px`);
    el.style.setProperty('--spot-y', `${event.clientY - rect.top}px`);
  };

  const handleLeave = () => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--spot-x', '50%');
    el.style.setProperty('--spot-y', '0px');
  };

  return (
    <Tag
      ref={ref}
      className={`spotlight-card ${className}`.trim()}
      style={{ '--spot-color': color }}
      onPointerMove={handleMove}
      onPointerLeave={handleLeave}
      {...rest}
    >
      {children}
    </Tag>
  );
}
