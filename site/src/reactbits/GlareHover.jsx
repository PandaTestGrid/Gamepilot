/**
 * React Bits · GlareHover（无 Tailwind 改写版）
 * 悬停时一道斜向高光扫过容器。
 */
export default function GlareHover({
  children,
  className = '',
  color = 'rgba(255, 255, 255, 0.16)',
  as: Tag = 'div',
  ...rest
}) {
  return (
    <Tag
      className={`glare-hover ${className}`.trim()}
      style={{ '--glare-color': color }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
