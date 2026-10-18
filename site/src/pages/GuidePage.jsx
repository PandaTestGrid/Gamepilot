import { Link, useParams } from 'react-router-dom';
import { GUIDES, getGuide } from '../data/guides';
import Icon from '../components/Icon';
import usePageMeta from '../hooks/usePageMeta';
import NotFoundPage from './NotFoundPage';

export default function GuidePage() {
  const { slug } = useParams();
  const guide = getGuide(slug);
  usePageMeta(guide ? guide.title : '游戏攻略', guide?.excerpt);

  if (!guide) return <NotFoundPage />;

  const index = GUIDES.findIndex((item) => item.slug === guide.slug);
  const prev = GUIDES[index - 1];
  const next = GUIDES[index + 1];

  return (
    <article className="guide-page">
      <div className="container">
        <nav className="breadcrumb" aria-label="面包屑">
          <Link to="/">首页</Link>
          <span>/</span>
          <Link to="/guides">游戏攻略</Link>
          <span>/</span>
          <em>{guide.title}</em>
        </nav>

        <header className="guide-header">
          <span className="guides-kicker">
            {guide.category} · {guide.time}阅读
          </span>
          <h1>{guide.title}</h1>
          <p>{guide.intro}</p>
        </header>

        <div className="guide-layout">
          <aside className="guide-toc">
            <span>本文目录</span>
            <nav>
              {guide.sections.map((section, i) => (
                <a href={`#part-${i + 1}`} key={section.h}>
                  {String(i + 1).padStart(2, '0')} {section.h}
                </a>
              ))}
            </nav>
            <Link className="text-link" to="/guides">
              返回攻略列表
              <Icon name="arrow" />
            </Link>
          </aside>

          <div className="guide-body">
            {guide.sections.map((section, i) => (
              <section id={`part-${i + 1}`} key={section.h}>
                <span className="guide-part">{String(i + 1).padStart(2, '0')}</span>
                <h2>{section.h}</h2>
                {section.p?.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
                {section.list ? (
                  <ul>
                    {section.list.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                {section.code ? (
                  <pre className="guide-code">
                    <code>{section.code}</code>
                  </pre>
                ) : null}
              </section>
            ))}

            <div className="guide-next">
              {prev ? (
                <Link to={`/guides/${prev.slug}`}>
                  <span>上一篇</span>
                  <strong>{prev.title}</strong>
                </Link>
              ) : (
                <span />
              )}
              {next ? (
                <Link to={`/guides/${next.slug}`} className="is-next">
                  <span>下一篇</span>
                  <strong>{next.title}</strong>
                </Link>
              ) : (
                <Link to="/games" className="is-next">
                  <span>去实践</span>
                  <strong>浏览游戏中心</strong>
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
