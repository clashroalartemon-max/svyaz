import { clsx } from 'clsx';

export interface BadgeProps {
  count: number;
  className?: string;
}

/** Бейдж непрочитанных сообщений */
export function Badge({ count, className }: BadgeProps) {
  if (count <= 0) return null;
  const label = count > 99 ? '99+' : String(count);
  return (
    <span
      className={clsx(
        'inline-flex min-w-[20px] items-center justify-center rounded-full bg-accent px-1.5 py-0.5',
        'text-[13px] font-medium leading-none text-white',
        className,
      )}
    >
      {label}
    </span>
  );
}
