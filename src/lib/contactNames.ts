/** Свои имена контактов хранятся на устройстве, как в телефонной книге. */

const KEY = 'svyaz.contactNames';

function readAll(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object') return {};
    return value as Record<string, string>;
  } catch {
    return {};
  }
}

export function getContactName(userId: string): string | null {
  if (!userId) return null;
  const value = readAll()[userId];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function setContactName(userId: string, name: string | null): void {
  if (!userId) return;
  const all = readAll();
  const next = name?.trim() ?? '';
  if (next) all[userId] = next.slice(0, 60);
  else delete all[userId];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* приватный режим */
  }
  try {
    window.dispatchEvent(new CustomEvent('contact-name:changed', { detail: { userId } }));
  } catch {
    /* среда без window */
  }
}
