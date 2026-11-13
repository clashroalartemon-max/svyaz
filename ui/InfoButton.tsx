import { Info } from 'lucide-react';
import { useState } from 'react';
import type { User } from '../types';
import { RankBadge } from './RankBadge';

/**
 * Серая иконка «Информация»: по нажатию открывает краткую справку о человеке
 * (ФИО, группа, должность, звание, ник). Используется в шапке чата и профиле.
 */
export function InfoButton({ user, title }: { user: User | null; title?: string }) {
  const [open, setOpen] = useState(false);
  if (!user) return null;

  const rows: Array<{ label: string; value: string }> = [
    { label: 'ФИО', value: user.fullName },
    ...(user.group ? [{ label: 'Группа / взвод', value: user.group }] : []),
    ...(user.position ? [{ label: 'Должность', value: user.position }] : []),
    ...(user.department ? [{ label: 'Подразделение', value: user.department }] : []),
    ...(user.rank ? [{ label: 'Звание', value: user.rank }] : []),
    ...(user.username ? [{ label: 'Ник', value: `@${user.username}` }] : []),
  ];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
        aria-label={title ?? 'Информация'}
        title={title ?? 'Информация'}
      >
        <Info size={18} />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-border bg-bg p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-3">
              {user.rank ? (
                <RankBadge rank={user.rank} title={user.rank} />
              ) : (
                <span className="text-[13px] text-text-muted">Без звания</span>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[16px] font-medium text-text">{user.fullName}</div>
                {user.username && (
                  <div className="truncate text-[13px] text-text-muted">@{user.username}</div>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              {rows.map((r) => (
                <div key={r.label} className="flex justify-between gap-3 text-[14px]">
                  <span className="shrink-0 text-text-muted">{r.label}</span>
                  <span className="min-w-0 truncate text-right text-text">{r.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}