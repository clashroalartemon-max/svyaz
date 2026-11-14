-- ============================================================
-- СРОЧНЫЙ ФИКС: «permission denied for table ...» + аватарки.
--
-- Запуск: Supabase → SQL Editor → вставить целиком → Run.
-- Скрипт идемпотентный, его можно выполнять повторно.
--
-- Важно: таблицы credentials и auth_tokens НЕ открываются клиенту —
-- иначе утекут хеши паролей и сессионные токены. Для них доступ идёт
-- только через SECURITY DEFINER-функции.
-- ============================================================

grant usage on schema public to anon, authenticated;

-- Базовые права на все таблицы; RLS по-прежнему ограничивает строки.
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

-- profiles: убираем табличный select (там encrypted_private_key),
-- оставляем только публичные колонки, включая status и bio.
revoke select, insert, update on public.profiles from anon, authenticated;

grant select (
  id, login, full_name, group_name, role, military_rank, position,
  role_level, username, public_key_jwk, avatar_url, department, phone,
  status, bio, created_at
) on public.profiles to anon, authenticated;

grant insert (
  id, login, full_name, group_name, role, military_rank, position,
  role_level, username, public_key_jwk, encrypted_private_key,
  avatar_url, department, phone, status, bio, created_at
) on public.profiles to anon, authenticated;

grant update (
  full_name, group_name, role, military_rank, position, role_level,
  username, public_key_jwk, encrypted_private_key, avatar_url,
  department, phone, status, bio
) on public.profiles to anon, authenticated;

grant delete on public.profiles to anon, authenticated;

revoke all on public.credentials from anon, authenticated;
revoke all on public.auth_tokens from anon, authenticated;

-- Бакет аватарок: публичное чтение, запись через anon/authenticated.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

drop policy if exists svyaz_avatars_read on storage.objects;
create policy svyaz_avatars_read on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists svyaz_avatars_insert on storage.objects;
create policy svyaz_avatars_insert on storage.objects for insert
  with check (bucket_id = 'avatars');

drop policy if exists svyaz_avatars_update on storage.objects;
create policy svyaz_avatars_update on storage.objects for update
  using (bucket_id = 'avatars');

drop policy if exists svyaz_avatars_delete on storage.objects;
create policy svyaz_avatars_delete on storage.objects for delete
  using (bucket_id = 'avatars');

-- Проверка: должны вернуться строки с правами.
select grantee, privilege_type, column_name
  from information_schema.column_privileges
 where table_schema = 'public'
   and table_name = 'profiles'
   and column_name in ('status', 'bio')
 order by grantee, privilege_type;
