/**
 * Клиент Supabase.
 *
 * Один общий бэкенд на все устройства: пользователи, чаты и сообщения живут
 * в Postgres, а не в localStorage браузера.
 *
 * Клиент пересоздаётся при смене пользователя: id текущего пользователя уходит
 * в заголовке x-user-id, по нему RLS-политики решают, что кому видно
 * (см. supabase/schema.sql).
 */

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as storage from './storage';
import { buildAuthHeaders } from './session';

const URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

export const isSupabaseConfigured = URL.startsWith('http') && ANON_KEY.length > 20;

export const SUPABASE_SETUP_HINT =
  'Supabase не настроен. Создайте .env с VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY ' +
  '(Project Settings → API) и перезапустите npm run dev.';

function build(userId: string): SupabaseClient {
  return createClient(URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: buildAuthHeaders(userId, storage.getSessionToken()) },
  });
}

let client: SupabaseClient | null = null;
let clientUserId = '';

function currentClient(): SupabaseClient {
  if (!isSupabaseConfigured) throw new Error(SUPABASE_SETUP_HINT);
  if (!client) client = build('');
  return client;
}

/** Клиент для запросов. Бросает понятную ошибку, если .env не заполнен. */
export function supabase(): SupabaseClient {
  return currentClient();
}

/** Пересоздать клиент под другого пользователя (вызывается при входе/выходе). */
export function setSupabaseUser(userId: string | null): void {
  const id = userId ?? '';
  if (id === clientUserId && client) return;
  clientUserId = id;
  client = isSupabaseConfigured ? build(id) : null;
}

/** Сохранить токен и пересоздать клиент с новым заголовком. */
export function setSessionToken(token: string | null): void {
  storage.setSessionToken(token);
  const id = clientUserId;
  clientUserId = '';
  client = null;
  setSupabaseUser(id || null);
}
