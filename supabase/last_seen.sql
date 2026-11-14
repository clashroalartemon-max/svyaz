-- Время последнего визита: колонка приватности.
-- Выполнить в Supabase SQL Editor (проект lkbhkdjfucqulghncasb).
-- Если колонка уже есть — команда безопасна (if not exists).

alter table public.presence
  add column if not exists show_last_seen boolean not null default true;

grant select, insert, update on public.presence to authenticated;
