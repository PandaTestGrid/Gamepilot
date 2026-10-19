import TechText from '../reactbits/TechText';
import Reveal from './Reveal';
import DecryptedText from '../reactbits/DecryptedText';

export default function TechBand() {
  return (
    <section className="tech-band" aria-labelledby="techband-title">
      <div className="tech-band-grid" aria-hidden="true" />
      <div className="container tech-band-inner">
        <div className="tech-band-head">
          <Reveal as="p" className="eyebrow">
            ENGINE CORE · 引擎
          </Reveal>
          <Reveal as="p" className="tech-band-sub" delay={0.06}>
            不是录制回放，是一台每一帧都在“看”和“判断”的状态机。
          </Reveal>
        </div>

        <h2 id="techband-title" className="sr-only">
          GamePilot 引擎核心
        </h2>

        <div className="tech-band-word">
          <TechText
            text="GAMEPILOT"
            fontSize={240}
            fontWeight={750}
            letterSpacing={-0.035}
            color="#e6e8ee"
            accentColor="#4da3ff"
            lineStyle="dashed"
            dashLength={4}
            dashGap={2.5}
            strokeWidth={1.4}
            reach={240}
            softness={0.66}
            reveal="area"
            specks={22}
            labels
            draggable
            bounce={0.38}
            sweep
            speed={1}
            clickKick
            intro="assemble"
            introDuration={2.1}
          />
        </div>

        <div className="tech-band-foot">
          <DecryptedText
            text="STATE MACHINE"
            animateOn="view"
            speed={30}
            maxIterations={10}
            className="tech-decrypt"
          />
          <span>FRAME RECOGNITION</span>
          <span>MULTI-DEVICE HID</span>
          <span className="tech-band-hint">
            <i className="dot live" />
            <span className="hint-wide">移动鼠标 · 拖拽字母</span>
            <span className="hint-touch">触摸字母 · 拖拽试试</span>
          </span>
        </div>
      </div>
    </section>
  );
}
