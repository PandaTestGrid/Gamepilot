import CountUp from '../reactbits/CountUp';
import Reveal from './Reveal';

const STATS = [
  {
    to: 4,
    decimals: 0,
    suffix: '类',
    desc: (
      <>
        设备来源：安卓 / iOS
        <br />
        macOS 窗口 / Mock
      </>
    )
  },
  {
    to: 0.1,
    decimals: 1,
    suffix: 'ms',
    desc: (
      <>
        scrcpy 触控指令下发
        <br />
        比 adb tap 快约 1 万倍
      </>
    )
  },
  {
    to: 15,
    decimals: 0,
    suffix: 'ms',
    desc: (
      <>
        1080p 全屏模板粗搜
        <br />
        大区域搜索不再卡顿
      </>
    )
  },
  {
    to: 100,
    decimals: 0,
    suffix: '%',
    desc: (
      <>
        本地运行、本地存储
        <br />
        画面与脚本都不出机器
      </>
    )
  }
];

export default function Stats() {
  return (
    <div className="hero-stats">
      {STATS.map((stat, index) => (
        <Reveal className="stat" key={stat.suffix + index} delay={index * 0.08} amount={0.4}>
          <div className="stat-value">
            <span>
              <CountUp to={stat.to} decimals={stat.decimals} duration={1.8} />
            </span>
            <small>{stat.suffix}</small>
          </div>
          <p>{stat.desc}</p>
        </Reveal>
      ))}
    </div>
  );
}
