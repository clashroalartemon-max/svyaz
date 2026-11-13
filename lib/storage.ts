/**
 * Локальное состояние устройства.
 *
 * Данные (пользователи, чаты, сообщения) живут в Supabase — здесь остаётся
 * только то, что по определению принадлежит конкретному браузеру:
 *  • сессия (кто вошёл) — localStorage, чтобы вход сохранялся между
 *    перезапусками браузера (в том числе на телефоне);
 *  • приватные ключи E2EE (их нельзя отдавать на сервер);
 *  • тема оформления;
 *  • счётчик ревизии для перечитывания данных.
 */

export const KEYS = {
  theme: 'svyaz.theme',
  rev: 'svyaz.rev',
  /** версия формата ключей: по ней запускается однократное восстановление */
  keysRev: 'svyaz.keysRev',
} as const;

export const CURRENT_USER_KEY = 'svyaz.currentUserId';

function readString(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeString(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch (e) {
    console.warn('localStorage write failed', key, e);
    throw e;
  }
}

function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function readJson<T>(key: string): T | null {
  const raw = readString(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  writeString(key, JSON.stringify(value));
}

export function remove(key: string): void {
  removeKey(key);
}

// --- сессия -------------------------------------------------------------------

export function getCurrentUserId(): string | null {
  try {
    const stored = window.localStorage.getItem(CURRENT_USER_KEY);
    if (stored) return stored;

    // Миграция с версии, где сессия жила в sessionStorage: вход не теряем.
    const legacy = window.sessionStorage.getItem(CURRENT_USER_KEY);
    if (legacy) {
      window.localStorage.setItem(CURRENT_USER_KEY, legacy);
      window.sessionStorage.removeItem(CURRENT_USER_KEY);
      return legacy;
    }
    return null;
  } catch {
    return null;
  }
}

export function setCurrentUserId(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(CURRENT_USER_KEY);
    else window.localStorage.setItem(CURRENT_USER_KEY, id);
  } catch {
    /* ignore */
  }
}

// --- версия данных --------------------------------------------------------------
// Растёт при каждом локальном изменении и при событии Supabase Realtime:
// компоненты, подписанные на неё, перечитывают данные.

export function getRev(): number {
  const raw = readString(KEYS.rev);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function bumpRev(): number {
  const next = getRev() + 1;
  writeString(KEYS.rev, String(next));
  return next;
}
