/**
 * Симуляция 100 пользователей «Связи».
 *
 * Каждый пользователь проходит настоящий путь приложения:
 *   1. регистрация (db.createUser — профиль + ключи E2EE + хеш пароля);
 *   2. вход (db.verifyLogin — RPC verify_login + расшифровка приватного ключа);
 *   3. создание группового чата с соседом (db.createGroupChat);
 *   4. отправка 5 зашифрованных сообщений (crypto.encryptForGroup + db.saveMessage);
 *   5. проверка, что все 5 сообщений действительно читаются из базы.
 *
 * Запуск:
 *   node scripts/load-test.js            # 100 пользователей
 *   node scripts/load-test.js 5          # быстрый прогон на 5
 *
 * Почему через Vite SSR: db.ts написан для браузера (import.meta.env,
 * localStorage, WebCrypto). Vite загружает настоящий модуль без копирования
 * логики, а Node-полифиллы ниже дают ему localStorage и navigator.
 */
import { createServer } from 'vite';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = Math.max(1, Number(process.argv[2] ?? 100));
const LOG_FILE = path.join(ROOT, 'scripts', 'load-test.log');
const RUN = `sim${Date.now().toString(36)}`;
const PASSWORD = 'Test12345!';

writeFileSync(LOG_FILE, '');
function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  appendFileSync(LOG_FILE, `${text}\n`);
}

// --- полифиллы браузерного окружения -----------------------------------------
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

const listeners = new Map();
const windowStub = {
  localStorage: makeStorage(),
  sessionStorage: makeStorage(),
  addEventListener(type, handler) {
    const list = listeners.get(type) ?? [];
    list.push(handler);
    listeners.set(type, list);
  },
  removeEventListener(type, handler) {
    const list = listeners.get(type) ?? [];
    listeners.set(
      type,
      list.filter((item) => item !== handler),
    );
  },
  dispatchEvent() {
    return true;
  },
  matchMedia: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
};
globalThis.window = windowStub;
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true, userAgent: 'svyaz-load-test' },
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

// --- запуск ---------------------------------------------------------------
const errors = [];
const summary = {
  run: RUN,
  requested: LIMIT,
  registered: 0,
  loggedIn: 0,
  chats: 0,
  messages: 0,
  errors: 0,
  durationMs: 0,
};
const startedAt = Date.now();

log(`Старт: ${LIMIT} пользователей, префикс логинов ${RUN}_`);

const server = await createServer({
  root: ROOT,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

try {
  const db = await server.ssrLoadModule('/src/lib/db.ts');
  const crypto = await server.ssrLoadModule('/src/lib/crypto.ts');

  const accounts = [];

  // 1. Регистрация
  for (let i = 0; i < LIMIT; i += 1) {
    const n = String(i + 1).padStart(3, '0');
    const account = {
      login: `${RUN}_${n}`,
      password: PASSWORD,
      fullName: `Нагрузочный Пользователь ${n}`,
      group: 'Тест-нагрузка',
      role: 'cadet',
    };
    try {
      const user = await db.createUser(account);
      accounts.push({ account, user });
      summary.registered += 1;
      if ((i + 1) % 10 === 0 || i === 0) {
        log(`регистрация: ${i + 1}/${LIMIT}`);
      }
    } catch (error) {
      summary.errors += 1;
      errors.push({ stage: 'register', login: account.login, error: String(error?.message ?? error) });
      log(`ОШИБКА регистрации ${account.login}: ${error?.message ?? error}`);
    }
  }

  if (accounts.length < 2) {
    throw new Error(`зарегистрировано ${accounts.length} пользователей — недостаточно для чатов`);
  }

  // 2-5. Вход, чат, пять сообщений — строго последовательно, потому что
  // заголовок x-user-id у общего клиента переключается на текущего пользователя.
  for (let i = 0; i < accounts.length; i += 1) {
    const { account, user } = accounts[i];
    const n = String(i + 1).padStart(3, '0');
    try {
      log(`[${n}] verifyLogin…`);
      const signedIn = await db.verifyLogin(account.login, account.password);
      if (!signedIn) throw new Error('verify_login вернул пустой профиль');
      db.setCurrentUserId(signedIn.id);
      summary.loggedIn += 1;
      log(`[${n}] login ok`);

      const peer = accounts[(i + 1) % accounts.length];
      log(`[${n}] createGroupChat…`);
      const chat = await db.createGroupChat(signedIn.id, `Нагрузка ${n}`, [peer.user.id]);
      summary.chats += 1;
      log(`[${n}] chat ok`);

      const me = await db.getUserById(signedIn.id);
      const other = await db.getUserById(peer.user.id);
      if (!me?.publicKeyJwk || !other?.publicKeyJwk) {
        throw new Error('у участников нет публичных ключей');
      }
      log(`[${n}] keys ok`);

      const members = [
        { id: me.id, publicKeyJwk: me.publicKeyJwk },
        { id: other.id, publicKeyJwk: other.publicKeyJwk },
      ];

      for (let j = 1; j <= 5; j += 1) {
        const envelope = await crypto.encryptForGroup({
          myId: signedIn.id,
          myPublicKeyJwk: me.publicKeyJwk,
          members,
          data: `Нагрузка ${n}, сообщение ${j}`,
        });
        log(`[${n}] encrypt ${j} ok, inserting…`);
        await db.saveMessage({
          id: db.uid(),
          chatId: chat.id,
          senderId: signedIn.id,
          type: 'text',
          status: 'sent',
          createdAt: Date.now(),
          ...envelope,
        });
        summary.messages += 1;
        log(`[${n}] message ${j} saved`);
      }

      log(`[${n}] reading messages…`);
      const stored = await db.getMessages(chat.id);
      if (stored.length < 5) {
        throw new Error(`в чате прочитано ${stored.length} из 5 сообщений`);
      }

      if ((i + 1) % 10 === 0) log(`пользователь ${i + 1}/${accounts.length}: чат + 5 сообщений`);
    } catch (error) {
      summary.errors += 1;
      errors.push({ stage: 'flow', login: account.login, error: String(error?.message ?? error) });
      log(`ОШИБКА ${account.login}: ${error?.message ?? error}`);
    }
  }
} catch (error) {
  summary.errors += 1;
  errors.push({ stage: 'fatal', error: String(error?.message ?? error) });
  log(`ФАТАЛЬНАЯ ОШИБКА: ${error?.message ?? error}`);
} finally {
  await server.close();
}

summary.durationMs = Date.now() - startedAt;
summary.prefix = `${RUN}_`;

log(`ИТОГ: ${JSON.stringify(summary)}`);
if (errors.length > 0) {
  log(`Ошибки (${errors.length}):`);
  for (const item of errors.slice(0, 20)) log(`  ${JSON.stringify(item)}`);
}
log(`Учётные записи: логины ${RUN}_001…${RUN}_${String(LIMIT).padStart(3, '0')}, пароль ${PASSWORD}`);

process.exitCode = errors.length === 0 && summary.messages === LIMIT * 5 ? 0 : 1;
// Vite/undici держат сокеты после закрытия сервера — выходим явно, иначе
// процесс висит, хотя вся работа уже сделана.
process.exit(process.exitCode);
