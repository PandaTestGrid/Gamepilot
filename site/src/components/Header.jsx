import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useDownload } from '../context/DownloadContext';
import Brand from './Brand';
import Icon from './Icon';

const LINKS = [
  { to: '/', label: '首页', end: true },
  { to: '/games', label: '游戏中心' },
  { to: '/guides', label: '游戏攻略' },
  { to: '/faq', label: '常见问题' },
  { to: '/business', label: '商务合作' }
];

export default function Header() {
  const openDownload = useDownload();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.documentElement.style.overflow = 'hidden';
    window.__lenis?.stop();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.documentElement.style.overflow = '';
      window.__lenis?.start();
    };
  }, [open]);

  const closeNav = () => setOpen(false);

  return (
    <header className={`site-header${scrolled || open ? ' is-scrolled' : ''}${open ? ' is-open' : ''}`} id="top">
      <div className="container header-inner">
        <Brand />

        <nav className={`nav${open ? ' is-open' : ''}`} id="site-nav" aria-label="主导航">
          {LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) => (isActive ? 'is-active' : undefined)}
              onClick={closeNav}
            >
              {link.label}
            </NavLink>
          ))}
          <div className="nav-mobile-actions">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => {
                closeNav();
                openDownload();
              }}
            >
              <Icon name="download" />
              免费下载
            </button>
            <Link className="btn btn-ghost" to="/guides/first-graph" onClick={closeNav}>
              快速上手
            </Link>
          </div>
        </nav>

        <div className="header-actions">
          <Link className="header-search" to="/games?focus=search" aria-label="搜索游戏">
            <Icon name="search" />
          </Link>
          <Link className="header-link" to="/guides/first-graph">
            快速上手
          </Link>
          <Link className="btn btn-primary btn-sm" to="/download">
            <Icon name="download" />
            免费下载
          </Link>
          <button
            className="nav-toggle"
            type="button"
            aria-expanded={open}
            aria-controls="site-nav"
            aria-label={open ? '关闭菜单' : '打开菜单'}
            onClick={() => setOpen((value) => !value)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
      </div>
    </header>
  );
}
