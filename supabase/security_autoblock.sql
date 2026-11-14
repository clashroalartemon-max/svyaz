-- Автоблокировка подозрительных входов и уведомление в админ-журнал.
-- Выполнить после security_logins.sql.

drop function if exists public.record_login_attempt(text, boolean, text, text, text, double precision, double precision, text);

create or replace function public.record_login_attempt(
  p_login text,
  p_success boolean,
  p_ip text default null,
  p_device text default null,
  p_geo text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_block_reason text default null,
  p_force_block boolean default false
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
    v_blocked := v_profile.blocked or v_attempts >= 3 or p_force_block;
    update profiles set
      failed_attempts = v_attempts,
      blocked = v_blocked,
      block_reason = case when v_blocked and not v_profile.blocked
        then coalesce(p_block_reason, '3 неверных попытки входа') else block_reason end
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
    'reason', case when v_blocked then coalesce(v_profile.block_reason, p_block_reason) else null end
  );
end $$;

grant execute on function public.record_login_attempt(text, boolean, text, text, text, double precision, double precision, text, boolean) to anon, authenticated;

-- Уведомление админу: подозрительный вход попадает в общий журнал действий.
create or replace function public.log_security_alert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.success = false and (
    new.reason like 'Подозрительный%' or new.reason like '%блокирован%'
  ) then
    insert into audit_log (actor_id, actor_name, action, target_type, target_id, details, created_at)
    values (new.user_id, new.login, 'security_alert', 'profile', new.user_id::text,
            coalesce(new.reason, '') || coalesce(' · IP ' || new.ip, '') || coalesce(' · ' || new.geo, ''),
            new.created_at);
  end if;
  return new;
end $$;

drop trigger if exists login_events_security_alert on public.login_events;
create trigger login_events_security_alert
after insert on public.login_events
for each row execute function public.log_security_alert();
