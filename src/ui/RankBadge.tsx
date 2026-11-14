import { clsx } from 'clsx';
import type { Rank } from '../types';

/**
 * Погон сотрудника органов внутренних дел РФ (приказ МВД России № 575).
 *
 * Геометрия: горизонтальный погон 160 × 60 (1 единица viewBox = 1 мм),
 * верхний край скруглён, поле — тёмно-синий галун, по всему периметру
 * красный кант, вверху по центру — золотистая пуговица.
 *
 * Знаки различия сделаны контрастными: золото на тёмно-синем читается
 * и в размере 88 px, и в шапке чата.
 */

type StarKind = 'small' | 'junior' | 'senior' | 'general';

interface RankConfig {
  stripes?: number;
  stripeWide?: boolean;
  lengthwise?: boolean;
  cadet?: boolean;
  prosvets?: 0 | 1 | 2;
  stars?: number;
  starKind?: StarKind;
}

const CONFIG: Record<Rank, RankConfig> = {
  курсант: { cadet: true },
  рядовой: {},
  ефрейтор: { stripes: 1 },
  'младший сержант': { stripes: 2 },
  сержант: { stripes: 3 },
  'старший сержант': { stripeWide: true },
  старшина: { lengthwise: true },
  прапорщик: { prosvets: 1, stars: 2, starKind: 'small' },
  'старший прапорщик': { prosvets: 1, stars: 3, starKind: 'small' },
  // Младшие офицеры — звёзды 13 мм на одном просвете.
  'младший лейтенант': { prosvets: 1, stars: 1, starKind: 'junior' },
  лейтенант: { prosvets: 1, stars: 2, starKind: 'junior' },
  'старший лейтенант': { prosvets: 1, stars: 3, starKind: 'junior' },
  капитан: { prosvets: 1, stars: 4, starKind: 'junior' },
  // Старшие офицеры — звёзды 20 мм между двумя просветами.
  майор: { prosvets: 2, stars: 1, starKind: 'senior' },
  подполковник: { prosvets: 2, stars: 2, starKind: 'senior' },
  полковник: { prosvets: 2, stars: 3, starKind: 'senior' },
  // Генералы — звёзды 22 мм без просветов.
  'генерал-майор': { prosvets: 0, stars: 1, starKind: 'general' },
  'генерал-лейтенант': { prosvets: 0, stars: 2, starKind: 'general' },
  'генерал-полковник': { prosvets: 0, stars: 3, starKind: 'general' },
};

// Геометрия погона: 1 единица viewBox ≈ 1 мм.
const CANVAS = { w: 160, h: 60 } as const;
const BUTTON = { x: 80, y: 8, r: 2.8 } as const;

// Контрастная палитра: знаки должны читаться в мелком размере.
const FIELD = '#16233d';
const FIELD_EDGE = '#0a1220';
const CANT_RED = '#c0392b';
const GOLD = '#f2c53d';
const GOLD_BRIGHT = '#ffd95e';
const GOLD_EDGE = '#7a5a10';

const STAR_RADIUS: Record<StarKind, number> = {
  small: 6.5, // 13 мм — прапорщики
  junior: 6.5, // 13 мм — младшие офицеры
  senior: 9.6, // 20 мм — старшие офицеры
  general: 10.8, // 22 мм — генералы
};

/** Пятиконечная звезда с тёмной обводкой — читается на тёмном поле. */
function Star({ x, y, r }: { x: number; y: number; r: number }) {
  const pts: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const angle = (i * 36 - 90) * (Math.PI / 180);
    const rad = i % 2 === 0 ? r : r * 0.4;
    pts.push(`${(x + rad * Math.cos(angle)).toFixed(2)},${(y + rad * Math.sin(angle)).toFixed(2)}`);
  }
  return (
    <g>
      <polygon
        points={pts.join(' ')}
        fill={GOLD_BRIGHT}
        stroke={GOLD_EDGE}
        strokeWidth="0.9"
        strokeLinejoin="round"
      />
    </g>
  );
}

