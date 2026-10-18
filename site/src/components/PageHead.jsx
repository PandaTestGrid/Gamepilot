import { motion, useReducedMotion } from 'motion/react';
import Reveal from './Reveal';

export default function PageHead({ eyebrow, title, lead, children, align = 'left' }) {
  const reduced = useReducedMotion();

  return (
    <header className={`page-head page-head-${align}`}>
      <Reveal as="p" className="eyebrow">
        {eyebrow}
      </Reveal>
      <motion.h1
        initial={reduced ? false : { opacity: 0, y: 18, filter: 'blur(8px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.7, ease: [0.22, 0.61, 0.36, 1] }}
      >
        {title}
      </motion.h1>
      {lead ? (
        <Reveal as="p" className="page-lead" delay={0.08}>
          {lead}
        </Reveal>
      ) : null}
      {children ? <div className="page-head-extra">{children}</div> : null}
    </header>
  );
}
