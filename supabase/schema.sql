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
  -- Военная иерархия: звание, должность, уровень прав (1..10), уникальный ник.
  -- Колонка называется military_rank, а НЕ rank: имя rank конфликтует с
  -- агрегатной функцией PostgreSQL rank() и роняет PostgREST-запросы
  -- ошибкой «WITHIN GROUP is required for ordered-set aggregate rank».
  begin
    alter table public.profiles add column if not exists military_rank text;
  exception when duplicate_column then null;
  end;
  begin
    alter table public.profiles add column if not exists position text;
  exception when duplicate_column then null;
  end;
  begin
    alter table public.profiles add column if not exists role_level integer not null default 1;
  exception when duplicate_column then null;
  end;
  begin
    alter table public.profiles add column if not exists username text;
  exception when duplicate_column then null;
  end;
  -- Подразделение (факультет / кафедра / управление) из таблицы departments.
  begin
    alter table public.profiles add column if not exists department text;
  exception when duplicate_column then null;
  end;
  -- Контактный телефон сотрудника.
  begin
    alter table public.profiles add column if not exists phone text;
  exception when duplicate_column then null;
  end;
end $$;

-- Миграция: если колонка ошибочно называлась rank — переименовываем в military_rank.
do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'rank'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'military_rank'
  ) then
    alter table public.profiles rename column "rank" to military_rank;
  elsif exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'rank'
  ) then
    -- обе колонки есть: переносим данные и удаляем старую
    update public.profiles set military_rank = "rank" where military_rank is null;
    alter table public.profiles drop column "rank";
  end if;
end $$;

-- Ник уникален среди заполненных (NULL разрешён — у старых пользователей).
do $$ begin
  create unique index if not exists profiles_username_unique_idx
    on public.profiles (username)
    where username is not null and username <> '';
exception when duplicate_table then null;
end $$;

-- Бэкфилл для существующих баз: у курсантов без звания ставим рядового,
-- у админа — полковника (начальник университета), курсантам — уровень 1.
update public.profiles p
   set military_rank = 'рядовой', position = 'курсант', role_level = 1
 where p.role = 'cadet' and p.military_rank is null;
update public.profiles p
   set military_rank = 'полковник', position = 'начальник университета', role_level = 10
 where p.role = 'admin' and p.military_rank is null;

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
  -- Тип чата: direct (личный), squad (взвод), commander, course (курсовой),
  -- teachers (преподаватели), group (общий с взводом), broadcast (рассылка).
  begin
    alter table public.chats add column if not exists kind text not null default 'direct';
  exception when duplicate_column then null;
  end;
  -- Название группового чата (у личных равно пустому).
  begin
    alter table public.chats add column if not exists title text;
  exception when duplicate_column then null;
  end;
  -- Для broadcast: какому взводу/курсу адресовано (например «152» или «курс 1»).
  begin
    alter table public.chats add column if not exists target text;
  exception when duplicate_column then null;
  end;
end $$;

