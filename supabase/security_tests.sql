-- ============================================================
-- Тесты безопасности RLS для «Связи».
--
-- Запуск: Supabase → SQL Editor → вставить целиком → Run.
-- Скрипт ничего не меняет: только читает и пытается сделать запрещённые
-- вставки, которые должны быть заблокированы политиками.
--
-- Первая строка задаёт, от чьего имени выполняются проверки (логин ниже
-- можно заменить на любой существующий).
-- ============================================================

-- Одноразовый токен для теста: в базе лежит только его SHA-256.
insert into public.auth_tokens (token_hash, user_id, expires_at)
select
  encode(sha256(convert_to('rls-test-token', 'UTF8')), 'hex'),
  id,
  9999999999999
from public.profiles
where login = 'cadet143'
on conflict (token_hash) do nothing;

select set_config(
  'request.headers',
  json_build_object('x-session-token', 'rls-test-token')::text,
  false
);

set role anon;

select * from public.security_selftest();

reset role;

delete from public.auth_tokens
 where token_hash = encode(sha256(convert_to('rls-test-token', 'UTF8')), 'hex');

-- Ожидаемый результат (все passed = true):
--   foreign_chat_found           — найден чужой чат для проверки
--   foreign_messages_hidden      — сообщения чужого чата не видны
--   foreign_media_hidden         — медиа чужого чата не видно
--   credentials_hidden           — хеши паролей недоступны
--   private_key_column_hidden    — зашифрованный приватный ключ закрыт
--   cannot_join_foreign_chat     — нельзя добавить себя в чужой чат
--   cannot_spoof_message         — нельзя вставить сообщение от чужого имени
