/** Общие форматтеры, чтобы одинаковые строки не дублировались по экранам. */

/** 0:07, 1:23, 12:05 */
export function formatDuration(sec?: number): string {
  const value = sec && Number.isFinite(sec) && sec > 0 ? sec : 0;
  const m = Math.floor(value / 60);
  const s = Math.floor(value % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** «1 участник», «3 участника», «11 участников». */
export function pluralParticipants(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'участник';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'участника';
  return 'участников';
}
