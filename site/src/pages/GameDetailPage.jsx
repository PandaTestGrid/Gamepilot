import { Link, useParams } from 'react-router-dom';
import { motion, useReducedMotion } from 'motion/react';
import { getGame, getRelatedGames } from '../data/games';
import GamePoster from '../components/GamePoster';
import Icon from '../components/Icon';
import { useDownload } from '../context/DownloadContext';
import usePageMeta from '../hooks/usePageMeta';
import NotFoundPage from './NotFoundPage';

export default function GameDetailPage() {
  const { slug } = useParams();
  const game = getGame(slug);
  const reduced = useReducedMotion();
  const openDownload = useDownload();
  usePageMeta(game ? `${game.title} · 自动化场景` : '游戏详情', game?.summary);

  if (!game) return <NotFoundPage />;

  const related = getRelatedGames(game, 3);
  const isUpcoming = game.status === '预约中';

  return (
    <article className="gd-page">
      <div className="gd-hero">
        <div className="gd-hero-art" aria-hidden="true">
          <GamePoster game={game} />
        </div>
        <div className="gd-hero-shade" aria-hidden="true" />
        <div className="container gd-hero-inner">
          <nav className="breadcrumb" aria-label="面包屑">
            <Link to="/">首页</Link>
            <span>/</span>
            <Link to="/games">游戏中心</Link>
            <span>/</span>
            <em>{game.title}</em>
          </nav>

          <div className="gd-hero-grid">
            <motion.div
              className="gd-cover"
              initial={reduced ? false : { opacity: 0, y: 24, rotate: -1.5 }}
              animate={{ opacity: 1, y: 0, rotate: 0 }}
              transition={{ duration: 0.7, ease: [0.22, 0.61, 0.36, 1] }}
            >
              <GamePoster game={game} />
            </motion.div>
            <div className="gd-info">
              <div className="gd-badges">
                <span className={`gd-status${isUpcoming ? ' is-soon' : ''}`}>
                  <i className="dot live" />
                  {isUpcoming ? '预约中' : '可自动化'}
                </span>
                <span>{game.genre}</span>
                <span>{game.category}</span>
              </div>
              <span className="gd-en">{game.en}</span>
              <h1>{game.title}</h1>
              <p className="gd-tagline">{game.tagline}</p>
              <div className="gd-meta">
                <span className="gd-score">
                  <Icon name="star" />
                  <strong>{game.rating.toFixed(1)}</strong>
                  <em>/ 5.0</em>
                </span>
                <span>{game.heat} 人在玩</span>
                <span>{game.size}</span>
              </div>
              <div className="gd-actions">
                <button className="btn btn-primary" type="button" onClick={openDownload}>
                  <Icon name="download" />
                  {isUpcoming ? '预约并获取演示包' : '用 GamePilot 运行'}
                </button>
                <Link className="btn btn-glass" to="/guides/first-graph">
                  三分钟接入
                  <Icon name="arrow" />
                </Link>
              </div>
              <p className="gd-disclaimer">
                <Icon name="shield" />
                演示场景，不代表官方合作或已适配；实际识别效果取决于游戏画面与设备。
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="container gd-body">
        <div className="gd-main">
          <section className="gd-section">
            <span className="gd-kicker">ABOUT THIS SCENE</span>
            <h2>这个场景能自动化什么</h2>
            <p className="gd-lead">{game.description}</p>
            <ul className="gd-highlights">
              {game.highlights.map((item) => (
                <li key={item}>
                  <Icon name="check" />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section className="gd-section">
            <span className="gd-kicker">AUTOMATION RECIPES</span>
            <h2>可运行的流程</h2>
            <div className="gd-scenarios">
              {game.scenarios.map((scenario, index) => (
                <div className="gd-scenario" key={scenario.name}>
                  <span className="gd-scenario-no">{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <h3>{scenario.name}</h3>
                    <p>{scenario.desc}</p>
                    <ol>
                      {scenario.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="gd-section">
            <span className="gd-kicker">RECOGNITION VIEW</span>
            <h2>画面与识别</h2>
            <p className="gd-lead">
              识别器只看画面：模板匹配确认「现在是哪个界面」，颜色与区域识别确认「按钮是否可用」。
              下面是同一个场景的三张识别示意。
            </p>
            <div className="gd-shots">
              {[
                { label: '状态识别 · 主城', box: 'a' },
                { label: '模板匹配 · 副本入口', box: 'b' },
                { label: '动作执行 · 点击确认', box: 'c' }
              ].map((shot) => (
                <figure className={`gd-shot gd-shot-${shot.box}`} key={shot.label}>
                  <GamePoster game={game} />
                  <span className="gd-shot-box" />
                  <span className="gd-shot-hud">
                    <i className="dot live" />
                    {shot.label}
                  </span>
                  <figcaption>{shot.label}</figcaption>
                </figure>
              ))}
            </div>
          </section>

          <section className="gd-section">
            <span className="gd-kicker">CONFIG SNAPSHOT</span>
            <h2>识别配置</h2>
            <div className="gd-config">
              <div>
                <span>状态节点</span>
                <strong>{game.automation.nodes}</strong>
              </div>
              <div>
                <span>识别模板</span>
                <strong>{game.automation.templates}</strong>
              </div>
              <div>
                <span>恢复边</span>
                <strong>{game.automation.recoveries}</strong>
              </div>
              <div>
                <span>参考分辨率</span>
                <strong>{game.automation.resolution}</strong>
              </div>
            </div>
            <p className="gd-config-note">
              以上为演示配置规模，不代表真实项目文件；接入正式工程时，以 workspace 里的 graph.json 与模板目录为准。
            </p>
          </section>
        </div>

        <aside className="gd-side">
          <section className="gd-panel">
            <h2>运行信息</h2>
            <dl className="gd-facts">
              <div>
                <dt>支持平台</dt>
                <dd>{game.platforms.join(' / ')}</dd>
              </div>
              <div>
                <dt>安装大小</dt>
                <dd>{game.size}</dd>
              </div>
              <div>
                <dt>场景状态</dt>
                <dd>{game.status}</dd>
              </div>
              <div>
                <dt>参考分辨率</dt>
                <dd>{game.automation.resolution}</dd>
              </div>
              <div>
                <dt>识别方式</dt>
                <dd>模板 / 颜色 / OCR</dd>
              </div>
            </dl>
            <button className="btn btn-soft btn-sm" type="button" onClick={openDownload}>
              获取演示配置
            </button>
          </section>

          <section className="gd-panel">
            <h2>相关场景</h2>
            <div className="gd-related">
              {related.map((item) => (
                <Link to={`/games/${item.slug}`} key={item.slug}>
                  <span className="gd-related-cover">
                    <GamePoster game={item} />
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.genre}</small>
                  </span>
                  <Icon name="chevron" />
                </Link>
              ))}
            </div>
            <Link className="text-link" to="/games">
              返回游戏中心
              <Icon name="arrow" />
            </Link>
          </section>

          <section className="gd-side-note">
            <Icon name="spark" />
            <p>
              场景封面为原创视觉演示。若你有官方授权素材，可在
              <code> src/data/games.js </code>
              里给对应游戏加一个 <code>cover</code> 字段直接替换。
            </p>
          </section>
        </aside>
      </div>
    </article>
  );
}
