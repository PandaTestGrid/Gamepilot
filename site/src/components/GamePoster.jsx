import { useId } from 'react';

const STARS = [
  [34, 62, 1.2],
  [78, 118, 0.9],
  [129, 44, 1.4],
  [168, 96, 0.8],
  [216, 58, 1.1],
  [258, 108, 0.7],
  [312, 52, 1.3],
  [352, 132, 0.9],
  [382, 84, 1],
  [58, 176, 0.8],
  [146, 158, 1.1],
  [332, 190, 0.7]
];

function Stars({ seed = 0, color = '#dfe9ff' }) {
  return (
    <g>
      {STARS.map(([x, y, r], index) => (
        <circle
          key={index}
          cx={(x + seed * 11) % 396}
          cy={y}
          r={r}
          fill={color}
          opacity={index % 3 === 0 ? 0.8 : 0.38}
        />
      ))}
    </g>
  );
}

const ART = {
  abyss(id, game) {
    const { accent, glow } = game.palette;
    return (
      <>
        <circle cx="298" cy="150" r="154" fill={`url(#${id}-glow)`} />
        <circle cx="298" cy="150" r="57" fill={accent} opacity="0.94" />
        <circle cx="298" cy="150" r="82" fill="none" stroke={accent} strokeOpacity="0.28" strokeDasharray="2 11" />
        <Stars />
        <path d="M0 330 L58 262 L104 302 L164 224 L232 306 L300 250 L400 334 V520 H0Z" fill="#150e33" opacity="0.92" />
        <path d="M0 372 L74 322 L142 366 L222 306 L302 366 L400 334 V520 H0Z" fill="#0d0824" />
        <path d="M0 452 Q116 398 218 438 T400 420 V520 H0Z" fill={`url(#${id}-deep)`} />
        <ellipse cx="204" cy="424" rx="200" ry="26" fill={glow} opacity="0.22" filter={`url(#${id}-soft)`} />
        <g transform="translate(196 402)">
          <path d="M0 0 C-24 12 -35 44 -31 78 L-8 74 L-4 28 L4 28 L8 74 L31 78 C35 44 24 12 0 0Z" fill="#050310" />
          <circle cx="0" cy="-14" r="10.5" fill="#050310" />
          <path d="M13 2 L46 -58" stroke="#a8d8ff" strokeWidth="2.4" strokeLinecap="round" opacity="0.9" />
          <path d="M42 -52 L50 -64 L46 -44Z" fill="#dbeeff" />
        </g>
      </>
    );
  },
  neon(id, game) {
    const { accent, glow } = game.palette;
    return (
      <>
        <defs>
          <clipPath id={`${id}-sun`}>
            <circle cx="200" cy="196" r="104" />
          </clipPath>
        </defs>
        <circle cx="200" cy="196" r="150" fill={`url(#${id}-glow)`} opacity="0.6" />
        <g clipPath={`url(#${id}-sun)`}>
          <rect x="90" y="80" width="220" height="240" fill={accent} opacity="0.9" />
          {[116, 136, 156, 176, 196, 216, 236, 256].map((y, i) => (
            <rect key={y} x="86" y={y} width="228" height={i % 2 ? 5 : 9} fill="#120624" opacity="0.85" />
          ))}
        </g>
        <circle cx="200" cy="196" r="104" fill="none" stroke={accent} strokeOpacity="0.25" />
        <Stars color="#ffd9f6" />
        <path d="M0 340 H400 V520 H0Z" fill="#080416" />
        <g stroke={accent} strokeOpacity="0.4" fill="none">
          <path d="M0 380 H400 M0 420 H400 M0 468 H400" />
          <path d="M200 340 L200 520 M140 340 L96 520 M260 340 L304 520 M80 340 L-18 520 M320 340 L418 520" />
        </g>
        <g fill="#05020e">
          <rect x="18" y="270" width="36" height="120" />
          <rect x="70" y="300" width="26" height="90" />
          <rect x="112" y="252" width="40" height="138" />
          <rect x="286" y="288" width="34" height="102" />
          <rect x="336" y="258" width="44" height="132" />
        </g>
        <g fill={glow} opacity="0.65">
          <rect x="30" y="284" width="4" height="30" />
          <rect x="42" y="284" width="4" height="18" />
          <rect x="124" y="266" width="4" height="42" />
          <rect x="138" y="266" width="4" height="24" />
          <rect x="350" y="274" width="4" height="32" />
        </g>
        <ellipse cx="200" cy="340" rx="220" ry="22" fill={accent} opacity="0.24" filter={`url(#${id}-soft)`} />
      </>
    );
  },
  orbit(id, game) {
    const { accent, glow } = game.palette;
    return (
      <>
        <Stars seed={2} />
        <circle cx="294" cy="356" r="164" fill={`url(#${id}-glow)`} />
        <circle cx="294" cy="356" r="112" fill={accent} opacity="0.2" />
        <circle cx="294" cy="356" r="96" fill={game.palette.sky[0]} opacity="0.75" />
        <ellipse cx="276" cy="352" rx="196" ry="52" fill="none" stroke={accent} strokeOpacity="0.55" strokeWidth="2" transform="rotate(-16 276 352)" />
        <ellipse cx="276" cy="352" rx="150" ry="34" fill="none" stroke={glow} strokeOpacity="0.4" transform="rotate(-16 276 352)" strokeDasharray="3 9" />
        <g stroke={accent} strokeWidth="1.4" fill="none" opacity="0.8">
          <path d="M52 118 L126 118 L156 148 L156 190" />
          <rect x="126" y="104" width="22" height="14" />
          <rect x="92" y="128" width="34" height="18" />
          <circle cx="52" cy="118" r="3" fill={accent} />
        </g>
        <g fill="#06121f" opacity="0.9">
          <path d="M0 470 L70 430 L142 470 L400 424 V520 H0Z" />
        </g>
        <circle cx="88" cy="210" r="2" fill={accent} />
        <circle cx="150" cy="250" r="1.4" fill="#dff7ff" />
      </>
    );
  },
  flora(id, game) {
    const { accent, glow } = game.palette;
    return (
      <>
        <circle cx="286" cy="132" r="128" fill={`url(#${id}-glow)`} />
        <circle cx="286" cy="132" r="46" fill={accent} opacity="0.82" />
        <Stars color="#d8ffe9" />
        <path d="M0 392 L94 250 L166 360 L232 274 L320 392 L400 330 V520 H0Z" fill="#061c1a" opacity="0.85" />
        <g transform="translate(196 322)">
          <path d="M-96 26 Q0 -22 96 26 Q42 54 0 56 Q-46 52 -96 26Z" fill="#0a2a22" />
          <path d="M-52 42 Q0 78 52 42 L30 110 Q0 126 -30 110Z" fill="#071a16" />
          <path d="M-34 8 L-14 -22 L2 8Z" fill="#103d2d" />
          <path d="M18 2 L38 -34 L54 2Z" fill="#0d3528" />
          <path d="M-6 12 L4 -6 L12 12Z" fill="#15533a" />
          <path d="M50 38 Q58 80 50 118" stroke={glow} strokeWidth="3" opacity="0.55" fill="none" />
        </g>
        <g stroke="#9dffcf" strokeWidth="1.2" opacity="0.5" fill="none">
          <path d="M96 206 q8 -10 16 0 q-8 10 -16 0Z" />
          <path d="M300 224 q7 -9 14 0 q-7 9 -14 0Z" />
        </g>
        <circle cx="118" cy="270" r="2" fill="#b9ffdf" opacity="0.7" />
        <circle cx="318" cy="288" r="1.6" fill="#b9ffdf" opacity="0.5" />
      </>
    );
  },
  crown(id, game) {
    const { accent, glow } = game.palette;
    return (
      <g>
        <circle cx="200" cy="268" r="180" fill={`url(#${id}-glow)`} opacity="0.55" />
        <g stroke={accent} strokeOpacity="0.16" fill="none">
          {[40, 80, 120, 160].map((r) => (
            <circle key={r} cx="200" cy="268" r={r} />
          ))}
          <path d="M200 88 V448 M20 268 H380 M74 142 L326 394 M326 142 L74 394" />
        </g>
        <Stars color="#ffe7c0" />
        <path d="M108 420 L188 206 M292 420 L212 206" stroke="#f5e6cb" strokeWidth="6" strokeLinecap="round" />
        <path d="M188 206 L178 184 L204 196Z" fill="#ffe8b6" />
        <path d="M212 206 L222 184 L196 196Z" fill="#ffe8b6" />
        <g fill="#f4c557">
          <path d="M104 274 L128 228 L162 264 L200 208 L238 264 L272 228 L296 274 L282 356 L118 356Z" />
          <rect x="118" y="356" width="164" height="24" rx="4" />
        </g>
        <g fill="#ffe9ad">
          <path d="M104 274 L128 228 L140 246 L126 280Z" opacity="0.55" />
          <circle cx="200" cy="302" r="7" />
          <circle cx="158" cy="314" r="4" fill={glow} />
          <circle cx="242" cy="314" r="4" fill={glow} />
        </g>
        <path d="M0 448 Q100 424 200 440 T400 436 V520 H0Z" fill="#0d0407" />
        {[[92, 180], [310, 196], [264, 150], [136, 144]].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={1.6} fill={accent} opacity="0.8" />
        ))}
      </g>
    );
  },
  pixel(id, game) {
    const { accent, glow } = game.palette;
    return (
      <>
        <defs>
          <pattern id={`${id}-grid`} width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0 H0 V20" fill="none" stroke="#ff9dc0" strokeOpacity="0.12" />
          </pattern>
        </defs>
        <rect width="400" height="520" fill={`url(#${id}-grid)`} />
        <g fill={accent} opacity="0.9">
          {Array.from({ length: 8 }).map((_, row) =>
            Array.from({ length: 8 }).map((_, col) => {
              const x = 236 + col * 14;
              const y = 64 + row * 14;
              const dx = x - 286;
              const dy = y - 118;
              return Math.abs(dx) < 78 && Math.abs(dy) < 78 && (row + col) % 7 !== 0 ? (
                <rect key={`${row}-${col}`} x={x} y={y} width="12" height="12" />
              ) : null;
            })
          )}
        </g>
        <g fill="#2a0d2a">
          <path d="M0 360 L40 320 L80 360 L120 312 L160 360 L200 332 L240 360 L280 320 L320 356 L360 328 L400 360 V520 H0Z" />
        </g>
        <g fill="#190b20">
          <path d="M0 430 L64 392 L128 430 L192 398 L256 434 L320 396 L400 430 V520 H0Z" />
        </g>
        <g transform="translate(198 330)">
          <g fill="#f0b985">
            <rect x="0" y="26" width="52" height="42" />
            <rect x="4" y="18" width="44" height="10" fill="#8f5a4a" />
            <rect x="12" y="34" width="10" height="10" fill="#5a2b39" />
            <rect x="32" y="34" width="10" height="10" fill="#5a2b39" />
            <rect x="20" y="50" width="12" height="18" fill="#5a2b39" />
          </g>
          <g fill="#0f2a1c">
            <rect x="-14" y="68" width="84" height="8" />
            <rect x="-22" y="76" width="100" height="6" />
          </g>
        </g>
        <g fill={glow} opacity="0.7">
          <rect x="52" y="286" width="10" height="10" />
          <rect x="70" y="300" width="6" height="6" />
          <rect x="330" y="276" width="8" height="8" />
        </g>
        <Stars seed={3} color="#ffd7e7" />
      </>
    );
  },
  frost(id, game) {
    const { accent, glow } = game.palette;
    return (
      <>
        <circle cx="286" cy="126" r="118" fill={`url(#${id}-glow)`} opacity="0.7" />
        <circle cx="286" cy="126" r="38" fill="#e8f8ff" opacity="0.9" />
        <path d="M-20 200 C80 96 160 160 250 88 C310 40 380 90 420 60 V230 C340 264 280 210 210 244 C130 282 60 228 -20 260Z" fill={glow} opacity="0.18" filter={`url(#${id}-soft)`} />
        <path d="M-20 214 C90 140 150 190 246 120 C310 74 380 116 420 88" fill="none" stroke="#8be6ff" strokeWidth="3" opacity="0.4" />
        <Stars color="#d9f4ff" />
        <path d="M0 400 L62 246 L108 318 L162 202 L224 336 L276 262 L330 352 L400 280 V520 H0Z" fill="#071a2d" />
        <path d="M0 430 L86 330 L142 388 L206 300 L268 392 L338 332 L400 396 V520 H0Z" fill="#04101f" />
        <g fill="#bfefff" opacity="0.8">
          <path d="M60 470 L74 430 L88 470 L74 492Z" />
          <path d="M316 486 L330 442 L346 486 L330 506Z" />
          <path d="M188 470 L200 444 L212 470 L200 484Z" opacity="0.55" />
        </g>
        <g fill="#eafcff" opacity="0.5">
          <circle cx="98" cy="386" r="1.6" />
          <circle cx="252" cy="356" r="1.2" />
          <circle cx="344" cy="410" r="1.8" />
        </g>
      </>
    );
  },
  ember(id, game) {
    const { accent, glow } = game.palette;
    return (
      <>
        <circle cx="200" cy="330" r="190" fill={`url(#${id}-glow)`} opacity="0.7" />
        <Stars color="#ffd2b0" />
        <path d="M0 420 L118 206 L254 420Z" fill="#120506" />
        <path d="M118 206 L96 420 H150 L118 206Z" fill="#ff7a35" opacity="0.5" />
        <path d="M118 206 L142 294 L122 306 L104 270Z" fill="#ffb15c" opacity="0.8" />
        <path d="M254 420 L312 300 L400 420Z" fill="#170708" />
        <path d="M0 430 Q100 404 200 430 T400 424 V520 H0Z" fill="#080203" />
        <g stroke={accent} strokeWidth="2" opacity="0.55" fill="none">
          <path d="M62 452 L110 484 M190 438 L236 490 M300 452 L338 492 M148 502 L128 482" />
        </g>
        <g fill={accent}>
          {[[92, 180, 2], [146, 146, 1.4], [228, 130, 2.2], [300, 188, 1.6], [342, 152, 1.2], [180, 214, 1.4], [268, 236, 1.1], [70, 260, 1.6]].map(([x, y, r], i) => (
            <circle key={i} cx={x} cy={y} r={r} opacity="0.8" />
          ))}
        </g>
        <g fill="#2a0d0a" opacity="0.8">
          <path d="M170 206 Q200 150 232 206 Q214 190 200 206 Q186 188 170 206Z" />
        </g>
      </>
    );
  },
  tide(id, game) {
    const { accent, glow } = game.palette;
    return (
      <>
        <g opacity="0.4">
          <path d="M40 0 L110 340 L142 340 L100 0Z" fill={glow} filter={`url(#${id}-soft)`} />
          <path d="M196 0 L236 340 L268 340 L250 0Z" fill={glow} filter={`url(#${id}-soft)`} />
          <path d="M320 0 L352 340 L380 340 L360 0Z" fill={glow} filter={`url(#${id}-soft)`} />
        </g>
        <Stars color="#aef7ff" />
        <g fill="#041924" opacity="0.92">
          <path d="M0 272 L54 240 L92 272 V360 H0Z" />
          <path d="M96 300 L140 268 L184 300 V380 H96Z" />
          <path d="M238 286 L286 246 L336 286 V374 H238Z" />
          <path d="M298 330 L340 306 L382 330 V400 H298Z" />
        </g>
        <g fill={accent} opacity="0.6">
          <rect x="30" y="286" width="5" height="9" />
          <rect x="43" y="300" width="5" height="9" />
          <rect x="122" y="314" width="5" height="9" />
          <rect x="262" y="300" width="5" height="9" />
          <rect x="318" y="340" width="5" height="9" />
        </g>
        <g fill="none" stroke={glow} strokeWidth="2.4" opacity="0.65">
          <path d="M-20 420 Q40 398 100 420 T220 420 T340 420 T460 420" />
          <path d="M-20 452 Q40 430 100 452 T220 452 T340 452 T460 452" opacity="0.5" />
        </g>
        <g fill="#0a2a2f">
          <path d="M70 500 q-8 -34 10 -52 q6 22 0 52Z" />
          <path d="M92 500 q4 -28 22 -38 q-2 24 -10 38Z" />
          <path d="M308 506 q-6 -30 10 -46 q8 22 0 46Z" />
          <path d="M330 508 q2 -26 18 -34 q0 22 -8 34Z" />
        </g>
        {[[72, 196, 3], [148, 168, 2], [236, 208, 2.4], [312, 160, 3.2], [354, 224, 2], [104, 252, 1.4]].map(([x, y, r], i) => (
          <circle key={i} cx={x} cy={y} r={r} fill="none" stroke={accent} strokeOpacity="0.4" />
        ))}
      </>
    );
  },
  void(id, game) {
    const { accent, glow } = game.palette;
    return (
      <>
        <Stars seed={1} color="#e8dcff" />
        <circle cx="206" cy="266" r="170" fill={`url(#${id}-glow)`} opacity="0.5" />
        <ellipse cx="206" cy="266" rx="186" ry="38" fill="none" stroke={accent} strokeWidth="2.2" transform="rotate(-18 206 266)" />
        <ellipse cx="206" cy="266" rx="150" ry="22" fill="none" stroke={glow} strokeOpacity="0.55" transform="rotate(-18 206 266)" />
        <circle cx="206" cy="266" r="86" fill="#030108" />
        <circle cx="206" cy="266" r="86" fill="none" stroke={accent} strokeWidth="3" strokeOpacity="0.8" />
        <circle cx="206" cy="266" r="100" fill="none" stroke={accent} strokeOpacity="0.18" strokeDasharray="1 7" />
        <path d="M120 266 A86 86 0 0 1 292 266" fill="none" stroke="#fff" strokeOpacity="0.28" strokeWidth="1.4" />
        <g transform="translate(330 140) rotate(18)">
          <rect x="-14" y="-5" width="28" height="10" rx="3" fill="#d9ccff" />
          <rect x="14" y="-2" width="10" height="4" fill={accent} />
        </g>
        <path d="M0 500 Q100 470 200 492 T400 484 V520 H0Z" fill="#05030c" />
      </>
    );
  },
  solar(id, game) {
    const { accent, glow } = game.palette;
    return (
      <>
        <circle cx="132" cy="172" r="146" fill={`url(#${id}-glow)`} />
        <circle cx="132" cy="172" r="52" fill={accent} opacity="0.9" />
        <circle cx="286" cy="220" r="34" fill={accent} opacity="0.55" />
        <g opacity="0.4" stroke={accent}>
          {[0, 1, 2].map((i) => (
            <circle key={i} cx="132" cy="172" r={72 + i * 16} fill="none" strokeDasharray="2 8" />
          ))}
        </g>
        <Stars color="#ffe7bd" />
        <path d="M0 400 Q84 340 176 392 T400 372 V520 H0Z" fill="#3a1a06" />
        <path d="M0 448 Q120 398 238 446 T400 426 V520 H0Z" fill="#1e0c03" />
        <g fill="#0f0602">
          <path d="M214 448 L230 270 L246 448Z" />
          <rect x="222" y="270" width="12" height="14" />
          <path d="M74 452 L80 420 L86 452Z" />
          <path d="M98 456 L104 424 L110 456Z" />
          <path d="M122 458 L128 430 L134 458Z" />
        </g>
        <path d="M230 284 L258 300" stroke={accent} strokeWidth="2" opacity="0.5" />
        <path d="M0 480 Q120 450 240 480 T400 470" stroke={accent} strokeOpacity="0.25" fill="none" strokeDasharray="4 12" />
      </>
    );
  },
  bloom(id, game) {
    const { accent, glow } = game.palette;
    return (
      <>
        <circle cx="288" cy="140" r="136" fill={`url(#${id}-glow)`} opacity="0.7" />
        <circle cx="288" cy="140" r="48" fill="#ffe6f1" opacity="0.92" />
        <Stars color="#ffe1ef" />
        <path d="M0 380 L84 310 L160 372 L236 300 L320 376 L400 330 V520 H0Z" fill="#24122e" opacity="0.75" />
        <g fill="#160a20">
          <path d="M0 470 Q120 430 240 470 T400 458 V520 H0Z" />
        </g>
        <g transform="translate(182 306)">
          <path d="M-86 18 Q0 2 86 18 L80 30 Q0 16 -80 30Z" fill="#3a1632" />
          <rect x="-62" y="28" width="12" height="94" fill="#2a0f28" />
          <rect x="50" y="28" width="12" height="94" fill="#2a0f28" />
          <path d="M-98 52 Q0 36 98 52 L94 64 Q0 50 -94 64Z" fill="#3a1632" />
          <path d="M-6 10 L0 -10 L6 10Z" fill={accent} opacity="0.7" />
        </g>
        <g fill={accent} opacity="0.75">
          {[[62, 120, 3, 12], [126, 208, 2, -18], [330, 96, 2.4, 24], [262, 264, 1.8, -10], [96, 316, 2, 42], [352, 316, 2.2, -34]].map(([x, y, r, rot], i) => (
            <ellipse key={i} cx={x} cy={y} rx={r} ry={r * 1.7} transform={`rotate(${rot} ${x} ${y})`} opacity="0.5" />
          ))}
        </g>
        <g fill="#ffb6d4" opacity="0.55">
          <circle cx="118" cy="206" r="1.6" />
          <circle cx="300" cy="250" r="1.4" />
          <circle cx="180" cy="90" r="1.2" />
        </g>
      </>
    );
  }
};


