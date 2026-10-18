import { motion, useReducedMotion } from 'motion/react';

const EASE = [0.22, 0.61, 0.36, 1];

export default function Reveal({
  children,
  className = '',
  as = 'div',
  delay = 0,
  y = 18,
  amount = 0.15,
  once = true,
  spotlight = false,
  spotlightColor = 'rgba(77, 163, 255, 0.16)',
  ...rest
}) {
  const reduced = useReducedMotion();
  const Comp = motion[as] || motion.div;
  const spotlightProps = spotlight
    ? {
        className: `spotlight-card ${className}`.trim(),
        style: { '--spot-color': spotlightColor },
        onPointerMove: (event) => {
          const el = event.currentTarget;
          const rect = el.getBoundingClientRect();
          el.style.setProperty('--spot-x', `${event.clientX - rect.left}px`);
          el.style.setProperty('--spot-y', `${event.clientY - rect.top}px`);
        },
        onPointerLeave: (event) => {
          const el = event.currentTarget;
          el.style.setProperty('--spot-x', '50%');
          el.style.setProperty('--spot-y', '0px');
        }
      }
    : { className };

  return (
    <Comp
      {...spotlightProps}
      initial={{ opacity: 0, y: reduced ? 0 : y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once, amount, margin: '0px 0px -60px 0px' }}
      transition={{ duration: reduced ? 0 : 0.72, delay: reduced ? 0 : delay, ease: EASE }}
      {...rest}
    >
      {children}
    </Comp>
  );
}
