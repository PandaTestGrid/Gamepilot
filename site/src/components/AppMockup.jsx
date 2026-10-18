import { useEffect, useRef, useState } from 'react';
import { motion, useMotionValue, useReducedMotion, useSpring } from 'motion/react';
import { gameScene } from '../assets/images';
import Icon from './Icon';

function pad(value) {
  return String(value).padStart(2, '0');
}

export default function AppMockup() {
  const windowRef = useRef(null);
  const reduced = useReducedMotion();
  const rotateX = useMotionValue(0);
  const rotateY = useMotionValue(0);
  const springX = useSpring(rotateX, { stiffness: 110, damping: 20, mass: 0.5 });
  const springY = useSpring(rotateY, { stiffness: 110, damping: 20, mass: 0.5 });
  const [seconds, setSeconds] = useState(751);

  useEffect(() => {
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const handlePointerMove = (event) => {
    if (reduced || !window.matchMedia('(pointer: fine)').matches) return;
    const el = windowRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    rotateY.set(px * 3.4);
    rotateX.set(-py * 2.6);
  };

  const resetTilt = () => {
    rotateX.set(0);
    rotateY.set(0);
  };

  const clock = `00:${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;

  return (
    <motion.div
      ref={windowRef}
      className="app-window"
      role="img"
      aria-label="GamePilot 工作台预览：左侧是手机实时画面与识别框，中间是状态图与事件流，右侧是识别器分数，底部是运行状态栏。"
      style={{ rotateX: springX, rotateY: springY, transformPerspective: 1800 }}
      onPointerMove={handlePointerMove}
      onPointerLeave={resetTilt}
    >
      <div className="app-titlebar" aria-hidden="true">
        <div className="win-dots">
          <span />
          <span />
          <span />
        </div>
        <div className="app-tabs">
          <span className="app-tab is-active">
            <i className="dot live" />
            Pixel 8 <em>30fps</em>
          </span>
          <span className="app-tab">
            <i className="dot" />
            MuMu-12 <em>12fps</em>
          </span>
          <span className="app-tab app-tab-add">＋</span>
        </div>
        <div className="app-topright">
          <span className="engine-pill">
            <i className="dot live" />
            引擎已就绪
          </span>
        </div>
      </div>

      <div className="app-body" aria-hidden="true">
        <div className="pane pane-screen">
          <div className="pane-head">
            <span>画面</span>
            <span className="pane-tools">框选 · 点击 · 录操作</span>
          </div>
          <div className="device-stage">
            <div className="phone-frame">
              <img src={gameScene} alt="" width="360" height="640" />
              <span className="recog-box box-a">
                <em>主城 0.94</em>
              </span>
              <span className="recog-box box-b">
                <em>任务 0.78</em>
              </span>
              <span className="recog-box box-c">
                <em>0.91</em>
              </span>
            </div>
          </div>
          <div className="control-strip">
            <span className="control-chip">← 返回</span>
            <span className="control-chip">⌂ 桌面</span>
            <span className="control-chip">▣ 最近</span>
            <span className="control-chip">⏻ 电源</span>
            <span className="control-chip record">
              <i className="dot live" />
              录操作
            </span>
          </div>
          <div className="readout">
            <div className="readout-row">
              <i className="dot ok" />
              main_start <b>0.94</b>
              <span>稳定</span>
            </div>
            <div className="readout-row">
              <i className="dot warn" />
              battle_hp <b>0.71</b>
              <span>待确认</span>
            </div>
          </div>
        </div>

        <div className="pane pane-graph">
          <div className="pane-head">
            <span>状态图</span>
            <span className="pane-tools">＋ 节点　▶ 运行</span>
          </div>
          <div className="graph-canvas">
            <svg className="graph-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <marker
                  id="arrow-blue"
                  viewBox="0 0 8 8"
                  refX="6"
                  refY="4"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M0 0 8 4 0 8Z" fill="#4da3ff" />
                </marker>
                <marker
                  id="arrow-pink"
                  viewBox="0 0 8 8"
                  refX="6"
                  refY="4"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M0 0 8 4 0 8Z" fill="#fb7185" />
                </marker>
              </defs>
              <path className="edge" d="M27 24 C38 24 42 18 52 18" markerEnd="url(#arrow-blue)" />
              <path className="edge" d="M64 26 C67 26 67 42 67 50" markerEnd="url(#arrow-blue)" />
              <path className="edge" d="M58 62 C48 62 40 66 30 66" markerEnd="url(#arrow-blue)" />
              <path
                className="edge recovery"
                d="M64 70 C86 61 86 24 30 26"
                markerEnd="url(#arrow-pink)"
              />
            </svg>
            <span className="gnode" style={{ left: '7%', top: '14%' }}>
              <i className="dot ok" />
              主城<em>main</em>
            </span>
            <span className="gnode is-active" style={{ left: '52%', top: '8%' }}>
              <i className="dot live" />
              副本入口<em>dungeon</em>
            </span>
            <span className="gnode" style={{ left: '56%', top: '50%' }}>
              <i className="dot warn" />
              战斗中<em>battle</em>
            </span>
            <span className="gnode" style={{ left: '8%', top: '58%' }}>
              <i className="dot" />
              结算<em>settle</em>
            </span>
            <span className="gnode recovery-node" style={{ right: '2%', top: '74%' }}>
              <i className="dot rose" />
              弹窗恢复
            </span>
          </div>
          <div className="event-log">
            <div className="event-row">
              <time>12:04:07</time>
              <b className="ev-node">node_entered</b>
              <span>dungeon</span>
              <em>fps 30</em>
            </div>
            <div className="event-row">
              <time>12:04:08</time>
              <b className="ev-edge">edge_matched</b>
              <span>e_start</span>
              <em>12ms</em>
            </div>
            <div className="event-row">
              <time>12:04:08</time>
              <b className="ev-act">action</b>
              <span>click · 0.1ms</span>
              <em>ok</em>
            </div>
          </div>
        </div>

        <div className="pane pane-side">
          <div className="pane-head">
            <span>识别器</span>
            <span className="pane-tools">3 个</span>
          </div>
          <div className="recognizer">
            <span className="thumb thumb-blue" />
            <div className="recog-meta">
              <div>
                <b>main_start</b>
                <em>0.94</em>
              </div>
              <div className="score-bar">
                <i style={{ width: '94%' }} />
                <u />
              </div>
            </div>
          </div>
          <div className="recognizer">
            <span className="thumb thumb-gold" />
            <div className="recog-meta">
              <div>
                <b>popup_close</b>
                <em>0.88</em>
              </div>
              <div className="score-bar">
                <i style={{ width: '88%' }} />
                <u />
              </div>
            </div>
          </div>
          <div className="recognizer">
            <span className="thumb thumb-red" />
            <div className="recog-meta">
              <div>
                <b>battle_hp</b>
                <em>0.71</em>
              </div>
              <div className="score-bar is-warn">
                <i style={{ width: '71%' }} />
                <u />
              </div>
            </div>
          </div>
          <div className="side-vars">
            <span className="side-title">变量</span>
            <div className="var-row">
              <b>$点击X</b>
              <em>0.42</em>
            </div>
            <div className="var-row">
              <b>$次数</b>
              <em>17</em>
            </div>
          </div>
          <div className="side-timeline">
            <span className="side-title">时间轴 · 60s</span>
            <div className="timeline">
              <i />
              <u />
            </div>
          </div>
        </div>
      </div>

      <div className="app-statusbar" aria-hidden="true">
        <span>node=dungeon</span>
        <span>tick=142</span>
        <span>fps 30</span>
        <span>capture 12ms</span>
        <span className="status-run">
          <i className="dot live" />
          运行 {clock}
        </span>
      </div>

      <div className="float-card float-score" aria-hidden="true">
        <span className="float-icon">
          <Icon name="target" />
        </span>
        <div>
          <small>识别命中</small>
          <strong>
            main_start <b>0.94</b>
          </strong>
          <div className="score-bar">
            <i style={{ width: '94%' }} />
          </div>
        </div>
      </div>

      <div className="float-card float-devices" aria-hidden="true">
        <div className="float-avatars">
          <span className="mini-screen">
            <img src={gameScene} alt="" />
          </span>
          <span className="mini-screen">
            <img src={gameScene} alt="" />
          </span>
          <span className="mini-screen">
            <img src={gameScene} alt="" />
          </span>
        </div>
        <div>
          <small>多开同步</small>
          <strong>3 台设备执行中</strong>
        </div>
      </div>
    </motion.div>
  );
}