/** Раскладка звёзд (canvas 160 × 60) строго по уставным схемам. */
function starLayout(cfg: RankConfig): Array<{ x: number; y: number }> {
  const n = cfg.stars ?? 0;
  if (!n) return [];
  const kind = cfg.starKind ?? 'junior';
  const cy = 30;

  // Генералы: 22 мм, без просветов, в ряд по центру.
  if (kind === 'general') {
    if (n === 1) return [{ x: 80, y: 32 }];
    if (n === 2)
      return [
        { x: 62, y: 32 },
        { x: 98, y: 32 },
      ];
    return [
      { x: 56, y: 32 },
      { x: 80, y: 32 },
      { x: 104, y: 32 },
    ];
  }

  // Прапорщики: 13 мм на одном просвете.
  if (kind === 'small') {
    if (n === 2)
      return [
        { x: 64, y: cy },
        { x: 96, y: cy },
      ];
    return [
      { x: 58, y: cy },
      { x: 80, y: cy },
      { x: 102, y: cy },
    ];
  }

  // Старшие офицеры: 20 мм между двумя просветами (по центру поля).
  if (kind === 'senior') {
    if (n === 1) return [{ x: 80, y: cy }];
    if (n === 2)
      return [
        { x: 64, y: cy },
        { x: 96, y: cy },
      ];
    return [
      { x: 60, y: 44 },
      { x: 100, y: 44 },
      { x: 80, y: 20 },
    ];
  }

  // Младшие офицеры: 13 мм на одном просвете.
  if (n === 1) return [{ x: 80, y: cy }];
  if (n === 2)
    return [
      { x: 58, y: cy },
      { x: 102, y: cy },
    ];
  if (n === 3)
    return [
      { x: 58, y: 40 },
      { x: 102, y: 40 },
      { x: 80, y: 18 },
    ];
  return [
    { x: 58, y: 20 },
    { x: 102, y: 20 },
    { x: 58, y: 40 },
    { x: 102, y: 40 },
  ];
}

/** Поперечная нашивка во всю ширину поля. */
function Stripe({ y, height }: { y: number; height: number }) {
  return (
    <rect
      x={8}
      y={y - height / 2}
      width={144}
      height={height}
      rx={0.8}
      fill={GOLD}
      stroke={GOLD_EDGE}
      strokeWidth="0.8"
    />
  );
}

/** Полное уставное название звания: «младший сержант» → «Младший сержант полиции». */
export function formatRank(rank?: string): string {
  if (!rank) return '';
  const trimmed = rank.trim();
  if (!trimmed) return '';
  const base = trimmed.replace(/\s+полиции\s*$/i, '').trim();
  const capitalized = base.charAt(0).toUpperCase() + base.slice(1);
  return /полиции$/i.test(trimmed) ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : `${capitalized} полиции`;
}

export interface RankBadgeProps {
  rank?: string;
  /** xs — 24 px по высоте (списки), sm — 36, md — 54, lg — 75 */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  /** всплывающая подсказка (по умолчанию — полное название звания) */
  title?: string;
}

/** «подполковник полиции» → ключ конфигурации «подполковник». */
export function normalizeRank(rank?: string): Rank | null {
  if (!rank) return null;
  const base = rank.replace(/\s+полиции\s*$/i, '').trim().toLowerCase();
  if (base in CONFIG) return base as Rank;
  return null;
}

