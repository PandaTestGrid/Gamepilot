import { useEffect, useRef, useState } from 'react';
import { animate, useInView, useReducedMotion } from 'motion/react';

/**
 * React Bits · CountUp（无 Tailwind 改写版）
 */
export default function CountUp({
  from = 0,
  to = 100,
  duration = 1.9,
  decimals = 0,
  className = ''
}) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const reduced = useReducedMotion();
  const [value, setValue] = useState(from);

  useEffect(() => {
    if (!inView) return undefined;
    if (reduced) {
      setValue(to);
      return undefined;
    }
    const controls = animate(from, to, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (latest) => setValue(latest)
    });
    return () => controls.stop();
  }, [inView, from, to, duration, reduced]);

  return (
    <span ref={ref} className={className}>
      {value.toFixed(decimals)}
    </span>
  );
}
