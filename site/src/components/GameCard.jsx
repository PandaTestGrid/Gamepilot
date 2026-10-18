import { Link } from 'react-router-dom';
import TiltedCard from '../reactbits/TiltedCard';
import GamePoster from './GamePoster';
import Icon from './Icon';
import Reveal from './Reveal';

export default function GameCard({ game, index = 0, height = 420, reveal = true }) {
  const card = (
    <TiltedCard
      className="game-tilt"
      containerWidth="100%"
      containerHeight={`${height}px`}
      imageWidth="100%"
      imageHeight="100%"
      rotateAmplitude={9}
      scaleOnHover={1.025}
      glare={0.38}
      glareColor="#cfe4ff"
      showTooltip={false}
      intro={false}
      radius={20}
    >
      <Link
        className="game-cover"
        to={`/games/${game.slug}`}
        aria-label={`${game.title}：查看游戏详情`}
      >
        <GamePoster game={game} />
        <span className="game-topline">
          <span className="game-badge">{game.genre}</span>
          <span className={`game-auto${game.status === '预约中' ? ' is-soon' : ''}`}>
            <i className="dot live" />
            {game.status === '预约中' ? '预约中' : '可自动化'}
          </span>
        </span>
        <span className="game-bottom">
          <span className="game-en">{game.en}</span>
          <strong className="game-title">{game.title}</strong>
          <span className="game-meta">
            <span className="game-rating" aria-label={`评分 ${game.rating}`}>
              <Icon name="spark" />
              {game.rating.toFixed(1)}
            </span>
            <span>{game.category}</span>
            <span>{game.heat}</span>
          </span>
          <span className="game-tags">
            {game.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </span>
          <span className="game-cta">
            查看游戏详情
            <Icon name="arrow" />
          </span>
        </span>
      </Link>
    </TiltedCard>
  );

  if (!reveal) return <div className="game-cell">{card}</div>;

  return (
    <Reveal className="game-cell" delay={(index % 3) * 0.06} amount={0.1}>
      {card}
    </Reveal>
  );
}
