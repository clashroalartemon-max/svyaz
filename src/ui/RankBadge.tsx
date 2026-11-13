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

type StarKind = 'small' | 'officer' | 'general';

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
  'младший лейтенант': { prosvets: 1, stars: 1, starKind: 'officer' },
  лейтенант: { prosvets: 1, stars: 2, starKind: 'officer' },
  'старший лейтенант': { prosvets: 1, stars: 3, starKind: 'officer' },
  капитан: { prosvets: 1, stars: 4, starKind: 'officer' },
  майор: { prosvets: 2, stars: 1, starKind: 'officer' },
  подполковник: { prosvets: 2, stars: 2, starKind: 'officer' },
  полковник: { prosvets: 2, stars: 3, starKind: 'officer' },
  'генерал-майор': { prosvets: 0, stars: 1, starKind: 'general' },
  'генерал-лейтенант': { prosvets: 0, stars: 2, starKind: 'general' },
  'генерал-полковник': { prosvets: 0, stars: 3, starKind: 'general' },
};

// Контрастная палитра: знаки должны читаться в мелком размере.
const FIELD = '#16233d';
const FIELD_EDGE = '#0a1220';
const CANT_RED = '#c0392b';
const GOLD = '#f2c53d';
const GOLD_BRIGHT = '#ffd95e';
const GOLD_EDGE = '#7a5a10';

const STAR_RADIUS: Record<StarKind, number> = {
  small: 5.2, // 13 мм
  officer: 7.2, // 20 мм
  general: 8.6, // 22 мм
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

/** Раскладка звёзд (canvas 160 × 60). */
function starLayout(cfg: RankConfig): Array<{ x: number; y: number }> {
  const n = cfg.stars ?? 0;
  if (!n) return [];
  const kind = cfg.starKind ?? 'officer';
  const cy = 30;

  if (kind === 'general') {
    if (n === 1) return [{ x: 100, y: cy }];
    if (n === 2)
      return [
        { x: 117, y: cy },
        { x: 83, y: cy },
      ];
    return [
      { x: 130, y: cy },
      { x: 100, y: cy },
      { x: 70, y: cy },
    ];
  }

  if (kind === 'small') {
    if (n === 2)
      return [
        { x: 130, y: cy },
        { x: 100, y: cy },
      ];
    return [
      { x: 132, y: cy },
      { x: 106, y: cy },
      { x: 80, y: cy },
    ];
  }

  if (cfg.prosvets === 2) {
    if (n === 1) return [{ x: 100, y: cy }];
    if (n === 2)
      return [
        { x: 112, y: 17 },
        { x: 112, y: 43 },
      ];
    return [
      { x: 132, y: 17 },
      { x: 132, y: 43 },
      { x: 96, y: cy },
    ];
  }

  if (n === 1) return [{ x: 100, y: cy }];
  if (n === 2)
    return [
      { x: 100, y: 17 },
      { x: 100, y: 43 },
    ];
  if (n === 3)
    return [
      { x: 114, y: 17 },
      { x: 114, y: 43 },
      { x: 78, y: cy },
    ];
  return [
    { x: 120, y: 17 },
    { x: 120, y: 43 },
    { x: 82, y: cy },
    { x: 50, y: cy },
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
  size?: 'sm' | 'md' | 'lg';
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
    size === 'lg' ? { w: 200, h: 75 } : size === 'sm' ? { w: 96, h: 36 } : { w: 144, h: 54 };

  const label = title ?? formatRank(rank) ?? 'Погон';
  const starKind = cfg.starKind ?? 'officer';

  return (
    <svg
      viewBox="0 0 160 60"
      width={dims.w}
      height={dims.h}
      role="img"
      className={clsx('shrink-0 select-none', className)}
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
      <circle cx={80} cy={10} r={3.2} fill={GOLD} stroke={GOLD_EDGE} strokeWidth="0.8" />
      <circle cx={79.1} cy={9.1} r={0.9} fill="rgba(255,255,255,0.7)" />

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
