import { Link } from 'react-router-dom';
import { useDownload } from '../context/DownloadContext';
import Brand from './Brand';
import Icon from './Icon';

export default function Footer() {
  const year = new Date().getFullYear();
  const openDownload = useDownload();

  function backToTop() {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (window.__lenis) window.__lenis.scrollTo(0, { duration: reduce ? 0 : 0.85 });
    else window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  }

  return (
    <footer className="site-footer">
      <div className="container footer-top">
        <div className="footer-brand">
          <Brand />
          <p>
            把重复交给状态机，把游戏还给乐趣。
            <br />
            本地运行 · 不依赖云端 · 脚本即文件。
          </p>
          <button className="btn btn-soft btn-sm" type="button" onClick={openDownload}>
            <Icon name="mail" />
            申请内测
          </button>
        </div>

        <nav className="footer-col" aria-label="产品">
          <h3>产品</h3>
          <Link to="/#play-styles">操作方式</Link>
          <Link to="/#workflow">工作流</Link>
          <Link to="/#devices">设备支持</Link>
          <Link to="/#compare">能力对比</Link>
        </nav>
        <nav className="footer-col" aria-label="游戏与服务">
          <h3>游戏与服务</h3>
          <Link to="/games">游戏中心</Link>
          <Link to="/guides">游戏攻略</Link>
          <Link to="/download">下载客户端</Link>
          <Link to="/business">商务合作</Link>
        </nav>
        <nav className="footer-col" aria-label="支持">
          <h3>支持</h3>
          <Link to="/faq">常见问题</Link>
          <Link to="/guides/first-graph">三分钟上手</Link>
          <button className="footer-link" type="button" onClick={openDownload}>
            内测申请
          </button>
          <button className="footer-link" type="button" onClick={backToTop}>回到顶部</button>
        </nav>
      </div>

      <div className="container footer-bottom">
        <p>© {year} GamePilot. 仅供学习与个人自动化使用，请遵守游戏服务条款。</p>
        <p className="footer-sep">本页面为独立官网，与桌面客户端仓库分离。</p>
      </div>
    </footer>
  );
}
