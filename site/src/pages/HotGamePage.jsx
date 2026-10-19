import { Link, useParams } from 'react-router-dom';
import Icon from '../components/Icon';
import { useDownload } from '../context/DownloadContext';
import { HOT_GAMES, HOT_GALLERY, HOT_GAME_PAGES } from '../data/hotGames';
import usePageMeta from '../hooks/usePageMeta';
import NotFoundPage from './NotFoundPage';

const hotUrl = (file) => `${import.meta.env.BASE_URL}hot/${file}`;

export default function HotGamePage() {
  const { id } = useParams();
  const game = HOT_GAMES.find((item) => item.id === id);
  const page = HOT_GAME_PAGES[id];
  const gallery = HOT_GALLERY.find((item) => item.id === id);
  const openDownload = useDownload();

  usePageMeta(
    game ? `${game.title} · 游戏档案` : '游戏档案',
    page?.tagline ?? '夜神官网素材与录制工作流分享'
  );

  if (!game || !page) return <NotFoundPage />;

  const cover = hotUrl(game.cover);
  const shots = gallery?.shots ?? [];
  const workflows = page.workflows ?? [];
  const slots = page.slots ?? [];

  return (
    <article className="hg-page">
      <section className="hg-hero">
        <div
          className="hg-hero-bg"
          style={{ backgroundImage: `url("${cover}")` }}
          aria-hidden="true"
        />
        <div className="hg-hero-scrim" aria-hidden="true" />

        <div className="container hg-hero-inner">
          <nav className="breadcrumb" aria-label="面包屑">
            <Link to="/">首页</Link>
            <span>/</span>
            <Link to="/games">游戏中心</Link>
            <span>/</span>
            <em>{game.title}</em>
          </nav>

          <div className="hg-hero-grid">
            <div className="hg-poster">
              <img src={cover} alt={`${game.title} 游戏封面`} width="272" height="342" />
              <span className="hg-poster-label">GAME ARCHIVE</span>
            </div>

            <div className="hg-copy">
              <span className="hg-kicker">GAME ARCHIVE · 游戏档案</span>
              <h1>{game.title}</h1>
              <span className="hg-en">{game.en}</span>
              <p className="hg-tagline">{page.tagline}</p>

              <div className="hg-badges">
                <span className="hg-badge-live">
                  <i className="dot live" />
                  工作流分享筹备中
                </span>
                <span>{game.genre}</span>
                <span>夜神官网素材</span>
              </div>

              <div className="hg-actions">
                <button className="btn btn-primary" type="button" onClick={openDownload}>
                  <Icon name="download" />
                  申请内测，体验工作流
                </button>
                <a className="btn btn-glass" href="#workflows">
                  查看工作流
                  <Icon name="arrow" />
                </a>
              </div>

              <p className="hg-note">
                <Icon name="shield" />
                本页素材来自夜神模拟器官网，仅作视觉展示；不声明官方合作或已适配，实际流程以游戏版本为准。
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="container hg-body">
        <aside className="hg-side">
          <nav className="hg-nav" aria-label="页内导航">
            <span>本页导航</span>
            <a href="#about">游戏档案</a>
            <a href="#screens">官方画面</a>
            <a href="#workflows">录制的工作流</a>
            <a href="#info">素材与说明</a>
          </nav>

          <div className="hg-side-card">
            <span className="hg-side-icon">
              <Icon name="record" />
            </span>
            <h3>这里会放什么</h3>
            <p>每款游戏录制好的工作流、步骤、适用版本和提交者，后续都会沉淀在这一页。</p>
            <button className="btn btn-soft btn-sm" type="button" onClick={openDownload}>
              申请内测
            </button>
            <a className="hg-side-link" href={gallery?.source ?? 'https://www.yeshen.com/'} target="_blank" rel="noreferrer">
              夜神游戏详情页
              <Icon name="arrow" />
            </a>
          </div>
        </aside>

        <div className="hg-main">
          <section id="about" className="hg-section">
            <span className="hg-kicker">ABOUT THIS GAME</span>
            <h2>先把重复的部分看清楚</h2>
            <p className="hg-lead">{page.description}</p>

            <ul className="hg-points">
              {page.highlights.map((item) => (
                <li key={item}>
                  <Icon name="check" />
                  {item}
                </li>
              ))}
            </ul>

            <div className="hg-facts">
              <div>
                <span>素材</span>
                <strong>官方封面 + {shots.length} 张画面</strong>
              </div>
              <div>
                <span>分享</span>
                <strong>内测用户录制</strong>
              </div>
              <div>
                <span>类别</span>
                <strong>{game.genre}</strong>
              </div>
            </div>
          </section>

          <section id="screens" className="hg-section">
            <div className="hg-section-head">
              <div>
                <span className="hg-kicker">OFFICIAL SCREENS · 官方画面</span>
                <h2>{game.title} 的游戏画面</h2>
              </div>
              {gallery ? (
                <a className="hg-source-link" href={gallery.source} target="_blank" rel="noreferrer">
                  夜神详情页
                  <Icon name="arrow" />
                </a>
              ) : null}
            </div>

            <div
              className={`hg-shots is-${gallery?.orientation ?? 'landscape'}`}
              style={{ '--shot-ratio': gallery?.ratio }}
            >
              {shots.map((file, index) => (
                <a
                  className="hg-shot"
                  href={hotUrl(file)}
                  target="_blank"
                  rel="noreferrer"
                  key={file}
                  aria-label={`查看${game.title}官方画面 ${index + 1}，在新窗口打开原图`}
                >
                  <img
                    src={hotUrl(file)}
                    alt={`${game.title}官方画面 ${index + 1}`}
                    loading="lazy"
                    width={gallery?.shotWidth ?? 1280}
                    height={gallery?.shotHeight ?? 720}
                  />
                </a>
              ))}
            </div>

            <p className="hg-source">
              画面来自
              {' '}
              <a href={gallery?.source ?? 'https://www.yeshen.com/'} target="_blank" rel="noreferrer">
                夜神模拟器官网
              </a>
              ；版权归原游戏及发行方所有，仅作视觉展示。
            </p>
          </section>

          <section id="workflows" className="hg-section">
            <div className="hg-section-head">
              <div>
                <span className="hg-kicker">RECORDED WORKFLOWS · 工作流</span>
                <h2>录制的工作流</h2>
              </div>
              <span className="hg-coming">筹备中</span>
            </div>

            <p className="hg-lead">
              后面每一款游戏的日常、活动和多开流程都会放在这里。公开前由内测用户录制、审核，并标注适用版本与分辨率。
            </p>

            <div className="hg-workflow-grid">
              {workflows.length > 0
                ? workflows.map((workflow, index) => (
                    <article className="hg-wf-card is-published" key={workflow.title}>
                      <div className="hg-wf-top">
                        <span className="hg-wf-no">{String(index + 1).padStart(2, '0')}</span>
                        <span className="hg-wf-state is-live">
                          <i className="dot live" />
                          已发布
                        </span>
                      </div>
                      {workflow.kind ? <span className="hg-wf-label">{workflow.kind}</span> : null}
                      <h3>{workflow.title}</h3>
                      <p>{workflow.summary}</p>
                      <div className="hg-wf-foot">
                        <Icon name="record" />
                        {workflow.steps ?? 0} 步
                        {workflow.version ? ` · ${workflow.version}` : ''}
                        {workflow.resolution ? ` · ${workflow.resolution}` : ''}
                        {` · ${workflow.author ?? '社区'}`}
                      </div>
                    </article>
                  ))
                : slots.map((slot, index) => (
                    <article className="hg-wf-card is-soon" key={slot.id}>
                      <div className="hg-wf-top">
                        <span className="hg-wf-no">{String(index + 1).padStart(2, '0')}</span>
                        <span className="hg-wf-state">待发布</span>
                      </div>
                      <span className="hg-wf-label">{slot.label}</span>
                      <h3>{slot.title}</h3>
                      <p>{slot.desc}</p>
                      <div className="hg-wf-foot">
                        <Icon name="record" />
                        等待第一份录制
                      </div>
                    </article>
                  ))}
            </div>

            <div className="hg-share-panel">
              <div>
                <span className="hg-kicker">SHARE A WORKFLOW</span>
                <h3>把你录制的工作流放到这里</h3>
                <p>录制一次，附上适用版本、分辨率和步骤说明；审核后就会出现在这款游戏的页面里。</p>
              </div>
              <button className="btn btn-primary" type="button" onClick={openDownload}>
                <Icon name="record" />
                申请内测，参与投稿
              </button>
            </div>
          </section>

          <section id="info" className="hg-info">
            <div>
              <span className="hg-kicker">SOURCES & NOTES</span>
              <h2>素材与适配说明</h2>
            </div>
            <dl className="hg-info-list">
              <div>
                <dt>素材来源</dt>
                <dd>
                  <a href={gallery?.source ?? 'https://www.yeshen.com/'} target="_blank" rel="noreferrer">
                    夜神模拟器官网 · {game.title}详情页
                  </a>
                </dd>
              </div>
              <div>
                <dt>素材类型</dt>
                <dd>官方图标、4:5 封面、{shots.length} 张游戏画面</dd>
              </div>
              <div>
                <dt>自动化适配</dt>
                <dd>本页不声明已适配；工作流分享开放后由内测用户录制并审核</dd>
              </div>
              <div>
                <dt>版权归属</dt>
                <dd>原游戏及发行方所有，仅作视觉展示</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </article>
  );
}
