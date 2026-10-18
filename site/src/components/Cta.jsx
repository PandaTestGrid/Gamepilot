import { motion, useReducedMotion } from 'motion/react';
import BlurText from '../reactbits/BlurText';
import Magnetic from '../reactbits/Magnetic';
import StarBorder from '../reactbits/StarBorder';
import Icon from './Icon';
import Reveal from './Reveal';

export default function Cta({ onDownload }) {
  const reduced = useReducedMotion();

  return (
    <section className="cta-section" id="download" aria-labelledby="cta-title">
      <div className="container">
        <Reveal amount={0.1}>
          <StarBorder className="cta-star" speed={7}>
            <div className="cta-card">
              <div className="cta-aurora" aria-hidden="true" />
              <div className="cta-glow" aria-hidden="true" />
              <span className="eyebrow-pill">
                <span className="ping" />
                内测招募中 · v0.1.0
              </span>
              <h2 id="cta-title">
                <BlurText as="span" text="让脚本自己跑，" animateBy="chars" delay={30} />
                <br />
                <motion.span
                  className="text-grad"
                  initial={{ opacity: 0, filter: reduced ? 'blur(0px)' : 'blur(12px)' }}
                  whileInView={{ opacity: 1, filter: 'blur(0px)' }}
                  viewport={{ once: true, amount: 0.4 }}
                  transition={{ duration: 0.8, delay: 0.25 }}
                >
                  你去睡觉
                </motion.span>
              </h2>
              <p>连接设备、框选界面、点运行。剩下的交给状态机 —— 掉线、弹窗、卡住，它自己找路。</p>
              <div className="cta-actions">
                <Magnetic>
                  <button className="btn btn-primary btn-lg" type="button" onClick={onDownload}>
                    <Icon name="download" />
                    免费下载
                  </button>
                </Magnetic>
                <a className="btn btn-ghost btn-lg" href="#workflow">
                  先看看怎么用
                </a>
              </div>
              <p className="cta-note">macOS / Windows · 无需安装 Python · 安装包约 150 MB</p>
            </div>
          </StarBorder>
        </Reveal>
      </div>
    </section>
  );
}
