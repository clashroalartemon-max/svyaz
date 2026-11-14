/**
 * Проверка конкурентной отправки: два пользователя пишут в один чат
 * одновременно (разные HTTP-клиенты, настоящий Supabase).
 *
 * Проверяем два свойства:
 *   1. 10 параллельных сообщений от двух авторов сохраняются все и без дублей;
 *   2. повторная вставка одного и того же id (двойной сабмит/ретрай) даёт
 *      ошибку уникальности — вторая копия не появляется.
 *
 * Запуск: node scripts/concurrency-test.js
 */
import { createServer } from 'vite';
import { createClient } from '@supabase/supabase-js';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILE = path.join(ROOT, 'scripts', 'concurrency-test.log');
const RUN = `race${Date.now().toString(36)}`;
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

const store = new Map();
function makeStorage() {
  return {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => void store.set(String(key), String(value)),
    removeItem: (key) => void store.delete(String(key)),
    clear: () => void store.clear(),
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}
globalThis.window = {
  localStorage: makeStorage(),
  sessionStorage: makeStorage(),
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => true,
};
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true },
  configurable: true,
});
if (typeof globalThis.CustomEvent !== 'function') {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

const server = await createServer({
  root: ROOT,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

const result = { run: RUN, inserted: 0, duplicatesRejected: 0, finalCount: 0, uniqueIds: 0, errors: [] };

try {
  const db = await server.ssrLoadModule('/src/lib/db.ts');
  const crypto = await server.ssrLoadModule('/src/lib/crypto.ts');
  const env = readEnv();
  const url = env.VITE_SUPABASE_URL;
  const anon = env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('нет VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY в .env');

  const account = (suffix) => ({
    login: `${RUN}_${suffix}`,
    password: PASSWORD,
    fullName: `Гонка ${suffix}`,
    group: 'Тест-нагрузка',
    role: 'cadet',
  });

  const first = await db.createUser(account('a'));
  const second = await db.createUser(account('b'));
  log(`созданы ${first.login} и ${second.login}`);

  const signedA = await db.verifyLogin(`${RUN}_a`, PASSWORD);
  const signedB = await db.verifyLogin(`${RUN}_b`, PASSWORD);
  if (!signedA || !signedB) throw new Error('вход не удался');
  log('оба пользователя вошли');

  db.setCurrentUserId(signedA.id);
  const chat = await db.createGroupChat(signedA.id, `Гонка ${RUN}`, [signedB.id]);
  log(`чат ${chat.id} создан`);

  const userA = await db.getUserById(signedA.id);
  const userB = await db.getUserById(signedB.id);
  if (!userA?.publicKeyJwk || !userB?.publicKeyJwk) throw new Error('нет публичных ключей');
  const members = [
    { id: userA.id, publicKeyJwk: userA.publicKeyJwk },
    { id: userB.id, publicKeyJwk: userB.publicKeyJwk },
  ];

  async function buildRows(author, count) {
    const rows = [];
    for (let i = 1; i <= count; i += 1) {
      const envelope = await crypto.encryptForGroup({
        myId: author.id,
        myPublicKeyJwk: author.publicKeyJwk,
        members,
        data: `${author.login}: сообщение ${i}`,
      });
      rows.push({
        id: db.uid(),
        chat_id: chat.id,
        sender_id: author.id,
        type: 'text',
        status: 'sent',
        created_at: Date.now(),
        ciphertext: envelope.ciphertext,
        iv: envelope.iv,
        wrapped_key: envelope.wrappedKey ?? null,
        wrapped_key_iv: envelope.wrappedKeyIv ?? null,
        wrapped_self_key: envelope.wrappedSelfKey ?? null,
        wrapped_self_key_iv: envelope.wrappedSelfKeyIv ?? null,
        group_keys: envelope.groupKeys ?? null,
      });
    }
    return rows;
  }

  const rowsA = await buildRows(userA, 5);
  const rowsB = await buildRows(userB, 5);

  const clientA = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-user-id': userA.id } },
  });
  const clientB = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-user-id': userB.id } },
  });

  // Настоящая параллельность: два независимых клиента, 10 запросов сразу.
  const inserts = await Promise.all([
    ...rowsA.map((row) => clientA.from('messages').insert(row)),
    ...rowsB.map((row) => clientB.from('messages').insert(row)),
  ]);
  const failed = inserts.filter((item) => item.error);
  result.inserted = inserts.length - failed.length;
  for (const item of failed) result.errors.push(item.error.message);
  log(`параллельная вставка: ${result.inserted}/10 успешно`);

  db.setCurrentUserId(userA.id);
  const stored = await db.getMessages(chat.id);
  result.finalCount = stored.length;
  result.uniqueIds = new Set(stored.map((message) => message.id)).size;
  log(`в чате ${result.finalCount} сообщений, уникальных id ${result.uniqueIds}`);

  // Двойной сабмит одного и того же id: должна победить ровно одна вставка.
  const duplicate = { ...rowsA[0], id: db.uid() };
  const [firstTry, secondTry] = await Promise.all([
    clientA.from('messages').insert(duplicate),
    clientA.from('messages').insert(duplicate),
  ]);
  const rejected = [firstTry, secondTry].filter((item) => item.error);
  result.duplicatesRejected = rejected.length;
  log(`повторный id: отклонено ${rejected.length} из 2, ошибка: ${rejected[0]?.error?.message ?? '—'}`);

  const afterDuplicate = await db.getMessages(chat.id);
  result.finalCount = afterDuplicate.length;
  result.uniqueIds = new Set(afterDuplicate.map((message) => message.id)).size;
  log(`итог: ${result.finalCount} сообщений, уникальных id ${result.uniqueIds}`);

  if (result.inserted !== 10) result.errors.push(`вставлено ${result.inserted} из 10`);
  if (result.uniqueIds !== result.finalCount) result.errors.push('есть дубли id');
  if (result.duplicatesRejected !== 1) result.errors.push('повторный id не отклонён');
} catch (error) {
  result.errors.push(String(error?.message ?? error));
  log(`ОШИБКА: ${error?.message ?? error}`);
} finally {
  await server.close();
}

log(`ИТОГ: ${JSON.stringify(result)}`);
process.exit(result.errors.length === 0 ? 0 : 1);
