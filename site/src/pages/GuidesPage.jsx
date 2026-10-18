import { Link } from 'react-router-dom';
import { GUIDES } from '../data/guides';
import Icon from '../components/Icon';
import PageHead from '../components/PageHead';
import Reveal from '../components/Reveal';
import usePageMeta from '../hooks/usePageMeta';

export default function GuidesPage() {
  usePageMeta('游戏攻略', 'GamePilot 使用攻略：状态图、识别调参、设备接入、多开同步、变量与恢复边。');
  const [featured, ...rest] = GUIDES;

  return (
    <div className="page-container">
      <div className="container">
        <PageHead
        eyebrow="PLAYBOOK · 游戏攻略"
        title="把游戏接进来，只需要一张图"
        lead="从连接第一台设备，到多开、变量与恢复边。这里没有玄学参数，只有我们自己在游戏里踩过的坑。"
      >
        <div className="guides-topics">
          {['入门', '识别', '设备', '进阶', '稳定性'].map((topic) => (
            <span key={topic}>{topic}</span>
          ))}
        </div>
        </PageHead>
      </div>

      <div className="container guides-page">
        <Reveal>
          <Link className="guide-feature" to={`/guides/${featured.slug}`}>
            <div className="guide-feature-icon">
              <Icon name={featured.icon} />
            </div>
            <div className="guide-feature-copy">
              <span className="guides-kicker">START HERE · {featured.category}</span>
              <h2>{featured.title}</h2>
              <p>{featured.excerpt}</p>
              <span className="guide-feature-meta">
                {featured.time}阅读
                <em>
                  开始阅读
                  <Icon name="arrow" />
                </em>
              </span>
            </div>
            <div className="guide-feature-art" aria-hidden="true">
              <span>01</span>
              <span>02</span>
              <span>03</span>
            </div>
          </Link>
        </Reveal>

        <div className="guides-grid">
          {rest.map((guide, index) => (
            <Reveal key={guide.slug} delay={(index % 3) * 0.05}>
              <Link className="guide-card" to={`/guides/${guide.slug}`}>
                <span className={`guide-icon guide-icon-${guide.category}`}>
                  <Icon name={guide.icon} />
                </span>
                <span className="guide-meta">
                  {guide.category}
                  <em>{guide.time}</em>
                </span>
                <h3>{guide.title}</h3>
                <p>{guide.excerpt}</p>
                <span className="guide-card-link">
                  阅读全文
                  <Icon name="arrow" />
                </span>
              </Link>
            </Reveal>
          ))}
        </div>

        <section className="guides-cta">
          <div>
            <span className="eyebrow">仍然卡住？</span>
            <h2>把你的画面发给我们，一起看是哪一步没识别到</h2>
            <p>内测申请表里可以附上截图与状态图；也可以先看看常见问题。</p>
          </div>
          <div className="guides-cta-actions">
            <Link className="btn btn-primary" to="/download">
              申请内测
              <Icon name="arrow" />
            </Link>
            <Link className="btn btn-ghost" to="/faq">
              常见问题
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
