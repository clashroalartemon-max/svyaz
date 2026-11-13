import { clsx } from 'clsx';
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[15px] font-medium ' +
  'transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ' +
  'disabled:opacity-50 disabled:cursor-not-allowed select-none';

const styles: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:opacity-85',
  secondary: 'bg-surface border border-border text-text hover:border-text-muted',
  ghost: 'text-text hover:bg-surface',
  danger: 'text-danger border border-danger/40 hover:bg-danger/10',
};

export function Button({ variant = 'primary', className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={clsx(base, styles[variant], className)}
      {...rest}
    />
  );
}
