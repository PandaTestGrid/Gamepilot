import { useId } from 'react';
import { Link, useLocation } from 'react-router-dom';

export default function Brand({ compact = false }) {
  const location = useLocation();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradientA = `brand-a-${uid}`;
  const gradientB = `brand-b-${uid}`;

  function handleClick() {
    if (location.pathname !== '/' || location.hash) return;
    if (window.__lenis) window.__lenis.scrollTo(0, { duration: 0.8 });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <Link className="brand" to="/" aria-label="GamePilot 首页" onClick={handleClick}>
      <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <linearGradient id={gradientA} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#c4b5fd" />
            <stop offset="1" stopColor="#7c5cff" />
          </linearGradient>
          <linearGradient id={gradientB} x1="1" y1="0" x2="0" y2="1">
            <stop stopColor="#67e8f9" />
            <stop offset="1" stopColor="#5b8def" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="16" fill="#0e0b32" />
        <rect x="1" y="1" width="62" height="62" rx="15" fill="none" stroke="#fff" strokeOpacity=".14" />
        <path
          d="M41 20a14.5 14.5 0 1 0 0 24"
          fill="none"
          stroke={`url(#${gradientA})`}
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M23 44a14.5 14.5 0 0 1 0-24"
          fill="none"
          stroke={`url(#${gradientB})`}
          strokeWidth="6"
          strokeLinecap="round"
        />
        <circle cx="32" cy="32" r="4.4" fill="#ffd15c" />
      </svg>
      <span className="brand-text">
        <strong>GamePilot</strong>
        {compact ? null : <small>游戏自动化工作台</small>}
      </span>
    </Link>
  );
}
