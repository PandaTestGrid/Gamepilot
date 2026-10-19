import { Link } from 'react-router-dom';
import Icon from './Icon';
import SpotlightCard from '../reactbits/SpotlightCard';
import appShot from '../assets/img/app-shot.jpg';

const STYLES = [
  {
    icon: 'target',
    title: '自定义操作',
    text: '框选界面、拖拽连线，动作按你的节奏来。'
  },
  {
    icon: 'layers',
    title: '游戏多开',
    text: '一台电脑驱动多台设备，每条控制通道互不打扰。'
  },
  {
    icon: 'record',
    title: '操作录制',
    text: '点击、滑动、等待自动记成步骤，录一遍就能复用。'
  },
  {
    icon: 'refresh',
    title: '多开同步',
    text: '同一套操作广播到多个实例，批量日常不再排队。'
  }
];

export default function PlayStyles() {
  return (
    <section className="play-styles" id="play-styles" aria-labelledby="play-styles-title">
      <div className="container">
        <header className="ps-head">
          <span className="eyebrow">PLAY YOUR WAY · 操作层</span>
          <h2 id="play-styles-title">
            四种方式，<span className="text-grad">接管一局游戏</span>
          </h2>
          <p>
            想手动就手动，想托管就托管。控制层和识别层分开，任何一步都能被替换。
          </p>
          <Link className="ps-more" to="/guides">
            更多教程
            <Icon name="arrow" />
          </Link>
        </header>

        <div className="ps-stage">
          <div className="ps-frame">
            <img
              src={appShot}
              alt="GamePilot 桌面工作台：左侧设备画面、中部状态图、右侧运行日志"
              width="2560"
              height="1351"
              loading="lazy"
            />
            <span className="ps-chip ps-chip-a">
              <i className="dot live" />
              识别命中 <strong>0.94</strong>
            </span>
            <span className="ps-chip ps-chip-b">
              多开 <strong>×4</strong>
            </span>
            <span className="ps-chip ps-chip-c">
              录制 <strong>12 步</strong>
            </span>
            <span className="ps-chip ps-chip-d">
              <i className="dot warn" />
              恢复边待命
            </span>
            <span className="ps-tag">LIVE WORKSPACE</span>
          </div>
        </div>

        <div className="ps-features">
          {STYLES.map((item) => (
            <SpotlightCard className="ps-feature" key={item.title} color="rgba(139, 123, 255, 0.16)">
              <span className="ps-icon">
                <Icon name={item.icon} />
              </span>
              <strong>{item.title}</strong>
              <p>{item.text}</p>
            </SpotlightCard>
          ))}
        </div>
      </div>
    </section>
  );
}
