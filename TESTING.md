# Тестирование «Связи»

## 1. Автоматические тесты

```bash
npm test          # 59 тестов в 16 файлах (Vitest, окружение node)
npm run build     # TypeScript strict + production-сборка
```

| Файл | Что проверяет |
|------|----------------|
| `src/lib/crypto.test.ts` (5) | E2EE: личное и групповое шифрование, подмена шифротекста, бинарные данные |
| `src/lib/db.test.ts` (8) | создание чата и отправка через замоканный Supabase, `queued → sent`, офлайн-очередь |
| `src/lib/validation.test.ts` (8) | логин, пароль, пустое сообщение, файл 100 МБ |
| `src/lib/ranks.test.ts` (9) | курсы, авто-звания, должности |
| `src/lib/logging.test.ts` (3) | маскирование ключей и паролей в логах |
| `src/lib/session.test.ts` (3) | с токеном уходит только `x-session-token`, без токена — legacy-заголовок |
| `src/lib/notifications.test.ts` (2) | правило показа уведомления (разрешение, скрытая вкладка) |
| `src/lib/pins.test.ts` (2) | закрепление и снятие закрепления |
| `src/lib/stickers.test.ts` (2) | упаковка и распознавание стикера |
| `src/lib/documents.test.ts` (5) | имя/размер/mime документа, PDF и текст для превью |
| `src/lib/polls.test.ts` (2) | кодирование и разбор опроса |
| `src/lib/incognito.test.ts` (1) | включение/выключение режима инкогнито |
| `src/lib/formatting.test.ts` (4) | разметка: жирный, курсив, подчёркивание, спойлер, код |
| `src/lib/reactions.test.ts` (1) | локальные реакции: поставить/снять |
| `src/lib/location.test.ts` (2) | геолокация: кодирование, координаты, ссылка на карту |
| `src/lib/todo.test.ts` (2) | список задач: кодирование и разбор |

Фактический прогон (2026-11-14): `Test Files 16 passed`, `Tests 59 passed`,
`Duration 8.56s`. Лог: `scripts/test-output.txt`.

## 2. Симуляции и проверки

### 2.1. 100 пользователей

```bash
node scripts/load-test.js        # 100 пользователей
node scripts/load-test.js 5      # быстрый прогон
```

Регистрация, вход, групповой чат и 5 зашифрованных сообщений на каждого.
Последний полный прогон: `registered:100, loggedIn:100, chats:100,
messages:500, errors:0` (123 с). Логи: `scripts/load-test.log`,
`scripts/load-test-output.txt`.

### 2.2. Конкурентная отправка

```bash
node scripts/concurrency-test.js
```

10 параллельных вставок от двух клиентов: 10/10, уникальных id 10; повторный
id отклонён (`messages_pkey`), дубля нет. Лог: `scripts/concurrency-test.log`.

### 2.3. RLS + сессионные токены (PGlite)

```bash
node scripts/rls-pglite-test.mjs
```

Настоящий PostgreSQL в WASM с теми же таблицами, функцией `current_user_id()`
и политиками:

```
alice (токен, чужой чат): сообщений 0
подделка x-user-id без токена: сообщений 0
bob (токен, свой чат): сообщений 1
РЕЗУЛЬТАТ: RLS + токены работают
```

Лог: `scripts/rls-pglite-test.log`.

### 2.4. Проверка живой базы

```bash
node scripts/security-rls-test.js
```

Схема уже применена: скрипт печатает `mode: token`, `secure: true`,
`spoofChats: 0` — подделка `x-user-id` без токена не даёт доступа.

### 2.5. HTTP-нагрузка

```bash
npm run loadtest
```

100 запросов к PostgREST пулом по 10: `100/100 OK, p50 87 мс, p95 337 мс,
rps 76` (при 100 одновременных соединениях среда рвёт TLS).

## 3. SQL-проверки (Supabase → SQL Editor)

1. `supabase/schema.sql` — таблица `auth_tokens`, RPC, RLS, гранты (идемпотентно).
2. `supabase/security_tests.sql` — все строки `passed = true`; тест сам
   создаёт одноразовый токен для `cadet143`.
3. `supabase/delete_user_check.sql` — каскады: `messages_left = 0`,
   `participants_left = 0`, `chat_still_exists = 1`, `chat_owner_is_null = 1`.
4. `supabase/load_test.sql` — `simulate_load(100, 20)` / `cleanup_load_test()`.

## 4. Ручные сценарии

- голосовые и кружки (нет доступа к микрофону/камере в среде);
- уведомление браузера: свернуть вкладку → написать с другого аккаунта;
- нижняя навигация на 375 px: Чаты / Контакты / Оповещения / Настройки;
- закрепление: долгое нажатие → «Закрепить», баннер вверху, «Открепить»;
- стикеры: кнопка-смайлик → эмодзи отправляется крупным;
- быстрые ответы: долгое нажатие → «Ок» / «Принято» / «Скоро буду»;
- 375 / 768 / 1920 px, тёмная тема, Ctrl+K, Esc.
