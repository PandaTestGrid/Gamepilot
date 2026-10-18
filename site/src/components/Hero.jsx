import { useRef } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import BlurText from '../reactbits/BlurText';
import Magnetic from '../reactbits/Magnetic';
import AppMockup from './AppMockup';
import Icon from './Icon';
import Stats from './Stats';

const EASE = [0.22, 0.61, 0.36, 1];

export default function Hero({ onDownload }) {
  const reduced = useReducedMotion();
  const heroRef = useRef(null);
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] });
  const copyY = useTransform(scrollYProgress, [0, 1], [0, 96]);
  const copyOpacity = useTransform(scrollYProgress, [0, 0.75, 1], [1, 0.72, 0.3]);
  const visualY = useTransform(scrollYProgress, [0, 1], [0, -44]);

  return (
    <section ref={heroRef} className="hero" aria-labelledby="hero-title">
      <div className="hero-bg" aria-hidden="true">
        <div className="hero-aurora" />
        <div className="hero-stars" />
        <div className="hero-grid" />
        <div className="hero-orb orb-a" />
        <div className="hero-orb orb-b" />
        <div className="hero-orb orb-c" />
      </div>

      <div className="container hero-inner">
        <motion.div className="hero-copy" style={reduced ? undefined : { y: copyY, opacity: copyOpacity }}>
          <motion.p
            className="eyebrow-pill"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE }}
          >
            <span className="ping" />
            v0.1.0 内测 · Tauri 2 桌面端 · 全程本地
          </motion.p>

          <h1 id="hero-title">
            <BlurText
              as="span"
              className="hero-line"
              text="把重复交给状态机"
              animateBy="chars"
              delay={55}
              threshold={0.1}
            />
            <br />
            <motion.span
              className="text-grad hero-line"
              initial={{ opacity: 0, filter: reduced ? 'blur(0px)' : 'blur(14px)', y: 12 }}
              animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
              transition={{ duration: 0.85, delay: 0.42, ease: EASE }}
            >
              把游戏还给乐趣
            </motion.span>
          </h1>

          <motion.p
            className="hero-lead"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.55, ease: EASE }}
          >
            GamePilot 是一款面向游戏的自动化工作台。框选界面即识别，拖拽连线即脚本，
            一台电脑同时驱动安卓、iPhone 与桌面窗口 —— 不写代码，画面不出本机。
          </motion.p>

          <motion.div
            className="hero-actions"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.68, ease: EASE }}
          >
            <Magnetic>
              <button className="btn btn-primary btn-lg" type="button" onClick={onDownload}>
                <Icon name="download" />
                免费下载
                <span className="btn-note">macOS / Windows</span>
              </button>
            </Magnetic>
            <a className="btn btn-ghost btn-lg" href="#workflow">
              <span className="play-dot">
                <Icon name="play" />
              </span>
              看它如何工作
            </a>
          </motion.div>

          <motion.ul
            className="hero-notes"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.7, delay: 0.82 }}
          >
            <li>
              <Icon name="check" />
              无需安装 Python
            </li>
            <li>
              <Icon name="check" />
              脚本即可读 JSON
            </li>
            <li>
              <Icon name="check" />
              画面不上传云端
            </li>
          </motion.ul>
        </motion.div>

        <motion.div
          className="hero-visual"
          initial={{ opacity: 0, y: 38, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 1, delay: 0.35, ease: EASE }}
          style={reduced ? undefined : { y: visualY }}
        >
          <AppMockup />
        </motion.div>

        <Stats />
      </div>
    </section>
  );
}
