import { clsx } from 'clsx';
import { useId } from 'react';
import type { InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, className, id, ...rest }: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-[13px] text-text-muted">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={clsx(
          'rounded-lg border bg-bg px-3 py-2 text-[15px] text-text placeholder:text-text-muted',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
          error ? 'border-danger' : 'border-border',
          className,
        )}
        {...rest}
      />
      {error && <p className="text-[13px] text-danger">{error}</p>}
    </div>
  );
}
