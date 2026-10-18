import { Link } from 'react-router-dom';
import { FAQS } from '../data/faqs';
import Icon from '../components/Icon';
import PageHead from '../components/PageHead';
import Reveal from '../components/Reveal';
import { useDownload } from '../context/DownloadContext';
import usePageMeta from '../hooks/usePageMeta';

export default function FaqPage() {
  const openDownload = useDownload();
  usePageMeta('常见问题', '关于 GamePilot 的设备支持、权限、隐私、识别原理与多开限制。');

  return (
    <div className="page-container">
      <div className="container">
        <PageHead
          eyebrow="HELP CENTER · 常见问题"
          title="开始之前，你可能想知道"
          lead="设备、权限、隐私、识别与多开——把最容易卡住的地方一次说清楚。"
        />

        <div className="faq-page-layout">
          <div className="faq-page-main">
            <div className="faq-list">
              {FAQS.map((item, index) => (
                <Reveal
                  as="details"
                  className="faq-item"
                  name="gamepilot-faq-page"
                  key={item.q}
                  delay={Math.min(index * 0.03, 0.18)}
                  amount={0.05}
                >
                  <summary>
                    {item.q}
                    <span className="faq-plus" aria-hidden="true" />
                  </summary>
                  <div className="faq-body">
                    <p>{item.a}</p>
                  </div>
                </Reveal>
              ))}
            </div>

            <Reveal className="faq-page-cta" delay={0.1}>
              <div>
                <h2>没有找到答案？</h2>
                <p>留下邮箱，内测开始时我们会一起回复安装、权限与脚本问题。</p>
              </div>
              <div className="faq-page-actions">
                <button className="btn btn-primary" type="button" onClick={openDownload}>
                  <Icon name="mail" />
                  联系与内测
                </button>
                <Link className="btn btn-ghost" to="/guides">
                  看使用攻略
                  <Icon name="arrow" />
                </Link>
              </div>
            </Reveal>
          </div>

          <aside className="faq-page-side">
            <div className="side-card">
              <h3>先看这三篇</h3>
              <Link to="/guides/first-graph">
                <Icon name="layers" />
                从零建一张状态图
              </Link>
              <Link to="/guides/devices">
                <Icon name="monitor" />
                连接安卓、iOS 与窗口
              </Link>
              <Link to="/guides/recovery">
                <Icon name="shield" />
                恢复边与全局重定位
              </Link>
            </div>
            <div className="side-card side-card-muted">
              <h3>使用边界</h3>
              <p>
                GamePilot 不做注入、不改内存，也不绕过游戏的风控。请只在允许自动化的场景与账号上使用，并遵守游戏服务条款。
              </p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
