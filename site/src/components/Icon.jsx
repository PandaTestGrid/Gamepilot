export default function Icon({ name, className = '', style, label }) {
  return (
    <svg
      className={`icon ${className}`.trim()}
      style={style}
      aria-hidden={label ? undefined : 'true'}
      role={label ? 'img' : undefined}
      focusable="false"
    >
      {label ? <title>{label}</title> : null}
      <use href={`#i-${name}`} />
    </svg>
  );
}
