import { useRef } from 'react';
import { motion, useInView, useReducedMotion } from 'motion/react';

const EASE = [0.22, 0.61, 0.36, 1];

/**
 * React Bits · BlurText（无 Tailwind 改写版）
 * 逐字 / 逐词从模糊中浮现，进入视口时触发一次。
 */
export default function BlurText({
  text = '',
  className = '',
  delay = 60,
  animateBy = 'words',
  startDelay = 0,
  direction = 'top',
  threshold = 0.2,
  as: Tag = 'span',
  ...rest
}) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: threshold });
  const reduced = useReducedMotion();
  const parts = animateBy === 'chars' ? Array.from(text) : text.split(' ');
  const offset = direction === 'top' ? -18 : 18;

  return (
    <Tag ref={ref} className={`blur-text ${className}`.trim()} {...rest}>
      {parts.map((part, i) => (
        <motion.span
          key={`${part}-${i}`}
          aria-hidden="true"
          initial={{
            opacity: 0,
            filter: reduced ? 'blur(0px)' : 'blur(10px)',
            y: reduced ? 0 : offset
          }}
          animate={inView ? { opacity: 1, filter: 'blur(0px)', y: 0 } : undefined}
          transition={{
            duration: reduced ? 0 : 0.68,
            delay: reduced ? 0 : startDelay + (i * delay) / 1000,
            ease: EASE
          }}
          style={{ display: 'inline-block', whiteSpace: 'pre' }}
        >
          {part}
          {animateBy === 'words' && i < parts.length - 1 ? ' ' : ''}
        </motion.span>
      ))}
      <span className="sr-only">{text}</span>
    </Tag>
  );
}
