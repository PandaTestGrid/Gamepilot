import { useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../components/Icon';
import PageHead from '../components/PageHead';
import Reveal from '../components/Reveal';
import { useDownload } from '../context/DownloadContext';
import usePageMeta from '../hooks/usePageMeta';

const BUILDS = {
  macos: {
    label: 'macOS',
    file: 'GamePilot-0.1.0-universal.dmg',
    detail: 'Apple Silicon / Intel · 约 150 MB',
    min: 'macOS 12 Monterey 及以上'
  },
  windows: {
    label: 'Windows',
    file: 'GamePilot-0.1.0-x64-setup.exe',
    detail: 'x64 · 约 150 MB',
    min: 'Windows 10 21H2 及以上'
  }
};

const REQUIREMENTS = [
  ['桌面端', 'macOS 12+ / Windows 10 21H2+'],
  ['运行引擎', '内置 Python 3.11 sidecar，无需另装'],
  ['安卓设备', 'Android 9+，adb 调试 + scrcpy'],
  ['iOS 设备', 'iOS 17.4+，需信任开发者与配对'],
  ['macOS 窗口', '屏幕录制 + 辅助功能权限'],
  ['离线使用', 'Mock 设备可完全离线运行']
];

export default function DownloadPage() {
  const [os, setOs] = useState('macos');
  const openDownload = useDownload();
  const build = BUILDS[os];
  usePageMeta('下载客户端', '下载 GamePilot 桌面客户端，macOS 与 Windows 双平台，内置引擎、无需 Python。');

  return (
    <div className="page-container">
      <div className="container">
        <PageHead
          eyebrow="DOWNLOAD · 下载"
          title="装好就能连，连上就能跑"
          lead="桌面端内置引擎，不需要配 Python、不需要 ADB 环境变量。当前为内测阶段，安装包准备中。"
        />

        <div className="dl-layout">
          <Reveal className="dl-card" amount={0.1}>
            <div className="dl-os-toggle" role="tablist" aria-label="选择操作系统">
              {Object.entries(BUILDS).map(([key, item]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={os === key}
                  className={os === key ? 'is-active' : undefined}
                  onClick={() => setOs(key)}
                >
                  <Icon name={key === 'macos' ? 'laptop' : 'monitor'} />
                  {item.label}
                </button>
              ))}
            </div>

            <div className="dl-build">
              <div className="dl-build-icon">
                <Icon name="download" />
              </div>
              <div className="dl-build-copy">
                <strong>GamePilot for {build.label}</strong>
                <span>{build.detail}</span>
                <code>{build.file}</code>
              </div>
              <span className="dl-badge">准备中</span>
            </div>

            <div className="dl-actions">
              <button className="btn btn-primary btn-lg" type="button" onClick={openDownload}>
                <Icon name="download" />
                预约下载
              </button>
              <Link className="btn btn-ghost btn-lg" to="/faq">
                安装与权限
              </Link>
            </div>
            <p className="dl-hint">
              当前站点没有真实安装包。留下邮箱后，内测包上线时我们会通知你；不会上传或发送邮件。
            </p>

            <div className="dl-meta">
              <span>v0.1.0 · 内测</span>
              <span>内置引擎</span>
              <span>{build.min}</span>
              <span>本地运行</span>
            </div>
          </Reveal>

          <aside className="dl-side">
            <div className="side-card">
              <h3>三步开始</h3>
              <ol className="dl-steps">
                <li>
                  <span>01</span>
                  安装客户端并打开工作区
                </li>
                <li>
                  <span>02</span>
                  连接设备，框选第一个界面
                </li>
                <li>
                  <span>03</span>
                  连好状态图，点运行
                </li>
              </ol>
            </div>
            <div className="side-card side-card-muted">
              <h3>更新策略</h3>
              <p>内测期每周构建，识别引擎与设备通道优先；工作区格式保持向后兼容，升级不丢图。</p>
            </div>
          </aside>
        </div>

        <div className="dl-grid">
          <section className="dl-section">
            <h2>系统要求</h2>
            <div className="dl-table">
              {REQUIREMENTS.map(([key, value]) => (
                <div className="dl-row" key={key}>
                  <span>{key}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          </section>
          <section className="dl-section">
            <h2>这个版本包含什么</h2>
            <ul className="dl-list">
              <li>
                <Icon name="check" />
                状态图编辑、运行与热重载
              </li>
              <li>
                <Icon name="check" />
                安卓 / iOS / macOS 窗口 / Mock 四类设备
              </li>
              <li>
                <Icon name="check" />
                模板与颜色识别、恢复边、全局重定位
              </li>
              <li>
                <Icon name="check" />
                操作录制、变量与多开网格
              </li>
              <li>
                <Icon name="check" />
                完全本地运行，无账号与云端推理
              </li>
            </ul>
            <Link className="text-link" to="/guides">
              先看三分钟上手
              <Icon name="arrow" />
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}
