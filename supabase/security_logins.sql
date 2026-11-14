-- Блокировка и журнал входов.
-- Выполнить в Supabase SQL Editor после schema.sql.

alter table public.profiles add column if not exists failed_attempts int not null default 0;
alter table public.profiles add column if not exists blocked boolean not null default false;
alter table public.profiles add column if not exists block_reason text;
alter table public.profiles add column if not exists last_ip text;
alter table public.profiles add column if not exists last_device text;
alter table public.profiles add column if not exists last_geo text;
alter table public.profiles add column if not exists last_lat double precision;
alter table public.profiles add column if not exists last_lng double precision;
alter table public.profiles add column if not exists last_login_at bigint;

create table if not exists public.login_events (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  login text not null,
  success boolean not null default false,
  reason text,
  ip text,
  device text,
  geo text,
  lat double precision,
  lng double precision,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);
create index if not exists login_events_created_idx on public.login_events (created_at desc);
create index if not exists login_events_user_idx on public.login_events (user_id);

alter table public.login_events enable row level security;

drop policy if exists login_events_admin_select on public.login_events;
create policy login_events_admin_select on public.login_events for select using (
  exists (select 1 from public.profiles p where p.id = current_user_id() and p.role = 'admin')
);

grant select on public.login_events to authenticated;

-- Серверный учёт попыток: клиент не может сам сбросить счётчик.
create or replace function public.record_login_attempt(
  p_login text,
  p_success boolean,
  p_ip text default null,
  p_device text default null,
  p_geo text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_block_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_profile profiles%rowtype;
  v_attempts int;
  v_blocked boolean;
begin
  select * into v_profile from profiles where lower(login) = lower(p_login) limit 1;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  if p_success then
    update profiles set
      failed_attempts = 0,
      last_ip = coalesce(p_ip, last_ip),
      last_device = coalesce(p_device, last_device),
      last_geo = coalesce(p_geo, last_geo),
      last_lat = coalesce(p_lat, last_lat),
      last_lng = coalesce(p_lng, last_lng),
      last_login_at = (extract(epoch from now()) * 1000)::bigint
    where id = v_profile.id
    returning failed_attempts, blocked into v_attempts, v_blocked;
  else
    v_attempts := coalesce(v_profile.failed_attempts, 0) + 1;
    v_blocked := v_profile.blocked or v_attempts >= 3;
    update profiles set
      failed_attempts = v_attempts,
      blocked = v_blocked,
      block_reason = case when v_blocked and not v_profile.blocked then '3 неверных попытки входа' else block_reason end
    where id = v_profile.id;
  end if;

  insert into login_events (user_id, login, success, reason, ip, device, geo, lat, lng)
  values (v_profile.id, v_profile.login, p_success,
          case when p_success then null else coalesce(p_block_reason, 'Неверный пароль') end,
          p_ip, p_device, p_geo, p_lat, p_lng);

  return jsonb_build_object(
    'found', true,
    'blocked', v_blocked,
    'attempts', v_attempts,
    'reason', case when v_blocked then coalesce(v_profile.block_reason, 'Аккаунт заблокирован') else null end
  );
end $$;

grant execute on function public.record_login_attempt(text, boolean, text, text, text, double precision, double precision, text) to anon, authenticated;

-- Разблокировка/блокировка администратором.
create or replace function public.set_user_blocked(p_user uuid, p_blocked boolean, p_reason text default null)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where id = current_user_id() and role = 'admin') then
    raise exception 'Нет прав';
  end if;
  update profiles set
    blocked = p_blocked,
    failed_attempts = case when p_blocked then failed_attempts else 0 end,
    block_reason = case when p_blocked then coalesce(p_reason, 'Заблокирован администратором') else null end
  where id = p_user;
  insert into audit_log (actor_id, actor_name, action, target_type, target_id, details, created_at)
  select current_user_id(), p.full_name,
         case when p_blocked then 'block_user' else 'unblock_user' end,
         'profile', p_user::text, coalesce(p_reason, ''), (extract(epoch from now()) * 1000)::bigint
  from profiles p where p.id = current_user_id();
  return true;
end $$;

grant execute on function public.set_user_blocked(uuid, boolean, text) to authenticated;