-- Архив: у каждого пользователя свой набор архивированных чатов.
create table if not exists public.chat_archive (
  user_id uuid not null references public.profiles(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  archived_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  primary key (user_id, chat_id)
);

-- Контакты: «звёздочка», папка (однокурсники/командиры/преподаватели/другое).
create table if not exists public.contacts (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  folder text not null default 'Общие',
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  primary key (owner_id, user_id)
);

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

  -- Групповое шифрование: ключ контента, завёрнутый ECDH для каждого участника
  -- чата. JSONB вида {"<userId>": {"w": "base64", "i": "base64"}}.
  begin
    alter table public.messages add column if not exists group_keys jsonb;
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

-- Закреплённые чаты (в списке поднимаются наверх).
do $$ begin
  begin
    alter table public.chats add column if not exists pinned boolean not null default false;
  exception when duplicate_column then null;
  end;
end $$;

/**
 * Список ВСЕХ чатов для админ-панели: RLS обычного select показывает только
 * чаты, где админ участник, поэтому отдаём данные из security definer-функции.
 */
create or replace function public.admin_list_chats(p_limit integer default 500)
returns table (
  id uuid,
  created_at bigint,
  kind text,
  title text,
  target text,
  pinned boolean,
  participants uuid[],
  message_count integer
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.current_user_is_admin() then
    return;
  end if;
  return query
    select c.id,
           c.created_at,
           coalesce(c.kind, 'direct'),
           c.title,
           c.target,
           coalesce(c.pinned, false),
           coalesce(array_agg(distinct cp.user_id) filter (where cp.user_id is not null), '{}')::uuid[],
           (select count(*)::integer from public.messages m where m.chat_id = c.id)
      from public.chats c
      left join public.chat_participants cp on cp.chat_id = c.id
     group by c.id, c.created_at, c.kind, c.title, c.target, c.pinned
     order by c.created_at desc
     limit greatest(1, least(2000, coalesce(p_limit, 500)));
end;
$$;

grant execute on function public.admin_list_chats(integer) to anon, authenticated;

create index if not exists messages_chat_created_idx on public.messages (chat_id, created_at);
create index if not exists chat_participants_user_idx on public.chat_participants (user_id);
create index if not exists contacts_owner_idx on public.contacts (owner_id, folder);
create index if not exists chat_archive_user_idx on public.chat_archive (user_id);

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

/** Обновить профиль пользователя: ФИО, группа, звание, должность, подразделение, уровень прав (только админ) */
create or replace function public.admin_update_profile(
  p_profile uuid,
  p_full_name text,
  p_group text,
  p_rank text,
  p_position text,
  p_role_level integer,
  p_department text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.current_user_is_admin() then
    return false;
  end if;
  update public.profiles
     set full_name = coalesce(p_full_name, ''),
         group_name = coalesce(p_group, ''),
         military_rank = nullif(coalesce(p_rank, ''), ''),
         position = nullif(coalesce(p_position, ''), ''),
         department = nullif(coalesce(p_department, ''), ''),
         role_level = greatest(1, least(10, coalesce(p_role_level, 1)))
   where id = p_profile;
  return found;
end;
$$;

/** Установить уникальный ник пользователя (сам пользователь, не админ) */
create or replace function public.set_username(p_username text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := public.current_user_id();
begin
  if v_user is null then
    return false;
  end if;
  if nullif(trim(coalesce(p_username, '')), '') is null then
    -- Пустой ник = очистить.
    update public.profiles set username = null where id = v_user;
    return true;
  end if;
  if exists (
    select 1 from public.profiles
    where username = lower(trim(p_username)) and id <> v_user
  ) then
    return false;
  end if;
  update public.profiles set username = lower(trim(p_username)) where id = v_user;
  return found;
end;
$$;

/**
 * Автоматические чаты взвода (Ч.3): по первому входу пользователю создаются
 * (или возвращаются уже созданные) системные чаты:
 *   • «Чат взвода» (kind='squad') — все курсанты и командиры его взвода;
 *   • «С командиром взвода» (kind='commander', 1:1 с командиром взвода);
 *   • «С курсовым» (kind='course', 1:1 с начальником курса);
 *   • «С преподавателями» (kind='teachers') — общий чат курса.
 * Функция SECURITY DEFINER, потому что добавляет участников в новые чаты
 * (INSERT в chat_participants без RLS-нарушений).
 * Возвращает список созданных chat_id.
 */
create or replace function public.ensure_auto_chats(p_user uuid)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles%rowtype;
  v_squad text;
  v_course text;
  v_cmd_id uuid;
  v_course_level integer;
  v_chat_id uuid;
  v_members int;
  v_created text[] := '{}';
begin
  if p_user is null or not exists (select 1 from public.profiles where id = p_user) then
    return '{}';
  end if;
  select * into v_me from public.profiles where id = p_user;
  if v_me.role = 'admin' then
    return '{}';
  end if;

  -- Взвод из группы: «152 взвод» → '152'
  v_squad := trim(v_me.group_name);
  if v_squad ~ '^[0-9]+' then
    v_squad := (regexp_match(v_squad, '^[0-9]+'))[1];
  end if;
  if v_squad = '' then
    return '{}';
  end if;

  -- Командир взвода: должность «командир взвода» И та же группа.
  select id into v_cmd_id from public.profiles pr
   where pr.position = 'командир взвода' and pr.group_name = v_me.group_name
   order by pr.created_at asc limit 1;

  -- Курс из номера взвода: «152» → 1 (последняя цифра трёхзначного номера),
  -- иначе по 25 взводов на курс. Курс ограничен 1…4.
  if v_squad::integer >= 100 then
    v_course_level := v_squad::integer % 10;
  else
    v_course_level := ((v_squad::integer - 1) / 25) + 1;
  end if;
  if v_course_level < 1 then v_course_level := 1; end if;
  if v_course_level > 4 then v_course_level := 4; end if;
  v_course := 'начальник курса ' || v_course_level;

  -- 1) Чат взвода (групповой)
  select c.id into v_chat_id
    from public.chats c
    join public.chat_participants cp on cp.chat_id = c.id
   where c.kind = 'squad' and cp.user_id = p_user
   order by c.created_at asc limit 1;
  if v_chat_id is null then
    v_chat_id := gen_random_uuid();
    insert into public.chats (id, created_at, saved, owner_id, secret, kind, title, target)
      values (v_chat_id, (extract(epoch from now()) * 1000)::bigint, false, p_user, false,
              'squad', v_squad || ' взвод', v_squad);
    v_created := v_created || v_chat_id::text;
  end if;
  -- Состав взвода поддерживаем актуальным при каждом входе: новый курсант,
  -- добавленный в группу, сразу появляется в чате.
  insert into public.chat_participants (chat_id, user_id)
    select v_chat_id, id from public.profiles
     where group_name = v_me.group_name
     on conflict do nothing;
  -- Плюс командир взвода, если он в другом взводе.
  if v_cmd_id is not null then
    insert into public.chat_participants (chat_id, user_id) values (v_chat_id, v_cmd_id)
      on conflict do nothing;
  end if;

  -- 2) Личный чат с командиром взвода
  if v_cmd_id is not null and v_cmd_id <> p_user then
    select c.id into v_chat_id
      from public.chats c
      join public.chat_participants cp on cp.chat_id = c.id
      where c.kind = 'commander'
        and cp.user_id = p_user
      limit 1;
    if v_chat_id is null then
      v_chat_id := gen_random_uuid();
      insert into public.chats (id, created_at, saved, owner_id, secret, kind, title, target)
        values (v_chat_id, (extract(epoch from now()) * 1000)::bigint, false, p_user, false,
                'commander', null, v_squad);
      insert into public.chat_participants (chat_id, user_id) values (v_chat_id, p_user), (v_chat_id, v_cmd_id);
      v_created := v_created || v_chat_id::text;
    end if;
  end if;

  -- 3) Личный чат с начальником курса
  select id into v_cmd_id from public.profiles pr
   where pr.position = v_course
   order by pr.created_at asc limit 1;
  if v_cmd_id is not null and v_cmd_id <> p_user then
    select c.id into v_chat_id
      from public.chats c
      join public.chat_participants cp on cp.chat_id = c.id
      where c.kind = 'course'
        and cp.user_id = p_user
      limit 1;
    if v_chat_id is null then
      v_chat_id := gen_random_uuid();
      insert into public.chats (id, created_at, saved, owner_id, secret, kind, title, target)
        values (v_chat_id, (extract(epoch from now()) * 1000)::bigint, false, p_user, false,
                'course', null, v_course);
      insert into public.chat_participants (chat_id, user_id) values (v_chat_id, p_user), (v_chat_id, v_cmd_id);
      v_created := v_created || v_chat_id::text;
    end if;
  end if;

  -- 4) Чат «С преподавателями» (по курсу, target = 'курс N').
  -- В чат попадают ТОЛЬКО преподаватели и староста группы: обычный
  -- курсант чат не видит, он лишь может стать инициатором его создания.
  select c.id into v_chat_id
    from public.chats c
   where c.kind = 'teachers' and c.target = 'курс ' || v_course_level
   order by c.created_at asc limit 1;
  if v_chat_id is null then
    v_chat_id := gen_random_uuid();
    insert into public.chats (id, created_at, saved, owner_id, secret, kind, title, target)
      values (v_chat_id, (extract(epoch from now()) * 1000)::bigint, false, p_user, false,
              'teachers', 'Преподаватели курса ' || v_course_level, 'курс ' || v_course_level);
    v_created := v_created || v_chat_id::text;
  end if;
  insert into public.chat_participants (chat_id, user_id)
    select v_chat_id, pr.id
      from public.profiles pr
     where pr.position in (
             'преподаватель', 'доцент кафедры', 'начальник кафедры',
             'начальник факультета', 'начальник университета'
           )
        -- Староста — только своей группы, преподаватели — все.
        or (pr.position = 'староста группы' and pr.group_name = v_me.group_name)
    on conflict do nothing;

  return v_created;
