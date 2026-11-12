-- «Связь» — схема Supabase.
-- Выполните этот файл целиком в Supabase Studio → SQL Editor → New query → Run.
-- Скрипт идемпотентен: повторный запуск ничего не сломает и не создаст дублей.
--
-- Что здесь есть:
--   1. таблицы profiles / credentials / chats / chat_participants / messages /
--      media / read_state / presence;
--   2. RLS: читать можно только свои чаты, пароли снаружи не читаются вообще;
--   3. функции verify_login / change_password (пароль проверяется на сервере);
--   4. seed_svyaz_users(): админ + 200 курсантов прямо в базе.
--
-- ВАЖНО: пароль на клиенте хэшируется как SHA-256(login + ':' + password).
-- Соль не используется — это ограничение выбранной схемы; для продакшена
-- переходите на Supabase Auth (см. README).

-- pgcrypto не нужен: sha256() и gen_random_uuid() встроены в PostgreSQL 13+.

-- 1. Таблицы -----------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key,
  login text not null unique,
  full_name text not null default '',
  group_name text not null default '',
  role text not null default 'cadet' check (role in ('cadet', 'admin')),
  public_key_jwk jsonb,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

-- Миграции: добавляем новые колонки профиля, не трогая существующие.
do $$ begin
  begin
    alter table public.profiles add column if not exists avatar_url text;
  exception when duplicate_column then null;
  end;
  begin
    -- Приватный ECDH-ключ, зашифрованный AES-GCM паролем пользователя.
    -- Хранится, чтобы ключ был переносимым и старые сообщения читались
    -- с любого устройства после входа по логину и паролю.
    alter table public.profiles add column if not exists encrypted_private_key text;
  exception when duplicate_column then null;
  end;
end $$;

-- Журнал входов: где и когда выполнен вход (для «выйти на всех устройствах»).
create table if not exists public.sessions (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  device_name text not null default '',
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  last_seen bigint not null default (extract(epoch from now()) * 1000)::bigint
);

-- Миграция с ранней версии, где password_hash лежал прямо в profiles.
create table if not exists public.credentials (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  password_hash text not null
);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'password_hash'
  ) then
    insert into public.credentials (profile_id, password_hash)
      select id, password_hash from public.profiles where password_hash is not null
      on conflict (profile_id) do nothing;
    alter table public.profiles drop column password_hash;
  end if;
end $$;

create table if not exists public.chats (
  id uuid primary key,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  saved boolean not null default false,
  owner_id uuid references public.profiles(id) on delete cascade
);

-- Миграции: добавляем новые колонки чатов.
do $$ begin
  begin
    alter table public.chats add column if not exists secret boolean not null default false;
  exception when duplicate_column then null;
  end;
end $$;

-- Автоделеция сообщений в секретных чатах: сообщения старше 24 часов удаляются.
-- Вызывается по cron (pg_cron) или вручную каждые 10 минут.
create or replace function public.cleanup_secret_chats() returns integer
language sql security definer set search_path = public as $$
  with del as (
    delete from public.messages m
    using public.chats c
    where m.chat_id = c.id
      and c.secret = true
      and m.created_at < (extract(epoch from now()) * 1000 - 24 * 60 * 60 * 1000)
    returning m.id
  )
  select count(*)::integer from del;
$$;

grant execute on function public.cleanup_secret_chats() to anon, authenticated;

