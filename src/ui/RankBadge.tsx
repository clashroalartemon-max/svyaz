import { clsx } from 'clsx';
import type { Rank } from '../types';

/**
 * Погон сотрудника органов внутренних дел РФ (повседневная форма, приказ
 * МВД России № 575): вертикальный, тёмно-синее поле, красный кант, золотая
 * пуговица вверху. Знаки различия — поперечные/продольные нашивки, просветы
 * и звёзды, как на эталонной таблице.
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
  прапорщик: { stars: 2, starKind: 'small' },
  'старший прапорщик': { stars: 3, starKind: 'small' },
  'младший лейтенант': { prosvets: 1, stars: 1, starKind: 'junior' },
  лейтенант: { prosvets: 1, stars: 2, starKind: 'junior' },
  'старший лейтенант': { prosvets: 1, stars: 3, starKind: 'junior' },
  капитан: { prosvets: 1, stars: 4, starKind: 'junior' },
  майор: { prosvets: 2, stars: 1, starKind: 'senior' },
  подполковник: { prosvets: 2, stars: 2, starKind: 'senior' },
  полковник: { prosvets: 2, stars: 3, starKind: 'senior' },
  'генерал-майор': { prosvets: 0, stars: 1, starKind: 'general' },
  'генерал-лейтенант': { prosvets: 0, stars: 2, starKind: 'general' },
  'генерал-полковник': { prosvets: 0, stars: 3, starKind: 'general' },
};

// Вертикальный погон: 1 единица viewBox ≈ 1 мм.
const CANVAS = { w: 60, h: 160 } as const;

const FIELD = '#16233d';
const FIELD_EDGE = '#0a1220';
const CANT_RED = '#c0392b';
const GOLD = '#f2c53d';
const GOLD_BRIGHT = '#ffd95e';
const GOLD_EDGE = '#7a5a10';

const STAR_RADIUS: Record<StarKind, number> = {
  small: 6.4,
  junior: 6.6,
  senior: 8.2,
  general: 9.6,
};

/** Пятиконечная звезда с обводкой — читается на тёмном поле. */
function Star({ x, y, r }: { x: number; y: number; r: number }) {
  const pts: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const angle = (i * 36 - 90) * (Math.PI / 180);
    const rad = i % 2 === 0 ? r : r * 0.4;
    pts.push(`${(x + rad * Math.cos(angle)).toFixed(2)},${(y + rad * Math.sin(angle)).toFixed(2)}`);
  }
  return (
    <polygon
      points={pts.join(' ')}
      fill={GOLD_BRIGHT}
      stroke={GOLD_EDGE}
      strokeWidth="0.9"
      strokeLinejoin="round"
    />
  );
}

/** Вертикальные позиции звёзд по центру погона. */
function starLayout(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [96];
  if (count === 2) return [76, 116];
  if (count === 3) return [62, 92, 122];
  return [54, 82, 110, 138];
}

/** Полное уставное название звания. */
export function formatRank(rank?: string): string {
  if (!rank) return '';
  const trimmed = rank.trim();
  if (!trimmed) return '';
  const base = trimmed.replace(/\s+полиции\s*$/i, '').trim();
  const capitalized = base.charAt(0).toUpperCase() + base.slice(1);
  return /полиции$/i.test(trimmed)
    ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
    : `${capitalized} полиции`;
}

export interface RankBadgeProps {
  rank?: string;
  /** xs — списки, sm — карточки, md/lg — крупный просмотр */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
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
      ? { w: 56, h: 149 }
      : size === 'md'
        ? { w: 34, h: 91 }
        : size === 'sm'
          ? { w: 22, h: 59 }
          : { w: 16, h: 43 };

  const label = title ?? formatRank(rank) ?? 'Погон';
  const stripeCount = cfg.stripes ?? 0;

  const stars = cfg.stars
    ? starLayout(cfg.stars).map((y) => (
        <Star key={y} x={30} y={y} r={STAR_RADIUS[cfg.starKind ?? 'junior']} />
      ))
    : null;

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

      {/* поле и красный кант */}
      <rect x="2" y="2" width="56" height="156" rx="12" fill={FIELD} stroke={CANT_RED} strokeWidth="3.2" />
      <rect x="5" y="5" width="50" height="150" rx="9" fill="none" stroke={FIELD_EDGE} strokeWidth="0.8" />

      {/* пуговица */}
      <circle cx="30" cy="15" r="4.4" fill={GOLD} stroke={GOLD_EDGE} strokeWidth="0.8" />

      {/* продольные просветы офицеров */}
      {cfg.prosvets === 1 && (
        <rect x="26.5" y="38" width="7" height="112" rx="2" fill={GOLD} stroke={GOLD_EDGE} strokeWidth="0.6" />
      )}
      {cfg.prosvets === 2 && (
        <>
          <rect x="17" y="38" width="6" height="112" rx="2" fill={GOLD} stroke={GOLD_EDGE} strokeWidth="0.6" />
          <rect x="37" y="38" width="6" height="112" rx="2" fill={GOLD} stroke={GOLD_EDGE} strokeWidth="0.6" />
        </>
      )}

      {/* поперечные нашивки */}
      {stripeCount > 0 &&
        Array.from({ length: stripeCount }).map((_, index) => (
          <rect
            key={index}
            x="7"
            y={104 + index * 14}
            width="46"
            height="8"
            rx="1.2"
            fill={GOLD}
            stroke={GOLD_EDGE}
            strokeWidth="0.7"
          />
        ))}
      {cfg.stripeWide && (
        <rect x="7" y="104" width="46" height="16" rx="1.6" fill={GOLD} stroke={GOLD_EDGE} strokeWidth="0.7" />
      )}

      {/* продольная нашивка старшины */}
      {cfg.lengthwise && (
        <rect x="26" y="42" width="8" height="106" rx="2.4" fill={GOLD} stroke={GOLD_EDGE} strokeWidth="0.7" />
      )}

      {/* звёзды: генералы и старшие — крупнее, младшие — меньше */}
      {stars}
    </svg>
  );
}
