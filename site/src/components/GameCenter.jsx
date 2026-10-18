import { Link } from 'react-router-dom';
import BlurText from '../reactbits/BlurText';
import { FEATURED_GAMES, GAMES } from '../data/games';
import GameCard from './GameCard';
import Icon from './Icon';
import Reveal from './Reveal';

const HOME_GAMES = [...FEATURED_GAMES, ...GAMES.filter((game) => !game.featured)].slice(0, 6);

export default function GameCenter() {
  return (
    <section className="section game-section" id="games" aria-labelledby="games-title">
      <div className="container">
        <div className="section-head">
          <Reveal as="p" className="eyebrow">
            游戏库 · 场景演示
          </Reveal>
          <h2 id="games-title">
            <BlurText as="span" text="你的每一个游戏，" animateBy="chars" delay={22} />
            <br />
            <BlurText as="span" text="都能被拆成一张状态图" animateBy="chars" delay={22} startDelay={0.3} />
          </h2>
          <Reveal as="p" className="section-lead" delay={0.08}>
            刷本、日常、活动、多开同步 —— 同样的识别引擎，换一套界面模板就能接管新的游戏世界。
            游戏中心里还有更多可运行的演示场景。
          </Reveal>
        </div>

        <div className="game-grid">
          {HOME_GAMES.map((game, index) => (
            <GameCard game={game} index={index} key={game.slug} />
          ))}
        </div>

        <div className="game-more">
          <Link className="btn btn-ghost" to="/games">
            进入游戏中心
            <span className="game-count">{GAMES.length} 款演示</span>
            <Icon name="arrow" />
          </Link>
        </div>

        <p className="game-note">以上为视觉演示场景，不代表官方合作或已适配名单。实际识别效果取决于游戏画面。</p>
      </div>
    </section>
  );
}
