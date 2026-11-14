-- Мастер-копия текста сообщения для восстановления истории владельцем.
-- Пишется клиентом только после успешной вставки сообщения; при отсутствии
-- колонки клиент молча пропускает запись (см. db.saveMasterCopy).
alter table public.messages add column if not exists master_ciphertext text;