function coverSrc(src) {
  if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) return src;
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/$/, '')}/${src.replace(/^\.?\//, '')}`;
}

export default function GamePoster({ game, className = '' }) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const id = `gp${rawId}`;

  if (game.cover) {
    return (
      <img
        className={`game-art poster-art ${className}`}
        src={coverSrc(game.cover)}
        alt={`${game.title} 场景封面`}
        loading="lazy"
      />
    );
  }

  const render = ART[game.art] || ART.abyss;
  return (
    <svg
      className={`game-art poster-art ${className}`}
      viewBox="0 0 400 520"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={game.palette.sky[0]} />
          <stop offset="0.55" stopColor={game.palette.sky[1]} />
          <stop offset="1" stopColor={game.palette.sky[2]} />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor={game.palette.accent} stopOpacity="0.85" />
          <stop offset="0.42" stopColor={game.palette.glow} stopOpacity="0.38" />
          <stop offset="1" stopColor={game.palette.glow} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-vig`} cx="50%" cy="44%" r="72%">
          <stop offset="0.55" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.55" />
        </radialGradient>
        <linearGradient id={`${id}-deep`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={game.palette.sky[2]} stopOpacity="0.2" />
          <stop offset="1" stopColor="#02030a" stopOpacity="0.95" />
        </linearGradient>
        <filter id={`${id}-soft`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="12" />
        </filter>
      </defs>
      <rect width="400" height="520" fill={`url(#${id}-sky)`} />
      {render(id, game)}
      <rect width="400" height="520" fill={`url(#${id}-vig)`} />
    </svg>
  );
}
