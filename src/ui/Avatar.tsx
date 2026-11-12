import { clsx } from 'clsx';

type Size = 'sm' | 'md' | 'lg';

const SIZES: Record<Size, string> = {
  sm: 'h-8 w-8 text-[13px]',
  md: 'h-11 w-11 text-[15px]',
  lg: 'h-16 w-16 text-[17px]',
};

/** Сдержанная палитра для различения людей в списках */
const PALETTE = ['#3B5BDB', '#5F6B7A', '#7C6FA0', '#4E8098', '#8A6E5C', '#5A7D5A'];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function initials(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}

export interface AvatarProps {
  name: string;
  size?: Size;
  /** id пользователя — для стабильного цвета */
  seed?: string;
  /** URL загруженной аватарки (если есть) */
  src?: string;
  className?: string;
}

export function Avatar({ name, size = 'md', seed, src, className }: AvatarProps) {
  const color = PALETTE[hashString(seed ?? name) % PALETTE.length];
  if (src) {
    return (
      <img
        src={src}
        alt={initials(name)}
        className={clsx('shrink-0 select-none rounded-full object-cover', SIZES[size], className)}
        loading="lazy"
      />
    );
  }
  return (
    <div
      className={clsx(
        'flex shrink-0 select-none items-center justify-center rounded-full font-medium text-white',
        SIZES[size],
        className,
      )}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}