end;
$$;

grant execute on function public.set_username(text) to anon, authenticated;
grant execute on function public.ensure_auto_chats(uuid) to anon, authenticated;

-- Гигиена чатов преподавателей. Раньше в них автоматически попадал каждый
-- курсант — убираем всех, у кого нет преподавательской должности и кто не
-- староста группы.
delete from public.chat_participants cp
using public.chats c, public.profiles pr
where cp.chat_id = c.id
  and cp.user_id = pr.id
  and c.kind = 'teachers'
  and coalesce(pr.position, '') not in (
    'преподаватель', 'доцент кафедры', 'начальник кафедры',
    'начальник факультета', 'начальник университета', 'староста группы'
  );

-- Удаляем пустые дубли чатов преподавателей (в т.ч. созданные старой
-- формулой курса — «Преподаватели курса 31»).
delete from public.chats c
where c.kind = 'teachers'
  and not exists (select 1 from public.messages m where m.chat_id = c.id)
  and (
    c.target !~ '^курс [1-4]$'
    or exists (
      select 1 from public.chats c2
       where c2.kind = 'teachers'
         and c2.id <> c.id
         and c2.target = c.target
         and c2.created_at < c.created_at
    )
  );

/**
 * Создать общий чат с выбранным взводом (Ч.3.3): вызывается пользователем
 * с role_level > 1. В чат автоматически добавляются ВСЕ курсанты и командиры
 * взвода — без возможности отказаться.
 */
