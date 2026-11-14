# Отчёт по безопасности «Связи»

Дата аудита: 2026-11-14. Проверялись клиент, SQL-схема, RLS, идентификация
пользователя и обработка ключей.

## 1. Методика и доказательства

### 1.1. SQL-инъекции

Клиент не собирает SQL строками:

- выборки идут через PostgREST: `.from('messages').select(...).eq('chat_id', id)` — значения передаются параметрами, а не подставляются в текст;
- записи — `.insert(row)`, `.update(patch).eq('id', id)`;
- RPC — с именованными аргументами: `rpc('verify_login', { p_login, p_hash })`.

Проверка выполнена поиском по проекту:

```powershell
Select-String -Path "src\**\*.ts","src\**\*.tsx" -Pattern "\.from\(|\.rpc\("
Select-String -LiteralPath "supabase\schema.sql" -Pattern "execute format|format\("
```

Динамический SQL в схеме один — в миграции внешнего ключа `chats.owner_id`
(`schema.sql:1732`): `execute format('alter table ... %I', c.conname)`. Имя
ограничения берётся из системного каталога `pg_constraint`, пользовательских
строк там нет.

### 1.2. RLS: чужой чат и чужое сообщение

Написана самопроверка `public.security_selftest()` (`schema.sql:1400+`) и
скрипт `supabase/security_tests.sql`. Проверки:

- `foreign_messages_hidden` — сообщения чужого чата не видны;
- `foreign_media_hidden` — медиа чужого чата не видно;
- `credentials_hidden` — хеши паролей недоступны;
- `private_key_column_hidden` — колонка `encrypted_private_key` закрыта;
- `cannot_join_foreign_chat` — нельзя добавить себя в чужой чат;
- `cannot_spoof_message` — нельзя вставить сообщение от чужого имени.

Запуск (требуется применённая схема):

```sql
-- Supabase → SQL Editor → security_tests.sql
select set_config('request.headers',
  json_build_object('x-user-id', (select id::text from public.profiles where login = 'cadet143'))::text,
  false);
set role anon;
select * from public.security_selftest();
reset role;
```

Все строки должны вернуть `passed = true`. **В этой среде скрипт не выполнен:**
нет доступа к SQL Editor, а живая база ещё не обновлена до `schema.sql`.

### 1.3. Идентификация клиента — исправлено

Раньше `public.current_user_id()` читал заголовок `x-user-id`, который
присылает сам клиент. Любой с anon-ключом мог выдать себя за другого.

**Что сделано:**

1. В `schema.sql` добавлена таблица `public.auth_tokens` (хранится только
   SHA-256 токена) и RPC `issue_session_token(login, hash)`, которая выдаёт
   токен на 30 дней после проверки пароля.
2. `current_user_id()` теперь читает только `x-session-token` и проверяет
   хеш и срок действия. Заголовок `x-user-id` сервер больше не принимает.
3. Клиент (`session.ts`, `supabase.ts`) отправляет `x-session-token`; после
   входа токен сохраняется в localStorage, при выходе отзывается через
   `revoke_session_token`. Пока обновлённая схема не применена, клиент
   работает по старому заголовку — это режим совместимости, а не дыра в
   серверной проверке.
4. Старые сессии без токена после обновления схемы разлогиниваются
   (`ensureSessionToken()`), человек входит заново.

**Доказательство механизма — `scripts/rls-pglite-test.mjs`** (настоящий
PostgreSQL в WASM: те же таблицы, функция и RLS-политики):

```
alice (токен, чужой чат): сообщений 0
подделка x-user-id без токена: сообщений 0
bob (токен, свой чат): сообщений 1
РЕЗУЛЬТАТ: RLS + токены работают
```

Лог: `scripts/rls-pglite-test.log`, вывод: `scripts/rls-pglite-output.txt`.

**Проверено на живой базе (2026-11-14).** После применения схемы
`scripts/security-rls-test.js` вернул:

```
mode: token; с токеном: чатов 2;
подделка x-user-id без токена: чатов 0, сообщений 0;
РЕЗУЛЬТАТ: подделка заблокирована; secure: true
```

Лог: `scripts/security-rls-output.txt`.

### 1.4. Приватные ключи в логах

Добавлен `src/lib/logging.ts`:

- `maskSecrets()` рекурсивно заменяет поля `privateKeyJwk`, `password`,
  `token`, `ciphertext`, `wrapped*` на `[скрыто]`;
- `safeError()` превращает ошибку в строку без секретов.

`db.ts` использует `safeError()` в сообщениях о приватном ключе:
строки 577, 685, 703, 2226. Тест `src/lib/logging.test.ts` проверяет, что
ключ и пароль не попадают в вывод.

### 1.5. Удаление пользователя из чатов

Каскады описаны в `supabase/schema.sql`:

- `chat_participants.user_id → profiles(id) on delete cascade` (строка 175);
- `messages.sender_id → profiles(id) on delete cascade` (строка 216);
- `media`/`read_state` — каскад через сообщение/пользователя;
- `chats.owner_id → profiles(id) on delete set null` (строки 1720-1737):
  удаление автора не уносит чат у остальных участников.

Живой тест — `supabase/delete_user_check.sql`: в транзакции создаёт
пользователя, чат, участие и сообщение, удаляет профиль и проверяет, что
сообщений и участий не осталось, а чат существует с `owner_id = null`.
**Не выполнен в этой среде** (нужен SQL Editor).

## 2. Найденные проблемы

| # | Проблема | Серьёзность | Статус |
|---|----------|-------------|--------|
| 0 | `x-user-id` не подписан: любой с anon-ключом выдаёт себя за другого | Критическая | Исправлено: `x-session-token` + `auth_tokens`; требуется применить `schema.sql` |
| 1 | Любой авторизованный мог вставить себя в `chat_participants` чужого чата | Критическая | Исправлено политикой `participants_insert` |
| 2 | `profiles.encrypted_private_key` читался всеми | Высокая | Колонка закрыта, ключ отдаёт RPC после пароля |
| 3 | Любой участник мог изменить/удалить чужое сообщение | Высокая | `messages_update/delete` — только автор; RPC скрытия |
| 4 | Подделка `sender_id` | Высокая | `messages_insert`: sender = current_user_id + членство |
| 5 | Медиа к чужому сообщению | Средняя | `media_write`: только к своему |
| 6 | «Очистить историю» удаляла у всех | Средняя | `hide_chat` скрывает только у вызывающего |
| 7 | Чужой `owner_id` при создании чата | Средняя | `chats_insert`: владелец — текущий |
| 8 | Зашифрованный ключ в ответе на создание | Низкая | INSERT…RETURNING по публичным полям |

## 3. Остаточные риски

1. Приватный ключ хранится в `localStorage` (зашифрован паролем).
2. Пароли — SHA-256(login:password) без соли; нужен Argon2/bcrypt или Supabase Auth.
3. Storage-бакет `media` доступен по anon-ключу (содержимое зашифровано).
4. Участники группы видят публичные ключи друг друга — необходимо для E2EE.

## 4. Как воспроизвести проверки

```powershell
npm test                                  # 30 тестов, включая маскирование логов
node scripts/security-rls-test.js         # демонстрация подделки x-user-id
```

```sql
-- Supabase SQL Editor
-- 1) schema.sql (RLS, RPC, гранты)
-- 2) security_tests.sql    → все passed = true
-- 3) delete_user_check.sql → messages_left = 0, participants_left = 0,
--                            chat_still_exists = 1, chat_owner_is_null = 1
```
