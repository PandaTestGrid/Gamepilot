import { useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';
import { HOT_GAMES, HOT_ICONS, HOT_GALLERY } from '../data/hotGames';

const hotUrl = (file) => `${import.meta.env.BASE_URL}hot/${file}`;

export default function HotGames() {
  const [activeId, setActiveId] = useState(HOT_GALLERY[0].id);
  const active = HOT_GALLERY.find((game) => game.id === activeId) || HOT_GALLERY[0];

  return (
    <section className="hot-games" aria-labelledby="hot-games-title">
      <div className="gc-section-head">
        <h2 id="hot-games-title">热门游戏</h2>
        <span>本周热玩 · 夜神官网素材</span>
      </div>

      <div className="hot-games-grid">
        {HOT_GAMES.map((game) => (
          <Link
            className="hot-game"
            to={`/games/hot/${game.id}`}
            key={game.id}
            style={{ '--hot-accent': game.accent }}
            title={`${game.title} · 游戏档案与工作流`}
            aria-label={`查看${game.title}游戏档案与工作流`}
          >
            <span className="hot-game-media">
              <img src={hotUrl(game.cover)} alt={`${game.title} 游戏封面`} loading="lazy" width="272" height="342" />
              <span className="hot-game-tag">{game.genre}</span>
              <span className="hot-game-cta">
                查看游戏档案
                <Icon name="arrow" />
              </span>
              <span className="hot-game-open" aria-hidden="true">
                <Icon name="arrow" />
              </span>
            </span>
          </Link>
        ))}
      </div>

      <div className="hot-icons-row">
        <span className="hot-icons-label">更多热门</span>
        <div className="hot-icons" aria-hidden="true">
          {HOT_ICONS.map((file) => (
            <img src={hotUrl(file)} alt="" key={file} loading="lazy" width="64" height="64" />
          ))}
        </div>
        <a className="hot-more-link" href="#game-grid">
          查看全部游戏
          <Icon name="arrow" />
        </a>
      </div>

      <div className="hot-gallery">
        <div className="hot-gallery-head">
          <div className="hot-gallery-intro">
            <span>OFFICIAL SCREENS · 官方画面</span>
            <h3>{active.name} · 夜神官网截图</h3>
          </div>

          <div className="hot-gallery-tabs" role="tablist" aria-label="按游戏查看官方画面">
            {HOT_GALLERY.map((game) => {
              const selected = game.id === active.id;
              return (
                <button
                  className={`hot-gallery-tab${selected ? ' is-active' : ''}`}
                  type="button"
                  role="tab"
                  id={`hot-tab-${game.id}`}
                  aria-selected={selected}
                  aria-controls="hot-gallery-panel"
                  key={game.id}
                  onClick={() => setActiveId(game.id)}
                >
                  <img src={hotUrl(game.icon)} alt="" width="22" height="22" loading="lazy" />
                  <span>{game.tab}</span>
                </button>
              );
            })}
          </div>

          <a href={active.source} target="_blank" rel="noreferrer">
            查看来源
            <Icon name="arrow" />
          </a>
        </div>

        <div
          className={`hot-gallery-track is-${active.orientation}`}
          id="hot-gallery-panel"
          role="tabpanel"
          aria-labelledby={`hot-tab-${active.id}`}
          key={active.id}
        >
          {active.shots.map((file, index) => (
            <a
              className="hot-shot"
              href={hotUrl(file)}
              target="_blank"
              rel="noreferrer"
              key={file}
              aria-label={`查看${active.name}官方画面 ${index + 1}，在新窗口打开原图`}
            >
              <img
                src={hotUrl(file)}
                alt={`${active.name}官方画面 ${index + 1}`}
                loading="lazy"
                width={active.orientation === 'portrait' ? 1080 : 1280}
                height={active.orientation === 'portrait' ? 1920 : 720}
              />
            </a>
          ))}
        </div>

        <p className="hot-gallery-note">
          {active.name} · {active.shots.length} 张官方画面 · 点击查看原图
        </p>
      </div>

      <p className="hot-disclaimer">
        封面与截图来自夜神模拟器官网的游戏页，仅作视觉展示；不代表官方合作或已适配名单，实际效果取决于游戏画面与设备。
      </p>
    </section>
  );
}