create or replace function public.create_squad_group_chat(
  p_creator uuid,
  p_squad text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_level integer;
  v_chat_id uuid;
  v_group text;
begin
  if p_creator is null then
    return null;
  end if;
  select role_level into v_level from public.profiles where id = p_creator;
  if v_level is null or v_level <= 1 then
    return null;
  end if;
  if nullif(trim(coalesce(p_squad, '')), '') is null then
    return null;
  end if;

  v_group := trim(p_squad);
  if v_group ~ '^[0-9]+$' then
    v_group := v_group || ' взвод';
  end if;

  -- Чат на взвод: всегда один на взвод → находим существующий (kind='group', target=v_group)
  select c.id into v_chat_id
    from public.chats c
   where c.kind = 'group' and c.target = v_group
   limit 1;

  if v_chat_id is null then
    v_chat_id := gen_random_uuid();
    insert into public.chats (id, created_at, saved, owner_id, secret, kind, title, target)
      values (v_chat_id, (extract(epoch from now()) * 1000)::bigint, false, p_creator, false,
              'group', v_group, v_group);
  end if;

  insert into public.chat_participants (chat_id, user_id)
    select v_chat_id, id from public.profiles pr
     where pr.group_name = v_group
        or pr.position in ('командир взвода', 'начальник курса')
        or pr.id = p_creator
     on conflict do nothing;

  return v_chat_id;
end;
$$;

grant execute on function public.create_squad_group_chat(uuid, text) to anon, authenticated;

/**
 * Рассылка/оповещение (Ч.6): пользователь с role_level > 1 создаёт оповещение
 * для взвода / курса / факультета / университета. Создаётся чат kind='broadcast'
 * с заголовком-датой, адресаты добавляются автоматически.
 * Возвращает id чата (нового).
 */
create or replace function public.create_broadcast(
  p_creator uuid,
  p_target text,
  p_title text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_level integer;
  v_chat_id uuid;
  v_created bigint;
begin
  if p_creator is null then
    return null;
  end if;
  select role_level into v_level from public.profiles where id = p_creator;
  if v_level is null or v_level <= 1 then
    return null;
  end if;
  if nullif(trim(coalesce(p_target, '')), '') is null then
    return null;
  end if;

  v_created := (extract(epoch from now()) * 1000)::bigint;
  v_chat_id := gen_random_uuid();
  insert into public.chats (id, created_at, saved, owner_id, secret, kind, title, target)
    values (v_chat_id, v_created, false, p_creator, false,
            'broadcast', coalesce(nullif(trim(coalesce(p_title, '')), ''), 'Оповещение'), trim(p_target));

  -- Адресаты
  if p_target like 'взвод %' then
    insert into public.chat_participants (chat_id, user_id)
      select v_chat_id, id from public.profiles pr
       where pr.group_name = trim(substr(p_target, 7)) || ' взвод'
          or pr.id = p_creator
       on conflict do nothing;
  elsif p_target like 'курс %' then
    insert into public.chat_participants (chat_id, user_id)
      select v_chat_id, id from public.profiles pr
       where substring(pr.group_name from '^([0-9]+)')::int between
               ((substring(p_target from '[0-9]+')::int - 1) * 5 + 1) and
               (substring(p_target from '[0-9]+')::int * 5)
          or pr.position in ('преподаватель', 'доцент кафедры', 'начальник факультета', 'начальник университета')
          or pr.id = p_creator
       on conflict do nothing;
  elsif p_target = 'факультет' then
    insert into public.chat_participants (chat_id, user_id)
      select v_chat_id, id from public.profiles pr
       where pr.position in ('начальник факультета', 'начальник университета')
          or pr.id = p_creator
       on conflict do nothing;
  elsif p_target = 'университет' then
    insert into public.chat_participants (chat_id, user_id)
      select v_chat_id, id from public.profiles
       on conflict do nothing;
  else
    -- иначе: все, чья группа совпадает по номеру
    insert into public.chat_participants (chat_id, user_id)
      select v_chat_id, id from public.profiles pr
       where pr.group_name like p_target || '%'
          or pr.id = p_creator
       on conflict do nothing;
  end if;

  return v_chat_id;
end;
$$;

grant execute on function public.create_broadcast(uuid, text, text) to anon, authenticated;

-- ============================================================
-- Оповещения (рассылки) — НЕ создают чат.
-- Отдельная сущность «оповещение»: сохраняется запись и уведомляются
-- адресаты. Таблица broadcasts хранит текст и получателей; вкладка
-- «Оповещения» в интерфейсе показывает пришедшие оповещения.
-- ============================================================

create table if not exists public.broadcasts (
  id uuid primary key,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null default 'university'
    check (target_type in ('squad', 'course', 'faculty', 'university', 'custom')),
  target_value text,
  text text not null,
  target_user_ids uuid[] not null default '{}',
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

-- Подтверждённые адресаты оповещения: вычисляются в момент отправки.
create table if not exists public.broadcast_recipients (
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at bigint,
  primary key (broadcast_id, user_id)
);

-- Сопоставление «тип + значение» с профилями получателей.
create or replace function public.broadcast_target_users(
  p_target_type text,
  p_target_value text
) returns setof public.profiles
language sql stable security definer set search_path = public as $$
  select pr.* from public.profiles pr
  where
    case p_target_type
      when 'university' then true
      when 'squad' then pr.group_name = trim(coalesce(p_target_value, ''))
      when 'course' then
        substring(pr.group_name from '^([0-9]+)')::int between
          ((coalesce(p_target_value, '1')::int - 1) * 5 + 1) and
          (coalesce(p_target_value, '1')::int * 5)
        or pr.position in ('преподаватель', 'доцент кафедры', 'начальник факультета', 'начальник университета')
      when 'faculty' then
        pr.position in ('начальник факультета', 'начальник университета')
      else false
    end;
$$;

-- Отправить оповещение (role_level > 1): сохраняет запись и адресатов,
-- НЕ создаёт чат. Для custom — получатели из target_user_ids.
create or replace function public.send_broadcast(
  p_sender uuid,
  p_target_type text,
  p_target_value text,
  p_text text,
  p_target_user_ids uuid[] default '{}'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_level integer;
  v_id uuid;
  v_text text;
begin
  if p_sender is null then return null; end if;
  select role_level into v_level from public.profiles where id = p_sender;
  if v_level is null or v_level <= 1 then return null; end if;
  v_text := nullif(trim(coalesce(p_text, '')), '');
  if v_text is null then return null; end if;

  v_id := gen_random_uuid();
  insert into public.broadcasts (id, sender_id, target_type, target_value, text, target_user_ids, created_at)
    values (v_id, p_sender, coalesce(p_target_type, 'university'), p_target_value, v_text,
            coalesce(p_target_user_ids, '{}'), (extract(epoch from now()) * 1000)::bigint);

  if p_target_type = 'custom' then
    insert into public.broadcast_recipients (broadcast_id, user_id)
      select v_id, unnest(coalesce(p_target_user_ids, '{}'))
      on conflict do nothing;
  else
    insert into public.broadcast_recipients (broadcast_id, user_id)
      select v_id, id from public.broadcast_target_users(coalesce(p_target_type, 'university'), p_target_value)
      union
      select v_id, p_sender
      on conflict do nothing;
  end if;

  return v_id;
end;
$$;

grant execute on function public.send_broadcast(uuid, text, text, text, uuid[]) to anon, authenticated;
grant execute on function public.broadcast_target_users(text, text) to anon, authenticated;

-- RLS-политики для оповещений.
drop policy if exists broadcasts_select on public.broadcasts;
create policy broadcasts_select on public.broadcasts for select
  using (
    sender_id = public.current_user_id()
    or exists (
      select 1 from public.broadcast_recipients br
      where br.broadcast_id = public.broadcasts.id
        and br.user_id = public.current_user_id()
    )
  );

drop policy if exists broadcasts_insert on public.broadcasts;
create policy broadcasts_insert on public.broadcasts for insert
  with check (public.current_user_id() is not null);

drop policy if exists broadcasts_update on public.broadcasts;
create policy broadcasts_update on public.broadcasts for update
  using (sender_id = public.current_user_id());

drop policy if exists broadcast_recipients_select on public.broadcast_recipients;
create policy broadcast_recipients_select on public.broadcast_recipients for select
  using (user_id = public.current_user_id());

drop policy if exists broadcast_recipients_insert on public.broadcast_recipients;
create policy broadcast_recipients_insert on public.broadcast_recipients for insert
  with check (public.current_user_id() is not null);

-- ============================================================
-- Организационная структура университета МВД (Кикотя).
-- departments — подразделения; positions — должности в них.
-- ============================================================

create table if not exists public.departments (
  id uuid primary key,
  name text not null unique,
  kind text not null default 'departament'
    check (kind in ('university', 'institute', 'faculty', 'department', 'unit', 'center', 'library', 'club', 'clinic', 'veterans', 'committee')),
  parent_id uuid references public.departments(id) on delete cascade,
  sort_order integer not null default 0
);

create table if not exists public.positions (
  id uuid primary key,
  name text not null unique,
  department_id uuid references public.departments(id) on delete cascade,
  role_level integer not null default 1
);

-- ============================================================
-- Журнал действий (audit log): кто, что и когда сделал.
-- ============================================================

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  actor_name text,
  action text not null,
  target_type text,
  target_id text,
  details text,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
create index if not exists audit_log_actor_idx on public.audit_log (actor_id);

/** Записать событие в журнал. Вызывается клиентом после значимых действий. */
create or replace function public.log_audit(
  p_actor uuid,
  p_action text,
  p_target_type text default null,
  p_target_id text default null,
  p_details text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_name text;
begin
  if p_actor is null or nullif(trim(coalesce(p_action, '')), '') is null then
    return null;
  end if;
  select full_name into v_name from public.profiles where id = p_actor;
  v_id := gen_random_uuid();
  insert into public.audit_log (id, actor_id, actor_name, action, target_type, target_id, details, created_at)
    values (v_id, p_actor, v_name, trim(p_action), p_target_type, p_target_id, p_details,
            (extract(epoch from now()) * 1000)::bigint);
  return v_id;
end;
$$;

grant execute on function public.log_audit(uuid, text, text, text, text) to anon, authenticated;

-- ============================================================
-- Настройки системы (одна строка на ключ).
-- ============================================================

create table if not exists public.app_settings (
  key text primary key,
  value text not null default '',
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

insert into public.app_settings (key, value) values
  ('registration_enabled', 'false'),
  ('chats_disabled', 'false'),
  ('main_admin_id', '')
on conflict (key) do nothing;

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
  v_rank text := 'рядовой';
  v_position text := 'курсант';
  created integer := 0;
begin
  if not exists (select 1 from public.profiles where login = 'admin') then
    v_id := gen_random_uuid();
    insert into public.profiles (id, login, full_name, group_name, role, military_rank, position, role_level)
      values (v_id, 'admin', 'Администратор Системы', '000', 'admin', 'полковник', 'начальник университета', 10);
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
      -- Каждый 10-й курсант — командир отделения (сержант), остальные — рядовые.
      if i % 10 = 0 then
        v_rank := 'сержант';
        v_position := 'командир отделения';
      else
        v_rank := 'рядовой';
        v_position := 'курсант';
      end if;
      v_id := gen_random_uuid();
      insert into public.profiles (id, login, full_name, group_name, role, military_rank, position, role_level)
        values (v_id, v_login, v_full_name, v_group, 'cadet', v_rank, v_position, 1);
      insert into public.credentials (profile_id, password_hash)
        values (v_id, encode(sha256(convert_to(v_login || ':test1234', 'UTF8')), 'hex'));
      created := created + 1;
    end if;
  end loop;

  return created;
end;
$$;

-- Дополнительный сид иерархии (идемпотентен): командиры взводов, начальники
-- курсов и преподаватели. Их роль admin, уровень прав — по должности. Созданы
-- только если в базе ещё нет ни одного профиля с такими должностями.
do $$
declare
  v_id uuid;
  v_created integer := 0;
  v_squad text;
  v_course integer;
begin
  if exists (select 1 from public.profiles pr where pr.position = 'командир взвода') then
    return;
  end if;

  -- Командиры взводов: по одному на взвод (взводы 1..10)
  for v_squad in 1..10 loop
    v_id := gen_random_uuid();
    insert into public.profiles (id, login, full_name, group_name, role, military_rank, position, role_level)
      values (v_id, 'kvr' || lpad(v_squad::text, 2, '0'),
              'Командир Взвода ' || v_squad || ' (оперативный сост.)',
              v_squad || ' взвод', 'admin', 'лейтенант', 'командир взвода', 5)
      on conflict (login) do nothing;
    v_created := v_created + 1;
  end loop;

  -- Начальники курсов 1..2 (взводы 1..5 → курс 1, 6..10 → курс 2)
  for v_course in 1..2 loop
    v_id := gen_random_uuid();
    insert into public.profiles (id, login, full_name, group_name, role, military_rank, position, role_level)
      values (v_id, 'nach' || v_course || 'kurs',
              'Начальник ' || v_course || ' курса (оперативный сост.)',
              '0' || v_course || ' курс', 'admin', 'капитан', 'начальник курса ' || v_course, 6)
      on conflict (login) do nothing;
    v_created := v_created + 1;
  end loop;

  -- Преподаватели: двое (доцент кафедры и преподаватель) с уровнем 4
  for i in 1..2 loop
    v_id := gen_random_uuid();
    insert into public.profiles (id, login, full_name, group_name, role, military_rank, position, role_level)
      values (v_id, 'prepod' || lpad(i::text, 2, '0'),
              'Преподаватель ' || i || ' (оперативный сост.)',
              'ППС', 'admin', 'майор', case when i = 1 then 'доцент кафедры' else 'преподаватель' end, 4)
      on conflict (login) do nothing;
    v_created := v_created + 1;
  end loop;
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
alter table public.chat_archive enable row level security;
alter table public.contacts enable row level security;

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

-- chat_archive: каждый управляет только своим архивом.
drop policy if exists chat_archive_all on public.chat_archive;
create policy chat_archive_all on public.chat_archive for all
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

-- contacts: каждый управляет только своими контактами.
drop policy if exists contacts_all on public.contacts;
create policy contacts_all on public.contacts for all
  using (owner_id = public.current_user_id())
  with check (owner_id = public.current_user_id());

-- departments / positions: данные структуры видны всем аутентифицированным.
drop policy if exists departments_all on public.departments;
create policy departments_all on public.departments for select
  using (true);

drop policy if exists positions_all on public.positions;
create policy positions_all on public.positions for select
  using (true);

-- audit_log: читает только админ, запись через RPC log_audit (security definer).
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select
  using (public.current_user_is_admin());

drop policy if exists audit_log_insert on public.audit_log;
create policy audit_log_insert on public.audit_log for insert
  with check (public.current_user_id() is not null);

-- app_settings: читают все, меняет только админ.
drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings for select
  using (true);

drop policy if exists app_settings_write on public.app_settings;
create policy app_settings_write on public.app_settings for all
  using (public.current_user_is_admin())
  with check (public.current_user_is_admin());

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

-- 8. Storage для зашифрованных медиа -------------------------------------------
-- Файл шифруется на клиенте (AES-GCM), поэтому содержимое бакета безвредно.
-- Если бакет недоступен, приложение автоматически хранит медиа в таблице media,
-- так что этот блок можно пропустить — просто будет тяжелее база.

insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

drop policy if exists svyaz_media_read on storage.objects;
create policy svyaz_media_read on storage.objects for select
  using (bucket_id = 'media');

drop policy if exists svyaz_media_insert on storage.objects;
create policy svyaz_media_insert on storage.objects for insert
  with check (bucket_id = 'media');

drop policy if exists svyaz_media_update on storage.objects;
create policy svyaz_media_update on storage.objects for update
  using (bucket_id = 'media');

