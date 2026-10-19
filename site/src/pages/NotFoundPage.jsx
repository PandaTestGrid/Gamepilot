import { Link } from 'react-router-dom';
import Icon from '../components/Icon';
import GlitchText from '../reactbits/GlitchText';
import usePageMeta from '../hooks/usePageMeta';

export default function NotFoundPage() {
  usePageMeta('页面不存在', '这个页面没有找到，回到 GamePilot 首页或游戏中心。');

  return (
    <div className="page-container notfound-page">
      <div className="container notfound-inner">
        <div className="notfound-code-wrap" aria-hidden="true">
          <GlitchText
            className="notfound-glitch"
            speed={0.6}
            enableShadows
            shadowColors={['#4da3ff', '#8cc8ff']}
            mode="slices"
            intensity={0.3}
            trigger="hover"
            fontSize="clamp(90px, 16vw, 180px)"
            fontWeight={700}
          >
            404
          </GlitchText>
        </div>
        <p className="eyebrow">SIGNAL LOST · 页面不存在</p>
        <h1>这张界面没有匹配到节点</h1>
        <p className="page-lead">
          链接可能已经过期，或者你输入的地址不在当前工作区里。回到首页，或者去游戏中心继续看。
        </p>
        <div className="notfound-actions">
          <Link className="btn btn-primary" to="/">
            回到首页
            <Icon name="arrow" />
          </Link>
          <Link className="btn btn-ghost" to="/games">
            打开游戏中心
          </Link>
        </div>
        <nav className="notfound-links" aria-label="常用页面">
          <Link to="/games">游戏中心</Link>
          <Link to="/guides">游戏攻略</Link>
          <Link to="/download">下载客户端</Link>
          <Link to="/faq">常见问题</Link>
        </nav>
      </div>
    </div>
  );
}
