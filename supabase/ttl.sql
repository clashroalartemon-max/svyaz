-- Исчезающие сообщения: таймер жизни сообщений на чат.
--
-- Выполнить в Supabase SQL Editor после schema.sql. Файл идемпотентен:
-- повторный запуск ничего не ломает и не задваивает.
--
-- ttl_seconds = null  — таймера нет (обычный чат);
-- ttl_seconds = 3600  — сообщения исчезают через час;
-- ttl_seconds = 86400 — через день;
-- ttl_seconds = 604800 — через неделю.
--
-- Старое поведение секретных чатов (24 часа) сохраняется: если ttl_seconds
-- не задан, а chats.secret = true, действует ровно 86400 секунд.

alter table public.chats
  add column if not exists ttl_seconds integer;

-- Ограничение на разумный диапазон: от минуты до 30 дней.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chats_ttl_seconds_check'
      and conrelid = 'public.chats'::regclass
  ) then
    alter table public.chats
      add constraint chats_ttl_seconds_check
      check (ttl_seconds is null or (ttl_seconds >= 60 and ttl_seconds <= 2592000));
  end if;
end $$;

-- Автоудаление: раньше удаляло только сообщения секретных чатов старше суток.
-- Теперь учитывает ttl_seconds каждого чата. Имя функции не меняем — на него
-- уже могут быть завязаны cron-задачи.
create or replace function public.cleanup_secret_chats() returns integer
language sql security definer set search_path = public as $$
  with del as (
    delete from public.messages m
    using public.chats c
    where m.chat_id = c.id
      and (
        (c.ttl_seconds is not null
          and m.created_at < (extract(epoch from now()) * 1000 - c.ttl_seconds * 1000))
        or
        (c.ttl_seconds is null
          and c.secret = true
          and m.created_at < (extract(epoch from now()) * 1000 - 24 * 60 * 60 * 1000))
      )
    returning m.id
  )
  select count(*)::integer from del;
$$;

grant execute on function public.cleanup_secret_chats() to anon, authenticated;

-- Чтобы сообщения исчезали на сервере, а не только скрывались на клиенте,
-- функцию нужно вызывать по расписанию (например, каждые 10 минут):
--
--   create extension if not exists pg_cron;
--   select cron.schedule('cleanup-ttl', '*/10 * * * *',
--                        $$select public.cleanup_secret_chats()$$);
--
-- Без pg_cron вызов можно повесить на внешний планировщик:
--   select public.cleanup_secret_chats();
