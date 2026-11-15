-- История звонков: кто звонил, когда, чем закончилось и сколько длилось.
--
-- Выполнить в Supabase SQL Editor после schema.sql. Файл идемпотентен:
-- повторный запуск ничего не ломает.
--
-- Запись создаёт только инициатор звонка (caller_id = текущий пользователь),
-- поэтому одной записи достаточно на оба устройства. Политика чтения
-- показывает её обоим участникам.

create table if not exists public.call_history (
  id uuid primary key,
  chat_id uuid not null references public.chats(id) on delete cascade,
  caller_id uuid not null references public.profiles(id) on delete cascade,
  callee_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null default 'audio'
    check (mode in ('audio', 'video')),
  status text not null default 'missed'
    check (status in ('answered', 'declined', 'missed', 'offline', 'failed')),
  started_at bigint not null,
  duration integer not null default 0 check (duration >= 0),
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create index if not exists call_history_chat_idx
  on public.call_history (chat_id, started_at desc);

alter table public.call_history enable row level security;

drop policy if exists call_history_select on public.call_history;
create policy call_history_select on public.call_history for select
  using (
    caller_id = public.current_user_id()
    or callee_id = public.current_user_id()
  );

drop policy if exists call_history_insert on public.call_history;
create policy call_history_insert on public.call_history for insert
  with check (caller_id = public.current_user_id());

grant select, insert on public.call_history to anon, authenticated;
