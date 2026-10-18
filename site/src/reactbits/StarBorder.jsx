/**
 * React Bits · StarBorder（无 Tailwind 改写版）
 * 容器边缘有一束持续环绕的星光，适合强调 CTA。
 */
export default function StarBorder({
  children,
  className = '',
  as: Tag = 'div',
  speed = 7,
  ...rest
}) {
  return (
    <Tag
      className={`star-border ${className}`.trim()}
      style={{ '--star-speed': `${speed}s` }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
