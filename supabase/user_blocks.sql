-- Этап 21: блокировка пользователей и жалобы.
-- Идемпотентно: можно запускать повторно.

create extension if not exists pgcrypto;

create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

alter table public.user_blocks enable row level security;

drop policy if exists user_blocks_own on public.user_blocks;
create policy user_blocks_own on public.user_blocks
  for all
  using (blocker_id = public.current_user_id())
  with check (blocker_id = public.current_user_id());

grant select, insert, delete on public.user_blocks to authenticated;

create table if not exists public.user_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  target_id uuid not null references public.profiles(id) on delete cascade,
  chat_id uuid null,
  reason text not null default 'other',
  created_at timestamptz not null default now()
);

alter table public.user_reports enable row level security;

drop policy if exists user_reports_insert_own on public.user_reports;
create policy user_reports_insert_own on public.user_reports
  for insert
  with check (reporter_id = public.current_user_id());

grant insert on public.user_reports to authenticated;
