import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { motion, useReducedMotion } from 'motion/react';
import Lenis from 'lenis';
import ClickSpark from './reactbits/ClickSpark';
import DownloadDialog from './components/DownloadDialog';
import Footer from './components/Footer';
import Header from './components/Header';
import IconSprite from './components/IconSprite';
import ScrollProgress from './components/ScrollProgress';
import { DownloadContext } from './context/DownloadContext';

export default function Layout() {
  const [downloadOpen, setDownloadOpen] = useState(false);
  const reduced = useReducedMotion();
  const location = useLocation();
  const openDownload = useCallback(() => setDownloadOpen(true), []);
  const closeDownload = useCallback(() => setDownloadOpen(false), []);

  useEffect(() => {
    if (reduced) return undefined;
    const lenis = new Lenis({ lerp: 0.09, wheelMultiplier: 0.9, smoothWheel: true });
    window.__lenis = lenis;

    let frame = 0;
    const loop = (time) => {
      lenis.raf(time);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    const handleAnchor = (event) => {
      const anchor = event.target.closest?.('a[href^="#"]');
      if (!anchor) return;
      const hash = anchor.getAttribute('href');
      if (!hash || hash === '#') return;
      const target = document.querySelector(hash);
      if (!target) return;
      event.preventDefault();
      lenis.scrollTo(target, { offset: -76, duration: 1.15 });
      window.history.replaceState(null, '', `${location.pathname}${hash}`);
    };

    document.addEventListener('click', handleAnchor);

    return () => {
      document.removeEventListener('click', handleAnchor);
      cancelAnimationFrame(frame);
      lenis.destroy();
      if (window.__lenis === lenis) delete window.__lenis;
    };
  }, [reduced, location.pathname]);

  useEffect(() => {
    const { hash } = location;
    if (hash) {
      const timer = window.setTimeout(() => {
        const target = document.querySelector(hash);
        if (!target) return;
        const top = target.getBoundingClientRect().top + window.scrollY - 76;
        if (window.__lenis) window.__lenis.scrollTo(top, { immediate: true });
        else window.scrollTo(0, top);
      }, 60);
      return () => window.clearTimeout(timer);
    }
    if (window.__lenis) window.__lenis.scrollTo(0, { immediate: true });
    else window.scrollTo(0, 0);
    return undefined;
  }, [location.pathname, location.hash]);

  return (
    <DownloadContext.Provider value={openDownload}>
      <IconSprite />
      <ScrollProgress />
      <Header />
      <main id="main">
        <motion.div
          className="route-view"
          key={location.pathname}
          initial={reduced ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 0.61, 0.36, 1] }}
        >
          <Outlet />
        </motion.div>
      </main>
      <Footer />
      <DownloadDialog open={downloadOpen} onClose={closeDownload} />
      <ClickSpark />
    </DownloadContext.Provider>
  );
}
