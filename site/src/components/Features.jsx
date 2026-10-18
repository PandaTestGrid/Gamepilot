import { gameScene } from '../assets/images';
import BlurText from '../reactbits/BlurText';
import Icon from './Icon';
import Reveal from './Reveal';

export default function Features() {
  return (
    <section className="section" id="features" aria-labelledby="features-title">
      <div className="container">
        <div className="section-head">
          <Reveal as="p" className="eyebrow">
            核心能力
          </Reveal>
          <h2 id="features-title">
            <BlurText as="span" text="不是录屏宏，" animateBy="chars" delay={28} />
            <br className="br-mobile" />
            <BlurText
              as="span"
              text="是看得懂画面的脚本引擎"
              animateBy="chars"
              delay={28}
              startDelay={0.32}
            />
          </h2>
          <Reveal as="p" className="section-lead" delay={0.1}>
            传统按键脚本只会“在某个坐标点一下”。GamePilot 每一拍都在识别“我现在在哪个界面”，
            再沿着状态图决定下一步 —— 界面变了、弹窗挡了，它都能自己找回来。
          </Reveal>
        </div>

        <div className="feature-grid">
          <Reveal
            as="article"
            className="feature-card feature-wide"
            spotlight
            delay={0.05}
            amount={0.12}
          >
            <div className="feature-copy">
              <span className="feature-tag">
                <Icon name="layers" />
                状态机脚本
              </span>
              <h3>节点是界面，边是动作</h3>
              <p>
                把游戏拆成一张流程图：进入「主城」就点「副本」，进入「战斗」就检查血量。
                引擎每拍识别节点、匹配边、执行动作，走不通时还有恢复边兜底。
              </p>
              <ul className="mini-list">
                <li>
                  <Icon name="check" />
                  恢复边优先级最高，弹窗随时打断
                </li>
                <li>
                  <Icon name="check" />
                  改图不用停，运行中热重载
                </li>
                <li>
                  <Icon name="check" />
                  一张图就是一个可读的 JSON
                </li>
              </ul>
            </div>
            <div className="feature-visual graph-visual">
              <div className="mini-graph">
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  <path className="edge" d="M24 26 C38 26 42 16 55 16" />
                  <path className="edge" d="M64 27 C68 34 68 44 68 51" />
                  <path className="edge" d="M58 66 C48 66 42 72 30 72" />
                  <path className="edge recovery" d="M62 76 C88 66 88 22 31 22" />
                </svg>
                <span className="gnode" style={{ left: '6%', top: '16%' }}>
                  <i className="dot ok" />
                  主城<em>main</em>
                </span>
                <span className="gnode is-active" style={{ left: '49%', top: '6%' }}>
                  <i className="dot live" />
                  副本<em>dungeon</em>
                </span>
                <span className="gnode" style={{ left: '56%', top: '50%' }}>
                  <i className="dot warn" />
                  战斗<em>battle</em>
                </span>
                <span className="gnode" style={{ left: '8%', top: '64%' }}>
                  <i className="dot" />
                  结算<em>settle</em>
                </span>
                <span className="graph-caption">recovery · 弹窗恢复</span>
              </div>
            </div>
          </Reveal>

          <Reveal as="article" className="feature-card" spotlight delay={0.08} amount={0.15}>
            <div className="feature-visual recog-visual">
              <div className="recog-frame">
                <img src={gameScene} alt="" loading="lazy" />
                <span className="scan-line" />
                <span className="recog-box box-demo">
                  <em>0.94</em>
                </span>
                <span className="recog-box box-demo-2">
                  <em>0.88</em>
                </span>
              </div>
            </div>
            <div className="feature-copy">
              <span className="feature-tag">
                <Icon name="target" />
                框选即识别
              </span>
              <h3>拖一个框，得到一个识别器</h3>
              <p>
                模板匹配与颜色识别自动分工，实时分数、阈值、搜索范围都能按步骤单独调。命中后点的是模板此刻的位置，不读死坐标。
              </p>
            </div>
          </Reveal>

          <Reveal as="article" className="feature-card" spotlight delay={0.16} amount={0.15}>
            <div className="feature-visual record-visual">
              <div className="record-card">
                <div className="record-row">
                  <span className="step-no">1</span>
                  <span className="step-chip">点击</span>
                  <span className="step-arg">副本入口 · (0.62, 0.81)</span>
                </div>
                <div className="record-row">
                  <span className="step-no">2</span>
                  <span className="step-chip is-blue">滑动</span>
                  <span className="step-arg">连续 18 点 · 480ms</span>
                </div>
                <div className="record-row">
                  <span className="step-no">3</span>
                  <span className="step-chip is-gold">等待</span>
                  <span className="step-arg">1000ms</span>
                </div>
                <div className="record-cursor" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M5 3l14 8-6 1.6L10 19Z" />
                  </svg>
                </div>
              </div>
            </div>
            <div className="feature-copy">
              <span className="feature-tag">
                <Icon name="record" />
                录制即脚本
              </span>
              <h3>正常玩一遍，步骤就有了</h3>
              <p>打开「录操作」，点一下记一步点击，拖一下记一步滑动，换个界面再框一次就自动连成边。</p>
            </div>
          </Reveal>

          <Reveal
            as="article"
            className="feature-card feature-wide feature-multi"
            spotlight
            delay={0.1}
            amount={0.12}
          >
            <div className="feature-copy">
              <span className="feature-tag">
                <Icon name="layout" />
                多开与同步
              </span>
              <h3>看多台，也能同时控多台</h3>
              <p>
                多开网格里每一格的画面都能直接点、直接拖；控制走独立通道，与预览帧率无关。
                养号、刷材料、多账号日常，一台电脑全接住。
              </p>
              <ul className="mini-list">
                <li>
                  <Icon name="check" />
                  当前设备蓝框高亮，误触保护
                </li>
                <li>
                  <Icon name="check" />
                  每格独立识别、独立状态图
                </li>
                <li>
                  <Icon name="check" />
                  窗口不可见时自动降帧省资源
                </li>
              </ul>
            </div>
            <div className="feature-visual multi-visual">
              <div className="multi-grid">
                <span className="multi-cell is-current">
                  <img src={gameScene} alt="" loading="lazy" />
                  <i className="dot live" />
                </span>
                <span className="multi-cell">
                  <img src={gameScene} alt="" loading="lazy" />
                  <i className="dot live" />
                </span>
                <span className="multi-cell">
                  <img src={gameScene} alt="" loading="lazy" />
                  <i className="dot live" />
                </span>
                <span className="multi-cell">
                  <img src={gameScene} alt="" loading="lazy" />
                  <i className="dot" />
                </span>
              </div>
              <span className="sync-badge">
                <Icon name="refresh" />
                同步操作 · 4 台
              </span>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
