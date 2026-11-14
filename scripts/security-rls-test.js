/**
 * Проверка идентификации клиента (аудит + приёмка исправления).
 *
 * Пока в базе нет RPC issue_session_token, приложение работает по старому
 * заголовку x-user-id, и скрипт показывает подделку. После применения
 * schema.sql (таблица auth_tokens) RLS принимает только подписанный токен:
 * запрос с одним x-user-id должен вернуть 0 чатов.
 *
 * Запуск: node scripts/security-rls-test.js
 * Используются только тестовые аккаунты sim* этого проекта.
 */
import { createClient } from '@supabase/supabase-js';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILE = path.join(ROOT, 'scripts', 'security-rls-test.log');
const PASSWORD = 'Test12345!';
writeFileSync(LOG_FILE, '');
function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  appendFileSync(LOG_FILE, `${text}\n`);
}

function readEnv() {
  const raw = readFileSync(path.join(ROOT, '.env'), 'utf8');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return env;
}

function client(headers) {
  return createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers },
  });
}

async function countChats(supabase, userId) {
  const { data, error } = await supabase
    .from('chat_participants')
    .select('chat_id')
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

async function countMessages(supabase, chatIds) {
  if (chatIds.length === 0) return 0;
  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .in('chat_id', chatIds);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

const env = readEnv();
if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
  log('Нет VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY в .env');
  process.exit(1);
}

const anon = client({});
const result = {
  mode: 'legacy',
  victim: null,
  tokenChats: null,
  spoofChats: null,
  spoofMessages: null,
  secure: false,
};

try {
  // 1. Тестовый пользователь.
  const { data: profiles, error } = await anon
    .from('profiles')
    .select('id,login')
    .like('login', 'sim%')
    .limit(1);
  if (error) throw new Error(error.message);
  if (!profiles?.length) throw new Error('нет профилей sim* — сначала запустите load-test.js');
  const victim = profiles[0];
  result.victim = victim.login;

  // 2. Есть ли серверные токены?
  const probe = await anon.rpc('issue_session_token', {
    p_login: '__probe__',
    p_hash: '__probe__',
  });
  const missing =
    probe.error && /could not find|404|PGRST202|function .* does not exist/i.test(probe.error.message);
  result.mode = missing ? 'legacy' : 'token';

  if (result.mode === 'token') {
    // 3a. Легальный вход: пароль → токен → свои чаты.
    const { data: token, error: tokenError } = await anon.rpc('issue_session_token', {
      p_login: victim.login,
      p_hash: await sha256Hex(`${victim.login}:${PASSWORD}`),
    });
    if (tokenError) throw new Error(tokenError.message);
    const authorized = client({ 'x-session-token': token });
    const chatRows = await authorized
      .from('chat_participants')
      .select('chat_id')
      .eq('user_id', victim.id);
    if (chatRows.error) throw new Error(chatRows.error.message);
    const chatIds = (chatRows.data ?? []).map((row) => row.chat_id);
    result.tokenChats = chatIds.length;

    // 3b. Подделка: только x-user-id, без токена — должно быть пусто.
    const spoofed = client({ 'x-user-id': victim.id });
    const spoofRows = await spoofed
      .from('chat_participants')
      .select('chat_id')
      .eq('user_id', victim.id);
    if (spoofRows.error) throw new Error(spoofRows.error.message);
    const spoofIds = (spoofRows.data ?? []).map((row) => row.chat_id);
    result.spoofChats = spoofIds.length;
    result.spoofMessages = await countMessages(spoofed, spoofIds);
    result.secure = result.tokenChats > 0 && result.spoofChats === 0;

    log(`жертва: ${victim.login}`);
    log(`с токеном: чатов ${result.tokenChats}`);
    log(`подделка x-user-id без токена: чатов ${result.spoofChats}, сообщений ${result.spoofMessages}`);
    log(result.secure ? 'РЕЗУЛЬТАТ: подделка заблокирована' : 'РЕЗУЛЬТАТ: подделка всё ещё проходит!');
  } else {
    // Старая база: демонстрируем уязвимость.
    const spoofed = client({ 'x-user-id': victim.id });
    const chats = await countChats(spoofed, victim.id);
    const { data: rows, error: rowsError } = await spoofed
      .from('chat_participants')
      .select('chat_id')
      .eq('user_id', victim.id);
    if (rowsError) throw new Error(rowsError.message);
    const ids = (rows ?? []).map((row) => row.chat_id);
    result.spoofChats = chats;
    result.spoofMessages = await countMessages(spoofed, ids);
    result.secure = false;
    log(`режим: legacy (schema.sql с auth_tokens не применён)`);
    log(`жертва: ${victim.login}; без пароля прочитано чатов ${chats}, сообщений ${result.spoofMessages}`);
    log('РЕЗУЛЬТАТ: уязвимость сохраняется до применения schema.sql');
  }
} catch (error) {
  result.error = String(error?.message ?? error);
  log(`ОШИБКА: ${result.error}`);
} finally {
  log(`ИТОГ: ${JSON.stringify(result)}`);
  // 0 — проверка выполнена (даже если показала legacy); 1 — ошибка запуска.
  process.exit(result.error ? 1 : 0);
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
