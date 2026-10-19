import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { FEATURED_GAMES, GAMES, GAME_CATEGORIES, GAMES_PER_PAGE, UPCOMING_GAMES } from '../data/games';
import GameCard from '../components/GameCard';
import GamePoster from '../components/GamePoster';
import HotGames from '../components/HotGames';
import Icon from '../components/Icon';
import PageHead from '../components/PageHead';
import Pagination from '../components/Pagination';
import { useDownload } from '../context/DownloadContext';
import usePageMeta from '../hooks/usePageMeta';

const SORTS = [
  { value: 'popular', label: '综合热度' },
  { value: 'rating', label: '评分优先' },
  { value: 'az', label: '名称排序' }
];

export default function GamesPage() {
  usePageMeta('游戏中心', 'GamePilot 游戏中心：浏览可自动化的演示游戏，按分类筛选、搜索，查看每款游戏的状态图与识别方案。');
  const [params, setParams] = useSearchParams();
  const openDownload = useDownload();
  const reduced = useReducedMotion();
  const searchRef = useRef(null);
  const [query, setQuery] = useState(params.get('q') || '');
  const [slide, setSlide] = useState(0);
  const [paused, setPaused] = useState(false);

  const rawPage = Number.parseInt(params.get('page') || '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const category = GAME_CATEGORIES.includes(params.get('category')) ? params.get('category') : '全部';
  const q = (params.get('q') || '').trim();
  const sort = SORTS.some((item) => item.value === params.get('sort')) ? params.get('sort') : 'popular';

  const filtered = useMemo(() => {
    const keyword = q.toLowerCase();
    const list = GAMES.filter((game) => {
      if (category !== '全部' && game.category !== category) return false;
      if (!keyword) return true;
      return [game.title, game.en, game.genre, game.category, ...game.tags]
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    });
    return list.sort((a, b) => {
      if (sort === 'rating') return b.rating - a.rating;
      if (sort === 'az') return a.title.localeCompare(b.title, 'zh-Hans-CN');
      return b.popularity - a.popularity;
    });
  }, [category, q, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / GAMES_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * GAMES_PER_PAGE, currentPage * GAMES_PER_PAGE);
  const hot = useMemo(() => [...GAMES].sort((a, b) => b.popularity - a.popularity).slice(0, 5), []);
  const featured = FEATURED_GAMES.length ? FEATURED_GAMES : GAMES.slice(0, 3);
  const current = featured[slide % featured.length];

  useEffect(() => {
    setQuery(q);
  }, [q]);

  useEffect(() => {
    setSlide(0);
  }, [category, q]);

  useEffect(() => {
    if (params.get('focus') !== 'search') return;
    searchRef.current?.focus();
    const next = new URLSearchParams(params);
    next.delete('focus');
    setParams(next, { replace: true });
  }, [params, setParams]);

  useEffect(() => {
    if (paused || reduced || featured.length < 2) return undefined;
    const timer = window.setInterval(() => {
      setSlide((value) => (value + 1) % featured.length);
    }, 5600);
    return () => window.clearInterval(timer);
  }, [paused, reduced, featured.length]);

  function update(patch) {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([key, value]) => {
      if (value === null || value === undefined || value === '') next.delete(key);
      else next.set(key, String(value));
    });
    setParams(next);
  }

  function submitSearch(event) {
    event.preventDefault();
    update({ q: query.trim(), page: null });
  }

  function goPage(nextPage) {
    update({ page: nextPage <= 1 ? null : nextPage });
    window.setTimeout(() => {
      const anchor = document.querySelector('.gc-toolbar') || document.getElementById('game-grid');
      if (!anchor) return;
      const top = anchor.getBoundingClientRect().top + window.scrollY - 96;
      if (window.__lenis) window.__lenis.scrollTo(top, { duration: 0.9 });
      else window.scrollTo({ top, behavior: 'smooth' });
    }, 30);
  }

  function reset() {
    setQuery('');
    setParams(new URLSearchParams());
  }

  return (
    <div className="page-container">
      <div className="container">
        <PageHead
        eyebrow="GAME LIBRARY · 游戏中心"
        title="找到下一款，能交给状态机的游戏"
        lead="按分类、热度或关键词浏览演示场景。每一款都附有状态图、识别模板与可自动化的日常流程，点进详情可以看它怎么跑。"
      >
        <form className="gc-search" onSubmit={submitSearch} role="search">
          <Icon name="search" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索游戏名称、类型或玩法，例如：每日、塔防、开放世界"
            aria-label="搜索游戏"
          />
          <button className="btn btn-primary btn-sm" type="submit">
            搜索
          </button>
        </form>
        <div className="gc-quickstats">
          <span>
            <strong>{GAMES.length}</strong> 款演示场景
          </span>
          <span>
            <strong>{GAME_CATEGORIES.length - 1}</strong> 个分类
          </span>
          <span>
            <strong>100%</strong> 本地识别
          </span>
        </div>
        </PageHead>
      </div>

      <div className="container">
        <section
          className="gc-feature"
          aria-label="焦点游戏"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <div className="gc-banner">
            <AnimatePresence mode="wait">
              <motion.div
                className="gc-slide"
                key={current.slug}
                initial={reduced ? false : { opacity: 0, scale: 1.015 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduced ? undefined : { opacity: 0 }}
                transition={{ duration: 0.55, ease: 'easeOut' }}
              >
                <div className="gc-slide-art">
                  <GamePoster game={current} />
                </div>
                <div className="gc-slide-copy">
                  <span className="gc-slide-badge">
                    <i className="dot live" />
                    {current.status === '预约中' ? '新游预约' : '可自动化场景'}
                  </span>
                  <span className="gc-slide-en">{current.en}</span>
                  <h2>{current.title}</h2>
                  <p>{current.tagline}</p>
                  <div className="gc-slide-tags">
                    <span>{current.genre}</span>
                    <span>{current.category}</span>
                    <span>{current.heat} 人在玩</span>
                  </div>
                  <div className="gc-slide-actions">
                    <Link className="btn btn-primary btn-sm" to={`/games/${current.slug}`}>
                      查看详情
                      <Icon name="arrow" />
                    </Link>
                    <button className="btn btn-glass btn-sm" type="button" onClick={openDownload}>
                      用 GamePilot 运行
                    </button>
                  </div>
                </div>
              </motion.div>
            </AnimatePresence>
            <div className="gc-dots" role="tablist" aria-label="焦点游戏切换">
              {featured.map((game, index) => (
                <button
                  key={game.slug}
                  type="button"
                  role="tab"
                  aria-selected={index === slide % featured.length}
                  aria-label={game.title}
                  className={index === slide % featured.length ? 'is-active' : undefined}
                  onClick={() => setSlide(index)}
                />
              ))}
            </div>
          </div>

          <aside className="gc-hotlist" aria-label="热门推荐">
            <div className="gc-hotlist-head">
              <strong>热门推荐</strong>
              <span>实时热度</span>
            </div>
            {hot.slice(0, 4).map((game) => (
              <Link className="gc-hot-row" to={`/games/${game.slug}`} key={game.slug}>
                <span className="gc-hot-cover">
                  <GamePoster game={game} />
                </span>
                <span className="gc-hot-copy">
                  <strong>{game.title}</strong>
                  <small>{game.genre}</small>
                  <span className="gc-hot-rating">
                    <Icon name="star" />
                    {game.rating.toFixed(1)}
                    <em>{game.heat}</em>
                  </span>
                </span>
                <Icon name="chevron" className="gc-hot-arrow" />
              </Link>
            ))}
          </aside>
        </section>

        {UPCOMING_GAMES.length ? (
          <section className="gc-upcoming" aria-labelledby="upcoming-title">
            <div className="gc-section-head">
              <h2 id="upcoming-title">新游预约</h2>
              <span>提前把状态图准备好</span>
            </div>
            <div className="gc-upcoming-row">
              {UPCOMING_GAMES.map((game) => (
                <Link className="gc-upcoming-card" to={`/games/${game.slug}`} key={game.slug}>
                  <span className="gc-upcoming-cover">
                    <GamePoster game={game} />
                  </span>
                  <span>
                    <strong>{game.title}</strong>
                    <small>{game.genre}</small>
                    <em>预约 {game.heat}</em>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        <HotGames />

        <div className="gc-body">
          <div className="gc-main">
            <div className="gc-toolbar">
              <div>
                <strong>{category === '全部' ? '全部游戏' : category}</strong>
                <span>
                  {filtered.length} 款{pageCount > 1 ? ` · 第 ${currentPage}/${pageCount} 页` : ''}
                </span>
              </div>
              <label className="gc-sort">
                排序
                <select value={sort} onChange={(event) => update({ sort: event.target.value, page: null })}>
                  {SORTS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {visible.length ? (
              <div className="game-grid gc-grid" id="game-grid">
                {visible.map((game, index) => (
                  <GameCard key={game.slug} game={game} index={index} height={380} />
                ))}
              </div>
            ) : (
              <div className="gc-empty">
                <span className="gc-empty-icon">
                  <Icon name="search" />
                </span>
                <h3>没有匹配的游戏</h3>
                <p>换一个关键词，或者清除筛选条件再试试。</p>
                <button className="btn btn-ghost btn-sm" type="button" onClick={reset}>
                  清除筛选
                </button>
              </div>
            )}

            <Pagination page={currentPage} total={pageCount} onChange={goPage} />
          </div>

          <aside className="gc-side">
            <section className="gc-panel" aria-labelledby="category-title">
              <h2 id="category-title">游戏分类</h2>
              <div className="gc-cats">
                {GAME_CATEGORIES.map((item) => {
                  const count = item === '全部' ? GAMES.length : GAMES.filter((game) => game.category === item).length;
                  return (
                    <button
                      key={item}
                      type="button"
                      className={category === item ? 'is-active' : undefined}
                      onClick={() => update({ category: item === '全部' ? null : item, page: null })}
                    >
                      <span>{item}</span>
                      <em>{count}</em>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="gc-panel" aria-labelledby="rank-title">
              <h2 id="rank-title">下载排行</h2>
              <div className="gc-rank">
                {hot.map((game, index) => (
                  <Link to={`/games/${game.slug}`} key={game.slug}>
                    <span className={`gc-rank-no${index < 3 ? ' is-top' : ''}`}>{index + 1}</span>
                    <span className="gc-rank-cover">
                      <GamePoster game={game} />
                    </span>
                    <span className="gc-rank-copy">
                      <strong>{game.title}</strong>
                      <small>{game.category}</small>
                    </span>
                    <em>{game.rating.toFixed(1)}</em>
                  </Link>
                ))}
              </div>
            </section>

            <section className="gc-side-card">
              <span className="gc-side-kicker">MISSING A GAME?</span>
              <h2>你的游戏不在这里？</h2>
              <p>GamePilot 不绑定游戏名单。框选界面、录一遍操作、连成状态图，任何游戏都能接入。</p>
              <Link className="text-link" to="/guides/first-graph">
                看接入教程
                <Icon name="arrow" />
              </Link>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
