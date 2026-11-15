-- Этап 17: режимы присутствия и скрытие «онлайн».
-- Идемпотентно: можно запускать повторно на существующей таблице presence.

alter table public.presence add column if not exists mode text not null default 'online';
alter table public.presence add column if not exists hide_online boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'presence_mode_check'
  ) then
    alter table public.presence
      add constraint presence_mode_check check (mode in ('online', 'away', 'dnd'));
  end if;
end $$;

grant select, insert, update on public.presence to authenticated;
