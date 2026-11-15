-- Безопасный админский сброс: пароль не меняется, пользователь обязан
-- сменить его сам при следующем входе. Приватный ключ при этом перешифруется
-- новым паролем в db.changePassword, история сохраняется.
--
-- Требует PostgreSQL + PostgREST (как в текущей схеме приложения).

alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

-- Админ ставит флаг пользователю. Пароль и ключи не трогаются.
create or replace function public.request_password_change(p_user uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := public.current_user_id();
begin
  if v_admin is null then
    return false;
  end if;
  if not exists (
    select 1 from public.profiles
    where id = v_admin and role = 'admin'
  ) then
    return false;
  end if;
  update public.profiles
     set must_change_password = true
   where id = p_user;
  return found;
end;
$$;

grant execute on function public.request_password_change(uuid) to authenticated;

-- Снять флаг после успешной смены пароля (вызывает сам пользователь).
create or replace function public.clear_password_change_flag()
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := public.current_user_id();
begin
  if v_user is null then
    return false;
  end if;
  update public.profiles
     set must_change_password = false
   where id = v_user;
  return found;
end;
$$;

grant execute on function public.clear_password_change_flag() to authenticated;
