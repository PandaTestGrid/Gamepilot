import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform
} from 'motion/react';
import BlurText from '../reactbits/BlurText';
import { GAMES, getGame } from '../data/games';
import GamePoster from './GamePoster';
import Icon from './Icon';
import Reveal from './Reveal';

const SHOWCASE_SLUGS = [
  'abyss-echo',
  'neon-velocity',
  'orbital-front',
  'crown-war',
  'frost-realm',
  'bloom-story'
];

const SHOWCASE_GAMES = SHOWCASE_SLUGS.map((slug) => getGame(slug)).filter(Boolean);

function ShowcaseCard({ game, index, progress, parallax }) {
  const drift = useTransform(progress, [0, 1], [0, index % 2 === 0 ? 14 : -10]);

  return (
    <motion.div className="showcase-card-wrap" style={parallax ? { y: drift } : undefined}>
      <Link className="showcase-card" to={`/games/${game.slug}`} aria-label={`${game.title} 自动化场景`}>
        <GamePoster game={game} />
        <span className="showcase-card-shade" aria-hidden="true" />
        <div className="showcase-card-top">
          <span className="showcase-num">{String(index + 1).padStart(2, '0')}</span>
          <span className={`showcase-status ${game.status === '已上线' ? 'is-live' : ''}`}>
            <span className="dot" />
            {game.status}
          </span>
        </div>
        <div className="showcase-card-copy">
          <span className="showcase-en">{game.en}</span>
          <h3>{game.title}</h3>
          <p>{game.tagline}</p>
          <div className="showcase-meta">
            <span className="showcase-score">★ {game.rating.toFixed(1)}</span>
            <span>{game.genre}</span>
            <span>{game.category}</span>
          </div>
          <span className="showcase-card-link">
            查看自动化场景
            <Icon name="arrow" />
          </span>
        </div>
      </Link>
    </motion.div>
  );
}

export default function GameShowcase() {
  const sectionRef = useRef(null);
  const trackRef = useRef(null);
  const reduced = useReducedMotion();
  const [distance, setDistance] = useState(0);
  const [pinned, setPinned] = useState(false);
  const [active, setActive] = useState(0);

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start start', 'end end']
  });
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30, mass: 0.4 });
  const x = useTransform(progress, [0, 1], [0, -distance]);
  const ghostX = useTransform(progress, [0, 1], [0, 190]);
  const glowY = useTransform(progress, [0, 1], [-40, 130]);
  const railScale = useTransform(progress, [0, 1], [0.015, 1]);

  useEffect(() => {
    function measure() {
      const compact = window.innerWidth <= 980;
      const isPinned = !compact && !reduced;
      setPinned(isPinned);

      const track = trackRef.current;
      if (!track || !isPinned) {
        setDistance(0);
        return;
      }

      setDistance(Math.max(0, track.scrollWidth - window.innerWidth + 2));
    }

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [reduced]);

  useMotionValueEvent(progress, 'change', (value) => {
    const next = Math.min(SHOWCASE_GAMES.length - 1, Math.max(0, Math.round(value * (SHOWCASE_GAMES.length - 1))));
    setActive((current) => (current === next ? current : next));
  });

  return (
    <>
      <section
        ref={sectionRef}
        className={`showcase ${pinned ? 'is-pinned' : 'is-flat'}`}
        aria-labelledby="showcase-title"
        style={pinned ? { height: `calc(100vh + ${distance}px)` } : undefined}
      >
        <div className="showcase-sticky">
          <div className="showcase-bg" aria-hidden="true">
            <motion.span className="showcase-glow" style={pinned ? { y: glowY } : undefined} />
            <motion.span className="showcase-ghost" style={pinned ? { x: ghostX } : undefined}>
              GAME LIBRARY
            </motion.span>
            <span className="showcase-grid" />
          </div>

          <div className="showcase-head">
            <Reveal as="p" className="eyebrow">
              Play on desktop · 游戏场景
            </Reveal>
            <h2 id="showcase-title">
              <BlurText as="span" text="把电脑，变成你的" animateBy="chars" delay={20} />
              <br />
              <span className="showcase-title-grad">
                <BlurText as="span" text="第二个游戏主机" animateBy="chars" delay={22} startDelay={0.26} />
              </span>
            </h2>
            <Reveal as="p" className="showcase-sub" delay={0.1}>
              手机、模拟器、iPhone、桌面窗口 —— 同一套识别引擎，同一张状态图。
              一次配置，随时接着玩。
            </Reveal>
            <Reveal className="showcase-actions" delay={0.18}>
              <Link className="btn btn-glow" to="/games">
                浏览全部 {GAMES.length} 款场景
                <Icon name="arrow" />
              </Link>
              <span className="showcase-actions-note">横滑 / 滚轮浏览 · 点击进入详情</span>
            </Reveal>
          </div>

          <div className="showcase-viewport">
            <motion.div
              ref={trackRef}
              className="showcase-track"
              style={pinned ? { x } : undefined}
            >
              {SHOWCASE_GAMES.map((game, index) => (
                <ShowcaseCard
                  key={game.slug}
                  game={game}
                  index={index}
                  progress={progress}
                  parallax={pinned}
                />
              ))}

              <div className="showcase-card-wrap">
                <Link className="showcase-card showcase-card--more" to="/games">
                  <span className="showcase-more-label">MORE SCENES</span>
                  <strong>{GAMES.length}</strong>
                  <span className="showcase-more-title">款可运行场景</span>
                  <p>每一款都拆好了状态图、识别模板和恢复边。</p>
                  <span className="showcase-card-link">
                    打开游戏中心
                    <Icon name="arrow" />
                  </span>
                </Link>
              </div>
            </motion.div>
          </div>

          <div className="showcase-hud" aria-hidden="true">
            <div className="container showcase-hud-inner">
              <span className="showcase-hud-label">SCROLL TO EXPLORE</span>
              <span className="showcase-rail">
                <motion.span className="showcase-rail-fill" style={{ scaleX: railScale }} />
              </span>
              <span className="showcase-hud-count">
                {String(active + 1).padStart(2, '0')} <em>/ {String(SHOWCASE_GAMES.length).padStart(2, '0')}</em>
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="showcase-after" aria-label="全部游戏场景">
        <div className="container">
          <div className="showcase-icons-head">
            <span className="eyebrow">全部场景 · ALL SCENES</span>
            <span className="showcase-icons-hint">点一个图标，看它怎么被拆成状态图</span>
          </div>

          <div className="showcase-icons">
            {GAMES.map((game, index) => (
              <Reveal className="showcase-icon" key={game.slug} delay={Math.min(index * 0.035, 0.3)} amount={0.2}>
                <Link to={`/games/${game.slug}`} aria-label={game.title}>
                  <span className="showcase-icon-thumb">
                    <GamePoster game={game} />
                  </span>
                  <span className="showcase-icon-name">{game.title}</span>
                </Link>
              </Reveal>
            ))}
          </div>

          <div className="showcase-manifesto">
            <Reveal as="p" className="eyebrow">
              Beyond macros · 不止宏
            </Reveal>
            <h3>
              更好玩的自动化，
              <span className="showcase-title-grad">像玩游戏一样构建它</span>
            </h3>
            <p>
              框界面、连状态、录一遍操作。键鼠、多开、恢复边、变量循环 ——
              每一个细节都能解释，也都能改。
            </p>
            <Link className="btn btn-glow" to="/guides">
              更多教程
              <Icon name="arrow" />
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
