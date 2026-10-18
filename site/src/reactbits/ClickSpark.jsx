import { useEffect, useRef } from 'react';
import { useReducedMotion } from 'motion/react';

/**
 * React Bits · ClickSpark（无 Tailwind 改写版，全局点击火花）
 */
export default function ClickSpark({
  color = '#7cc4ff',
  radius = 26,
  count = 8,
  duration = 460
}) {
  const canvasRef = useRef(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    let sparks = [];
    let raf = 0;
    let width = window.innerWidth;
    let height = window.innerHeight;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const tick = () => {
      ctx.clearRect(0, 0, width, height);
      const now = performance.now();
      sparks = sparks.filter((spark) => now - spark.start < duration);
      for (const spark of sparks) {
        const t = (now - spark.start) / duration;
        const eased = 1 - Math.pow(1 - t, 3);
        const dist = 4 + eased * radius;
        const len = 3 + (1 - t) * 8;
        ctx.strokeStyle = spark.color;
        ctx.globalAlpha = (1 - t) * 0.85;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(spark.x + Math.cos(spark.angle) * dist, spark.y + Math.sin(spark.angle) * dist);
        ctx.lineTo(
          spark.x + Math.cos(spark.angle) * (dist + len),
          spark.y + Math.sin(spark.angle) * (dist + len)
        );
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      raf = sparks.length ? requestAnimationFrame(tick) : 0;
    };

    const handlePointerDown = (event) => {
      const now = performance.now();
      for (let i = 0; i < count; i += 1) {
        sparks.push({
          x: event.clientX,
          y: event.clientY,
          angle: (Math.PI * 2 * i) / count + Math.random() * 0.4,
          start: now,
          color
        });
      }
      if (!raf) raf = requestAnimationFrame(tick);
    };

    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('pointerdown', handlePointerDown, { passive: true });
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointerdown', handlePointerDown);
      cancelAnimationFrame(raf);
      raf = 0;
      sparks = [];
    };
  }, [color, count, duration, radius, reduced]);

  return <canvas ref={canvasRef} className="click-spark-canvas" aria-hidden="true" />;
}
