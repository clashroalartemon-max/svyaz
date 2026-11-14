-- Мастер-ключ: резервная копия приватного ключа, зашифрованная мастер-ключом.
-- Мастер-ключ хранится в profiles в виде, зашифрованном паролем пользователя.
alter table public.profiles add column if not exists master_key_wrapped text;
alter table public.profiles add column if not exists private_key_master text;

-- Клиент обновляет только свои поля; гранты уже выданы в fix_permissions.sql.
grant update (master_key_wrapped, private_key_master) on public.profiles to authenticated;
