import { useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { gameScene } from '../assets/images';
import BlurText from '../reactbits/BlurText';
import Icon from './Icon';
import Reveal from './Reveal';

const TABS = [
  { id: 'android', label: 'Android', sub: '真机 / 模拟器', icon: 'phone' },
  { id: 'ios', label: 'iOS', sub: '17.4+ 真机', icon: 'phone' },
  { id: 'mac', label: 'macOS 窗口', sub: '本机任意 App', icon: 'monitor' },
  { id: 'mock', label: 'Mock', sub: '离线开发 / CI', icon: 'terminal' }
];

function AndroidPanel() {
  return (
    <>
      <div className="device-copy">
        <span className="chip">adb · scrcpy · 实时控制</span>
        <h3>安卓真机与模拟器，一根线开始</h3>
        <p>
          通过 adb 发现设备、scrcpy 拉流与下发触控。点击指令走控制通道，延迟远低于 <code>adb shell input tap</code>；
          旋转、分辨率变化每帧同步。
        </p>
        <ul className="check-list">
          <li>
            <Icon name="check" />
            真机 / MuMu / 雷电等模拟器统一成一行
          </li>
          <li>
            <Icon name="check" />
            模拟器多屏可单独添加、物理屏 ID 保持会话
          </li>
          <li>
            <Icon name="check" />
            未授权、离线、掉线都有可执行的修复提示
          </li>
        </ul>
        <code className="endpoint">Android://emulator-5554</code>
      </div>
      <div className="device-visual">
        <div className="phone-frame is-large">
          <img src={gameScene} alt="安卓设备投屏示意" loading="lazy" />
          <span className="recog-box box-a">
            <em>主城 0.94</em>
          </span>
        </div>
        <span className="visual-tag tag-fps">
          <i className="dot live" />
          30 fps · 12ms
        </span>
        <span className="visual-tag tag-touch">
          <Icon name="zap" />
          0.1ms 触控
        </span>
      </div>
    </>
  );
}

function IosPanel() {
  return (
    <>
      <div className="device-copy">
        <span className="chip">iOS 17.4+ · 用户态隧道</span>
        <h3>iPhone 也能进同一张状态图</h3>
        <p>
          通过 pymobiledevice3 的 RSD 隧道投屏与 CoreDevice HID 控制，不需要 sudo、不切 USB 配置。
          8fps 左右的截图循环，足够模板匹配与自动化判断。
        </p>
        <ul className="check-list">
          <li>
            <Icon name="check" />
            触摸、滑动、Home 键与键盘输入
          </li>
          <li>
            <Icon name="check" />
            自动过滤低于 iOS 17.4 的设备
          </li>
          <li>
            <Icon name="check" />
            方向码过期时按画面比例兜底
          </li>
        </ul>
        <code className="endpoint">iOS://00008130-000A1C2E3F</code>
      </div>
      <div className="device-visual">
        <div className="phone-frame is-large is-ios">
          <img src={gameScene} alt="iOS 设备投屏示意" loading="lazy" />
          <span className="island" />
          <span className="recog-box box-b">
            <em>任务 0.78</em>
          </span>
        </div>
        <span className="visual-tag tag-fps">
          <i className="dot live" />
          7.8 fps · 128ms
        </span>
        <span className="visual-tag tag-touch">
          <Icon name="zap" />
          HID 触控
        </span>
      </div>
    </>
  );
}

function MacPanel() {
  return (
    <>
      <div className="device-copy">
        <span className="chip">CGWindowList · CGEvent</span>
        <h3>把任意桌面窗口，当成一台设备</h3>
        <p>
          枚举本机窗口，只抓目标窗口的画面（被遮挡也不影响），再用 CGEvent 把点击与键盘送进去。默认{' '}
          <code>pid</code> 直投不动你的鼠标，需要时切 <code>global</code> 获得和真人一致的可靠性。
        </p>
        <ul className="check-list">
          <li>
            <Icon name="check" />
            窗口移动、改尺寸后手势开始即刷新几何
          </li>
          <li>
            <Icon name="check" />
            支持按句柄直连：<code>Mac:///?window=89</code>
          </li>
          <li>
            <Icon name="check" />
            缺权限时明确提示去哪里打开
          </li>
        </ul>
        <code className="endpoint">Mac:///?window=89&amp;post=pid</code>
      </div>
      <div className="device-visual">
        <div className="desktop-frame">
          <div className="desktop-bar">
            <i />
            <i />
            <i />
            <span>Finder</span>
          </div>
          <div className="desktop-screen">
            <div className="desk-side">
              <i />
              <i />
              <i />
              <i />
            </div>
            <div className="desk-main">
              <span className="desk-node" />
              <span className="desk-node" />
              <span className="desk-node" />
              <svg viewBox="0 0 100 60" aria-hidden="true">
                <path d="M20 20h34l16 18M20 20v22" />
              </svg>
            </div>
          </div>
        </div>
        <span className="visual-tag tag-touch">
          <Icon name="lock" />
          pid 直投 · 鼠标不动
        </span>
      </div>
    </>
  );
}

function MockPanel() {
  return (
    <>
      <div className="device-copy">
        <span className="chip">Mock · 离线 · 可测试</span>
        <h3>没有设备，也能把流程跑通</h3>
        <p>
          Mock 设备用本地图片模拟画面与输入，端到端测试不需要真机、不需要模拟器。引擎与前端用同一条
          JSON-RPC 契约通信，CI 里也能跑状态机用例。
        </p>
        <ul className="check-list">
          <li>
            <Icon name="check" />
            离线复现坐标、旋转与识别问题
          </li>
          <li>
            <Icon name="check" />
            状态机、恢复边、超时重试单测
          </li>
          <li>
            <Icon name="check" />
            与真机共用同一套 RPC 命令
          </li>
        </ul>
        <code className="endpoint">Mock://local</code>
      </div>
      <div className="device-visual">
        <div className="terminal-frame">
          <div className="terminal-bar">
            <span />
            <span />
            <span />
            <em>engine · mock</em>
          </div>
          <pre>
            <code>
              <span className="t-dim">$</span> gamepilot-engine --device mock{'\n'}
              <span className="t-ok">✓</span> session started{'\n'}
              <span className="t-dim">→</span> device.list <span className="t-ok">1 device</span>
              {'\n'}
              <span className="t-dim">→</span> device.connect <span className="t-ok">ok</span>
              {'\n'}
              <span className="t-dim">→</span> state.tick <span className="t-ok">node=main</span>
              {'\n'}
              <span className="t-dim">→</span> edge_matched e_start{'\n'}
              <span className="t-dim">→</span> action_executed click
            </code>
          </pre>
        </div>
        <span className="visual-tag tag-touch">
          <Icon name="refresh" />
          CI 可复现
        </span>
      </div>
    </>
  );
}

const PANELS = {
  android: AndroidPanel,
  ios: IosPanel,
  mac: MacPanel,
  mock: MockPanel
};

export default function Devices() {
  const [active, setActive] = useState('android');
  const tabRefs = useRef([]);
  const reduced = useReducedMotion();
  const Panel = PANELS[active];

  const handleKeyDown = (event, index) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    let next = index;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = TABS.length - 1;
    setActive(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className="section" id="devices" aria-labelledby="devices-title">
      <div className="container">
        <div className="section-head">
          <Reveal as="p" className="eyebrow">
            设备矩阵
          </Reveal>
          <h2 id="devices-title">
            <BlurText as="span" text="一台电脑，接入你手边的所有屏幕" animateBy="chars" delay={18} />
          </h2>
          <Reveal as="p" className="section-lead" delay={0.08}>
            同一套坐标、同一张状态图。设备只是“输入端”，脚本不需要为每台机器重写。
          </Reveal>
        </div>

        <Reveal className="device-shell" spotlight amount={0.08}>
          <div className="device-tabs" role="tablist" aria-label="设备类型">
            {TABS.map((tab, index) => (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[index] = el;
                }}
                className={`device-tab${active === tab.id ? ' is-active' : ''}`}
                id={`tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={active === tab.id}
                aria-controls={`panel-${tab.id}`}
                tabIndex={active === tab.id ? 0 : -1}
                onClick={() => setActive(tab.id)}
                onKeyDown={(event) => handleKeyDown(event, index)}
              >
                <span className="tab-ico">
                  <Icon name={tab.icon} />
                </span>
                <span>
                  <b>{tab.label}</b>
                  <small>{tab.sub}</small>
                </span>
                <Icon name="arrow" className="tab-arrow" />
              </button>
            ))}
          </div>

          <div className="device-panels">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={active}
                className="device-panel is-active"
                id={`panel-${active}`}
                role="tabpanel"
                aria-labelledby={`tab-${active}`}
                initial={{ opacity: 0, y: reduced ? 0 : 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: reduced ? 0 : -8 }}
                transition={{ duration: reduced ? 0 : 0.28, ease: [0.22, 0.61, 0.36, 1] }}
              >
                <Panel />
              </motion.div>
            </AnimatePresence>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
