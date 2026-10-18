import { gameScene } from '../assets/images';
import GlareHover from '../reactbits/GlareHover';
import BlurText from '../reactbits/BlurText';
import Icon from './Icon';
import Reveal from './Reveal';

const GRAPH_JSON = `{
  "nodes": [
    { "id": "main", "name": "主界面", "enter": ["main_start"] },
    { "id": "battle", "name": "战斗中", "enter": ["battle_hp"] }
  ],
  "edges": [
    { "from": "main", "to": "battle", "when": "main_start",
      "action": { "type": "click", "target": "main_start" } },
    { "kind": "recovery", "when": "popup_close",
      "action": { "type": "click", "target": "popup_close" } }
  ]
}`;

function JsonCode({ code }) {
  const nodes = [];
  const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?/g;
  let last = 0;
  let match;
  let key = 0;

  while ((match = pattern.exec(code)) !== null) {
    if (match.index > last) nodes.push(code.slice(last, match.index));
    nodes.push(
      <span className={match[2] ? 'k' : 's'} key={key}>
        {match[1]}
      </span>
    );
    key += 1;
    if (match[2]) nodes.push(match[2]);
    last = pattern.lastIndex;
  }
  nodes.push(code.slice(last));

  return <code>{nodes}</code>;
}

export default function Workflow() {
  return (
    <section className="section section-alt" id="workflow" aria-labelledby="workflow-title">
      <div className="container">
        <div className="section-head section-head-row">
          <div>
            <Reveal as="p" className="eyebrow">
              三分钟上手
            </Reveal>
            <h2 id="workflow-title">
              <BlurText as="span" text="从连接到挂机，" animateBy="chars" delay={30} />
              <br className="br-mobile" />
              <BlurText as="span" text="只要三步" animateBy="chars" delay={30} startDelay={0.3} />
            </h2>
          </div>
          <Reveal as="p" className="section-lead" delay={0.1}>
            没有 SDK、没有脚本语言、没有环境配置。连接设备后，你在画面上做的每个动作，
            都能直接变成可复用的自动化流程。
          </Reveal>
        </div>

        <ol className="steps">
          <Reveal as="li" className="step" delay={0}>
            <div className="step-visual step-connect">
              <div className="device-list">
                <div className="device-item is-active">
                  <span className="device-avatar phone">
                    <Icon name="phone" />
                  </span>
                  <div>
                    <b>Pixel 8 · 已连接</b>
                    <small>Android 15 · 1080×2400</small>
                  </div>
                  <span className="ok-tag">30fps</span>
                </div>
                <div className="device-item">
                  <span className="device-avatar phone">
                    <Icon name="phone" />
                  </span>
                  <div>
                    <b>MuMu-12</b>
                    <small>模拟器 · 附屏 2</small>
                  </div>
                  <span className="ok-tag">12fps</span>
                </div>
                <div className="device-item">
                  <span className="device-avatar mac">
                    <Icon name="monitor" />
                  </span>
                  <div>
                    <b>Finder · 窗口 #89</b>
                    <small>macOS 本机窗口</small>
                  </div>
                  <span className="muted-tag">待连接</span>
                </div>
              </div>
            </div>
            <div className="step-copy">
              <span className="step-num">01</span>
              <h3>连接设备</h3>
              <p>安卓真机、模拟器、iPhone 或任意 macOS 窗口，点一下就连。未授权、掉线都会直接写明原因。</p>
            </div>
          </Reveal>

          <Reveal as="li" className="step" delay={0.1}>
            <div className="step-visual step-record">
              <div className="box-select">
                <img src={gameScene} alt="" loading="lazy" />
                <span className="select-rect">
                  <em>副本入口</em>
                </span>
                <span className="select-hint">拖拽框选界面元素</span>
              </div>
            </div>
            <div className="step-copy">
              <span className="step-num">02</span>
              <h3>框选 + 录制</h3>
              <p>框出“这个界面长什么样”，再打开录操作正常玩一遍。点击、滑动、等待会自动记成步骤。</p>
            </div>
          </Reveal>

          <Reveal as="li" className="step" delay={0.2}>
            <div className="step-visual step-run">
              <div className="run-card">
                <div className="run-head">
                  <span>
                    <i className="dot live" />
                    运行中
                  </span>
                  <em>00:12:31</em>
                </div>
                <div className="run-stats">
                  <span>
                    tick <b>142</b>
                  </span>
                  <span>
                    fps <b>30</b>
                  </span>
                  <span>
                    capture <b>12ms</b>
                  </span>
                </div>
                <div className="run-log">
                  <div>
                    <time>12:04:07</time>
                    <b>node_entered</b> dungeon
                  </div>
                  <div>
                    <time>12:04:08</time>
                    <b>edge_matched</b> e_start
                  </div>
                  <div>
                    <time>12:04:08</time>
                    <b>action</b> click ok
                  </div>
                </div>
                <span className="run-pulse" />
              </div>
            </div>
            <div className="step-copy">
              <span className="step-num">03</span>
              <h3>点运行</h3>
              <p>引擎接管：进界面 → 匹配边 → 执行动作 → 进入下一状态。事件流实时可见，出错走恢复边。</p>
            </div>
          </Reveal>
        </ol>

        <GlareHover className="code-panel">
          <div className="code-head">
            <span className="code-file">
              <Icon name="folder" />
              workspaces / 默认 / 日常 / graph.json
            </span>
            <span className="code-tag">唯一真源</span>
          </div>
          <pre className="code-block" aria-label="状态图 JSON 示例">
            <JsonCode code={GRAPH_JSON} />
          </pre>
          <p className="code-note">
            脚本就是文件：<code>graph.json</code> + <code>templates/*.png</code>，能 git diff、能复制、能进版本库。
          </p>
        </GlareHover>
      </div>
    </section>
  );
}