export function RankBadge({ rank, size = 'md', className, title }: RankBadgeProps) {
  const key = normalizeRank(rank);
  const cfg: RankConfig = key ? CONFIG[key] : {};

  const dims =
    size === 'lg'
      ? { w: 200, h: 75 }
      : size === 'md'
        ? { w: 144, h: 54 }
        : size === 'sm'
          ? { w: 96, h: 36 }
          : { w: 64, h: 24 };

  const label = title ?? formatRank(rank) ?? 'Погон';
  const starKind = cfg.starKind ?? 'junior';

  return (
    <svg
      viewBox={`0 0 ${CANVAS.w} ${CANVAS.h}`}
      width={dims.w}
      height={dims.h}
      role="img"
      className={clsx('rank-badge shrink-0 select-none', className)}
      aria-label={label}
    >
      <title>{label || 'Погон'}</title>

      {/* тело погона */}
      <path d="M12 0 H148 Q160 0 160 12 V60 H0 V12 Q0 0 12 0 Z" fill={FIELD} />
      {/* тёмная внутренняя окантовка для объёма */}
      <path
        d="M14 3 H146 Q157 3 157 13 V57 H3 V13 Q3 3 14 3 Z"
        fill="none"
        stroke={FIELD_EDGE}
        strokeWidth="1"
        opacity="0.6"
      />
      {/* красный кант по всему периметру */}
      <path
        d="M12 0.9 H148 Q159.1 0.9 159.1 12 V59.1 H0.9 V12 Q0.9 0.9 12 0.9 Z"
        fill="none"
        stroke={CANT_RED}
        strokeWidth="1.8"
        strokeLinejoin="round"
      />

      {/* пуговица */}
      <circle cx={BUTTON.x} cy={BUTTON.y} r={BUTTON.r} fill={GOLD} stroke={GOLD_EDGE} strokeWidth="0.8" />
      <circle cx={BUTTON.x - 0.8} cy={BUTTON.y - 0.8} r={0.8} fill="rgba(255,255,255,0.7)" />

      {/* КУРСАНТ: продольные полосы + «К» */}
      {cfg.cadet && (
        <g>
          <rect x={10} y={16} width={140} height={4} rx={1} fill={GOLD} stroke={GOLD_EDGE} strokeWidth="0.6" />
          <rect x={10} y={40} width={140} height={4} rx={1} fill={GOLD} stroke={GOLD_EDGE} strokeWidth="0.6" />
          <text
            x={80}
            y={38}
            textAnchor="middle"
            fontSize={26}
            fontWeight="700"
            fontFamily="Georgia, 'Times New Roman', serif"
            fill={GOLD_BRIGHT}
            stroke={GOLD_EDGE}
            strokeWidth="0.5"
          >
            К
          </text>
        </g>
      )}

      {/* СЕРЖАНТСКИЕ НАШИВКИ */}
      {cfg.stripes === 1 && <Stripe y={30} height={10} />}
      {cfg.stripes === 2 && (
        <>
          <Stripe y={21} height={10} />
          <Stripe y={39} height={10} />
        </>
      )}
      {cfg.stripes === 3 && (
        <>
          <Stripe y={15} height={10} />
          <Stripe y={30} height={10} />
          <Stripe y={45} height={10} />
        </>
      )}
      {cfg.stripeWide && <Stripe y={30} height={30} />}

      {/* СТАРШИНА: продольная нашивка */}
      {cfg.lengthwise && (
        <rect
          x={10}
          y={25}
          width={140}
          height={10}
          rx={1}
          fill={GOLD}
          stroke={GOLD_EDGE}
          strokeWidth="0.8"
        />
      )}

      {/* КРАСНЫЕ ПРОСВЕТЫ */}
      {cfg.prosvets === 1 && (
        <rect x={10} y={27} width={140} height={6} rx={1} fill={CANT_RED} />
      )}
      {cfg.prosvets === 2 && (
        <>
          <rect x={10} y={14} width={140} height={6} rx={1} fill={CANT_RED} />
          <rect x={10} y={40} width={140} height={6} rx={1} fill={CANT_RED} />
        </>
      )}

      {/* ЗВЁЗДЫ */}
      {starLayout(cfg).map((p, i) => (
        <Star key={i} x={p.x} y={p.y} r={STAR_RADIUS[cfg.starKind ?? starKind]} />
      ))}
    </svg>
  );
}