create table if not exists public.chat_participants (
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (chat_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key,
  chat_id uuid not null references public.chats(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  ciphertext text not null default '',
  iv text not null default '',
  wrapped_key text,
  wrapped_key_iv text,
  wrapped_self_key text,
  wrapped_self_key_iv text,
  type text not null default 'text',
  mime_type text,
  duration integer,
  waveform jsonb,
  status text not null default 'sent' check (status in ('sent', 'delivered', 'read')),
  edited_at bigint,
  deleted boolean not null default false,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

-- Миграции: добавляем новые колонки, не трогая существующие.
do $$ begin
  -- Ответ на сообщение (reply): id исходного сообщения
  begin
    alter table public.messages add column if not exists reply_to_id uuid;
  exception when duplicate_column then null;
  end;

  -- «Удалить у себя»: список пользователей, для которых сообщение скрыто
  -- (массив uuid). Собеседник при этом видит сообщение в обычном виде.
  begin
    alter table public.messages add column if not exists deleted_for uuid[] not null default '{}';
  exception when duplicate_column then null;
  end;

  -- Ссылка на зашифрованное медиа в Supabase Storage (bucket 'media').
  -- Если заполнена — ciphertext в таблице media не используется (фолбэк для
  -- старых сообщений, которые всё ещё лежат в базе).
  begin
    alter table public.messages add column if not exists storage_path text;
  exception when duplicate_column then null;
  end;
end $$;

create table if not exists public.media (
  msg_id uuid primary key references public.messages(id) on delete cascade,
  ciphertext text not null default '',
  iv text not null default '',
  wrapped_key text,
  wrapped_key_iv text,
  wrapped_self_key text,
  wrapped_self_key_iv text,
  mime_type text not null default 'application/octet-stream'
);

-- Дружбы больше нет: чат открывается сразу из поиска. Если таблица осталась
-- от предыдущей версии, её можно удалить вручную (на работу приложения это
-- не влияет):
-- drop table if exists public.friendships;

create table if not exists public.read_state (
  user_id uuid not null references public.profiles(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  last_read_at bigint not null default 0,
  primary key (user_id, chat_id)
);

create table if not exists public.presence (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  last_seen bigint not null default 0
);

create index if not exists messages_chat_created_idx on public.messages (chat_id, created_at);
create index if not exists chat_participants_user_idx on public.chat_participants (user_id);

-- 2. Кто выполняет запрос ------------------------------------------------------
-- Клиент присылает id вошедшего пользователя в заголовке x-user-id
-- (см. src/lib/supabase.ts). Политики читают его отсюда.

create or replace function public.current_user_id() returns uuid
language sql stable as $$
  select nullif(coalesce(current_setting('request.headers', true)::json ->> 'x-user-id', ''), '')::uuid
$$;

-- Участник чата? SECURITY DEFINER — чтобы не было рекурсии политик.
create or replace function public.is_chat_member(p_chat uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.chat_participants
    where chat_id = p_chat and user_id = p_user
  )
$$;

create or replace function public.is_message_member(p_msg uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.messages m
    join public.chat_participants cp on cp.chat_id = m.chat_id
    where m.id = p_msg and cp.user_id = p_user
  )
$$;

-- 3. Вход и смена пароля -------------------------------------------------------
-- Клиент присылает SHA-256(login + ':' + password) — сам пароль на сервер не идёт.
-- Функции SECURITY DEFINER: таблицу credentials снаружи читать нельзя.

create or replace function public.verify_login(p_login text, p_hash text)
returns setof public.profiles
language sql stable security definer set search_path = public as $$
  select p.*
  from public.profiles p
  join public.credentials c on c.profile_id = p.id
  where p.login = lower(trim(p_login))
    and lower(trim(c.password_hash)) = lower(trim(p_hash))
  limit 1
$$;

create or replace function public.change_password(
  p_profile uuid,
  p_current_hash text,
  p_new_hash text
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.credentials
     set password_hash = lower(trim(p_new_hash))
   where profile_id = p_profile
     and lower(password_hash) = lower(trim(p_current_hash));
  return found;
end;
$$;

-- 3b. Админ-функции -------------------------------------------------------------
-- Все действия выполняются админом; роль проверяется по current_user_id().
-- SECURITY DEFINER нужен, чтобы обойти RLS (RLS не даёт менять чужие профили).

/** Является ли вызывающий админом */
create or replace function public.current_user_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = public.current_user_id() and role = 'admin'
  )
$$;

/** Сбросить пароль пользователя (админ задаёт новый хэш) */
create or replace function public.admin_reset_password(
  p_profile uuid,
  p_new_hash text
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.current_user_is_admin() then
    return false;
  end if;
  update public.credentials
     set password_hash = lower(trim(p_new_hash))
   where profile_id = p_profile;
  return found;
end;
$$;

/** Обновить ФИО и/или группу пользователя (только админ) */
create or replace function public.admin_update_profile(
  p_profile uuid,
  p_full_name text,
  p_group text
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.current_user_is_admin() then
    return false;
  end if;
  update public.profiles
     set full_name = coalesce(p_full_name, ''),
         group_name = coalesce(p_group, '')
   where id = p_profile;
  return found;
end;
$$;

/** Удалить пользователя полностью: профиль, пароль, ключи, чаты, сессии */
create or replace function public.admin_delete_user(p_profile uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.current_user_is_admin() then
    return false;
  end if;
  -- каскады: credentials, sessions, read_state, presence, chat_participants,
  -- messages/media удалены связкой, но часть таблиц без on delete cascade —
  -- чистим вручную через чаты, где он участник.
  delete from public.media
    where msg_id in (
      select m.id from public.messages m
      join public.chat_participants cp on cp.chat_id = m.chat_id
      where cp.user_id = p_profile
    );
  delete from public.messages
    where chat_id in (select chat_id from public.chat_participants where user_id = p_profile);
  delete from public.chats
    where id in (select chat_id from public.chat_participants where user_id = p_profile);
  delete from public.profiles where id = p_profile;
  return found;
end;
$$;

/** Выйти на всех устройствах пользователя: сбросить его сессии */
create or replace function public.admin_logout_user(p_profile uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.current_user_is_admin() then
    return false;
  end if;
  delete from public.sessions where user_id = p_profile;
  return found;
end;
$$;

grant execute on function public.current_user_is_admin() to anon, authenticated;
grant execute on function public.admin_reset_password(uuid, text) to anon, authenticated;
grant execute on function public.admin_update_profile(uuid, text, text) to anon, authenticated;
grant execute on function public.admin_delete_user(uuid) to anon, authenticated;
grant execute on function public.admin_logout_user(uuid) to anon, authenticated;

-- 4. Наполнение базы -----------------------------------------------------------
-- Создаёт admin / admin12345 и cadet001..cadet200 / test1234.
-- Повторный вызов досоздаёт только отсутствующих.

create or replace function public.seed_svyaz_users()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  male_names text[] := array[
    'Александр','Андрей','Артём','Богдан','Вадим','Валерий','Василий','Виктор',
    'Владимир','Владислав','Георгий','Глеб','Григорий','Даниил','Денис','Дмитрий',
    'Евгений','Егор','Иван','Игорь','Илья','Кирилл','Константин','Лев',
    'Максим','Марат','Михаил','Никита','Николай','Олег','Павел','Пётр',
    'Роман','Руслан','Семён','Сергей','Станислав','Степан','Тимофей','Юрий'
  ];
  female_names text[] := array[
    'Алина','Алёна','Анастасия','Анна','Валерия','Варвара','Вера','Виктория',
    'Дарья','Диана','Евгения','Екатерина','Елена','Елизавета','Ирина','Карина',
    'Кристина','Ксения','Лариса','Любовь','Маргарита','Марина','Мария','Надежда',
    'Наталья','Ольга','Полина','Светлана','Софья','Тамара','Татьяна','Ульяна',
    'Юлия','Яна','Арина','Вероника','Александра','Людмила','Ангелина','Оксана'
  ];
  male_surnames text[] := array[
    'Иванов','Смирнов','Кузнецов','Попов','Васильев','Петров','Соколов','Михайлов',
    'Новиков','Фёдоров','Морозов','Волков','Алексеев','Лебедев','Семёнов','Егоров',
    'Павлов','Козлов','Степанов','Николаев','Орлов','Андреев','Макаров','Никитин',
    'Захаров','Зайцев','Соловьёв','Борисов','Яковлев','Григорьев','Романов','Воробьёв',
    'Сергеев','Крылов','Титов','Комаров','Киселёв','Фомин','Дроздов','Белов'
  ];
  female_surnames text[] := array[
    'Иванова','Смирнова','Кузнецова','Попова','Васильева','Петрова','Соколова','Михайлова',
    'Новикова','Фёдорова','Морозова','Волкова','Алексеева','Лебедева','Семёнова','Егорова',
    'Павлова','Козлова','Степанова','Николаева','Орлова','Андреева','Макарова','Никитина',
    'Захарова','Зайцева','Соловьёва','Борисова','Яковлева','Григорьева','Романова','Воробьёва',
    'Сергеева','Крылова','Титова','Комарова','Киселёва','Фомина','Дроздова','Белова'
  ];
  male_patronymics text[] := array[
    'Александрович','Алексеевич','Андреевич','Анатольевич','Аркадьевич','Борисович',
    'Вадимович','Валентинович','Валерьевич','Васильевич','Викторович','Витальевич',
    'Владимирович','Владиславович','Вячеславович','Геннадьевич','Георгиевич','Григорьевич',
    'Денисович','Дмитриевич','Евгеньевич','Иванович','Игоревич','Ильич',
    'Константинович','Леонидович','Максимович','Михайлович','Николаевич','Олегович'
  ];
  female_patronymics text[] := array[
    'Александровна','Алексеевна','Андреевна','Анатольевна','Борисовна','Вадимовна',
    'Валентиновна','Валерьевна','Васильевна','Викторовна','Витальевна','Владимировна',
    'Владиславовна','Вячеславовна','Геннадьевна','Георгиевна','Григорьевна','Денисовна',
    'Дмитриевна','Евгеньевна','Ивановна','Игоревна','Ильинична','Константиновна',
    'Леонидовна','Максимовна','Михайловна','Николаевна','Олеговна','Сергеевна'
  ];
  i integer;
  v_login text;
  v_full_name text;
  v_group text;
  v_id uuid;
  v_female boolean;
  v_block integer;
  v_pos integer;
  v_name_idx integer;
  v_patr_idx integer;
  created integer := 0;
begin
  if not exists (select 1 from public.profiles where login = 'admin') then
    v_id := gen_random_uuid();
    insert into public.profiles (id, login, full_name, group_name, role)
      values (v_id, 'admin', 'Администратор Системы', '000', 'admin');
    insert into public.credentials (profile_id, password_hash)
      values (v_id, encode(sha256(convert_to('admin:admin12345', 'UTF8')), 'hex'));
    created := created + 1;
  end if;

  for i in 1..200 loop
    v_login := 'cadet' || lpad(i::text, 3, '0');
    if not exists (select 1 from public.profiles where login = v_login) then
      v_female := (i % 2 = 0);

      -- Раньше ФИО повторялись каждые 40 записей: в одном взводе оказывалось
      -- до 5 курсантов с одинаковым ФИО, и поиск выглядел «ограниченным».
      -- Смешиваем индексы так, чтобы у всех 200 курсантов ФИО были разными.
      v_block := (i - 1) / 40;
      v_pos := (i - 1) % 40;
      if v_female then
        v_name_idx := 1 + (((v_pos * 7) + (v_block * 10)) % array_length(female_names, 1));
        v_patr_idx := 1 + (((v_pos * 3) + (v_block * 7)) % array_length(female_patronymics, 1));
        v_full_name :=
          female_surnames[1 + ((i - 1) % array_length(female_surnames, 1))] || ' ' ||
          female_names[v_name_idx] || ' ' ||
          female_patronymics[v_patr_idx];
      else
        v_name_idx := 1 + (((v_pos * 7) + (v_block * 10)) % array_length(male_names, 1));
        v_patr_idx := 1 + (((v_pos * 3) + (v_block * 7)) % array_length(male_patronymics, 1));
        v_full_name :=
          male_surnames[1 + ((i - 1) % array_length(male_surnames, 1))] || ' ' ||
          male_names[v_name_idx] || ' ' ||
          male_patronymics[v_patr_idx];
      end if;

      v_group := (1 + ((i - 1) % 10))::text || ' взвод';
      v_id := gen_random_uuid();
      insert into public.profiles (id, login, full_name, group_name, role)
        values (v_id, v_login, v_full_name, v_group, 'cadet');
      insert into public.credentials (profile_id, password_hash)
        values (v_id, encode(sha256(convert_to(v_login || ':test1234', 'UTF8')), 'hex'));
      created := created + 1;
    end if;
  end loop;

  return created;
end;
$$;

-- 5. RLS -----------------------------------------------------------------------
-- Включаем на всех таблицах. Политики — минимально необходимые для работы
-- мессенджера; пароли (credentials) снаружи не читаются и не меняются.

alter table public.profiles enable row level security;
alter table public.credentials enable row level security;
alter table public.chats enable row level security;
alter table public.chat_participants enable row level security;
alter table public.messages enable row level security;
alter table public.media enable row level security;
alter table public.read_state enable row level security;
alter table public.presence enable row level security;
alter table public.sessions enable row level security;

-- profiles: читать можно всех (нужен поиск по ФИО), менять — только себя.
-- insert разрешён анонимному клиенту для первичного seed и создания аккаунта
-- в закрытой группе; зарегистрироваться «с улицы» всё равно можно только
-- зная адрес проекта.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (true);

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert
  with check (public.current_user_id() is null or id = public.current_user_id());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  using (id = public.current_user_id())
  with check (id = public.current_user_id());

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete
  using (id = public.current_user_id());

-- credentials: ни одной политики на select/update/delete — прямой доступ закрыт.
-- Вставка нужна только seed-у (пока пользователь не вошёл) либо себе.
drop policy if exists credentials_insert on public.credentials;
create policy credentials_insert on public.credentials for insert
  with check (public.current_user_id() is null or profile_id = public.current_user_id());

-- chats
drop policy if exists chats_select on public.chats;
create policy chats_select on public.chats for select
  using (public.is_chat_member(id, public.current_user_id()));

drop policy if exists chats_insert on public.chats;
create policy chats_insert on public.chats for insert
  with check (public.current_user_id() is not null);

drop policy if exists chats_update on public.chats;
create policy chats_update on public.chats for update
  using (public.is_chat_member(id, public.current_user_id()) or owner_id = public.current_user_id());

-- chat_participants
drop policy if exists participants_select on public.chat_participants;
create policy participants_select on public.chat_participants for select
  using (public.is_chat_member(chat_id, public.current_user_id()));

drop policy if exists participants_insert on public.chat_participants;
create policy participants_insert on public.chat_participants for insert
  with check (public.current_user_id() is not null);

drop policy if exists participants_delete on public.chat_participants;
create policy participants_delete on public.chat_participants for delete
  using (public.is_chat_member(chat_id, public.current_user_id()));

-- messages
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select
  using (public.is_chat_member(chat_id, public.current_user_id()));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert
  with check (
    sender_id = public.current_user_id()
    and public.is_chat_member(chat_id, public.current_user_id())
  );

drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages for update
  using (public.is_chat_member(chat_id, public.current_user_id()));

drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages for delete
  using (public.is_chat_member(chat_id, public.current_user_id()));

-- media
drop policy if exists media_select on public.media;
create policy media_select on public.media for select
  using (public.is_message_member(msg_id, public.current_user_id()));

drop policy if exists media_write on public.media;
create policy media_write on public.media for insert
  with check (public.is_message_member(msg_id, public.current_user_id()));

drop policy if exists media_update on public.media;
create policy media_update on public.media for update
  using (public.is_message_member(msg_id, public.current_user_id()));

drop policy if exists media_delete on public.media;
create policy media_delete on public.media for delete
  using (public.is_message_member(msg_id, public.current_user_id()));

-- read_state
drop policy if exists read_state_all on public.read_state;
create policy read_state_all on public.read_state for all
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

-- presence
drop policy if exists presence_select on public.presence;
create policy presence_select on public.presence for select using (true);

drop policy if exists presence_upsert on public.presence;
create policy presence_upsert on public.presence for insert
  with check (user_id = public.current_user_id());

drop policy if exists presence_update on public.presence;
create policy presence_update on public.presence for update
  using (user_id = public.current_user_id());

-- sessions: читать и удалять можно только свои сессии (журнал входов).
drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions for select
  using (user_id = public.current_user_id());

drop policy if exists sessions_insert on public.sessions;
create policy sessions_insert on public.sessions for insert
  with check (user_id = public.current_user_id());

drop policy if exists sessions_update on public.sessions;
create policy sessions_update on public.sessions for update
  using (user_id = public.current_user_id());

drop policy if exists sessions_delete on public.sessions;
create policy sessions_delete on public.sessions for delete
  using (user_id = public.current_user_id());

-- 6. Права ---------------------------------------------------------------------
-- RLS выше ограничивает строки; гранты дают роли anon сам доступ к таблицам.
-- Без грантов PostgREST вернёт «permission denied».

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant execute on function public.current_user_id() to anon, authenticated;
grant execute on function public.is_chat_member(uuid, uuid) to anon, authenticated;
grant execute on function public.is_message_member(uuid, uuid) to anon, authenticated;
grant execute on function public.verify_login(text, text) to anon, authenticated;
grant execute on function public.change_password(uuid, text, text) to anon, authenticated;
grant execute on function public.seed_svyaz_users() to anon, authenticated;

-- 7. Наполнение ---------------------------------------------------------------
-- При первом выполнении создаст 201 учётную запись. Повторно — ничего.

select public.seed_svyaz_users() as seeded_profiles;

