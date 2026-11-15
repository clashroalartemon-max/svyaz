-- Этап 23: двухфакторная аутентификация (TOTP, RFC 6238).
--
-- Секрет лежит в отдельной таблице user_totp без RLS-политик: клиент не может
-- прочитать его напрямую, только через SECURITY DEFINER-функции.
-- Проверка кода выполняется на сервере при входе: verify_login_totp.
--
-- Требуется pgcrypto (hmac, gen_random_bytes). На Supabase он обычно уже
-- установлен в схеме extensions — поэтому search_path = public, extensions.

create extension if not exists pgcrypto;

create table if not exists public.user_totp (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  secret text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.user_totp enable row level security;

-- Намеренно нет политик: прямой доступ запрещён, только через функции ниже.
revoke all on public.user_totp from anon, authenticated;

create or replace function public.base32_encode(p_bytes bytea)
returns text
language plpgsql immutable set search_path = public, extensions as $$
declare
  v_alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  v_bits text := '';
  v_out text := '';
  v_byte int;
  v_val int;
  i int;
begin
  for i in 0..length(p_bytes) - 1 loop
    v_byte := get_byte(p_bytes, i);
    v_bits := v_bits || (v_byte::bit(8))::text;
  end loop;
  while length(v_bits) % 5 <> 0 loop
    v_bits := v_bits || '0';
  end loop;
  for i in 1..(length(v_bits) / 5) loop
    v_val := (substr(v_bits, (i - 1) * 5 + 1, 5)::bit(5))::int;
    v_out := v_out || substr(v_alphabet, v_val + 1, 1);
  end loop;
  return v_out;
end;
$$;

create or replace function public.base32_decode(p_text text)
returns bytea
language plpgsql immutable set search_path = public, extensions as $$
declare
  v_alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  v_clean text := replace(replace(upper(trim(p_text)), ' ', ''), '=', '');
  v_bits text := '';
  v_idx int;
  v_out bytea := ''::bytea;
  i int;
begin
  if v_clean = '' then
    raise exception 'empty base32';
  end if;
  for i in 1..length(v_clean) loop
    v_idx := strpos(v_alphabet, substr(v_clean, i, 1)) - 1;
    if v_idx < 0 then
      raise exception 'invalid base32';
    end if;
    v_bits := v_bits || (v_idx::bit(5))::text;
  end loop;
  for i in 1..(length(v_bits) / 8) loop
    v_out := v_out || decode(
      lpad(to_hex((substr(v_bits, (i - 1) * 8 + 1, 8)::bit(8))::int), 2, '0'),
      'hex'
    );
  end loop;
  return v_out;
end;
$$;

revoke all on function public.base32_encode(bytea) from public, anon, authenticated;
revoke all on function public.base32_decode(text) from public, anon, authenticated;

create or replace function public.totp_code_at(p_secret text, p_step bigint)
returns text
language plpgsql immutable set search_path = public, extensions as $$
declare
  v_key bytea := public.base32_decode(p_secret);
  v_counter bytea := decode(lpad(to_hex(p_step), 16, '0'), 'hex');
  v_digest bytea := hmac(v_counter, v_key, 'sha1');
  v_offset int := get_byte(v_digest, 19) & 15;
  v_bin bigint;
begin
  v_bin := ((get_byte(v_digest, v_offset) & 127)::bigint << 24)
        | (get_byte(v_digest, v_offset + 1)::bigint << 16)
        | (get_byte(v_digest, v_offset + 2)::bigint << 8)
        | get_byte(v_digest, v_offset + 3)::bigint;
  return lpad((v_bin % 1000000)::text, 6, '0');
end;
$$;

revoke all on function public.totp_code_at(text, bigint) from public, anon, authenticated;

-- Проверка кода для конкретного пользователя, независимо от enabled.
create or replace function public.totp_check(p_user uuid, p_code text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_secret text;
  v_step bigint := floor(extract(epoch from now()) / 30)::bigint;
begin
  select secret into v_secret from public.user_totp where user_id = p_user;
  if v_secret is null then
    return false;
  end if;
  if p_code is null or trim(p_code) !~ '^[0-9]{6}$' then
    return false;
  end if;
  return trim(p_code) in (
    public.totp_code_at(v_secret, v_step - 1),
    public.totp_code_at(v_secret, v_step),
    public.totp_code_at(v_secret, v_step + 1)
  );
end;
$$;

revoke all on function public.totp_check(uuid, text) from public, anon, authenticated;

-- Начать настройку: выдать новый секрет (старый сбрасывается, 2FA выключается).
create or replace function public.totp_begin()
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user uuid := public.current_user_id();
  v_secret text;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;
  v_secret := public.base32_encode(gen_random_bytes(20));
  insert into public.user_totp (user_id, secret, enabled)
  values (v_user, v_secret, false)
  on conflict (user_id) do update
    set secret = excluded.secret, enabled = false, created_at = now();
  return v_secret;
end;
$$;

-- Подтвердить кодом и включить.
create or replace function public.totp_enable(p_code text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user uuid := public.current_user_id();
begin
  if v_user is null then
    return false;
  end if;
  if not public.totp_check(v_user, p_code) then
    return false;
  end if;
  update public.user_totp set enabled = true where user_id = v_user;
  return found;
end;
$$;

-- Выключить, подтвердив действующим кодом.
create or replace function public.totp_disable(p_code text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user uuid := public.current_user_id();
begin
  if v_user is null or not public.totp_check(v_user, p_code) then
    return false;
  end if;
  delete from public.user_totp where user_id = v_user;
  return true;
end;
$$;

create or replace function public.totp_status()
returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(
    (select enabled from public.user_totp where user_id = public.current_user_id()),
    false
  );
$$;

grant execute on function public.totp_begin() to authenticated;
grant execute on function public.totp_enable(text) to authenticated;
grant execute on function public.totp_disable(text) to authenticated;
grant execute on function public.totp_status() to authenticated;

-- Вход: как verify_login, но при включённой 2FA требует верный код.
-- Если код не передан или неверен — исключение totp_required, профиль не отдаётся.
create or replace function public.verify_login_totp(
  p_login text,
  p_hash text,
  p_code text default null
)
returns setof public.profiles
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id uuid;
  v_enabled boolean;
begin
  select p.id into v_id
    from public.profiles p
    join public.credentials c on c.profile_id = p.id
   where p.login = lower(trim(p_login))
     and lower(trim(c.password_hash)) = lower(trim(p_hash))
   limit 1;

  if v_id is null then
    return;
  end if;

  select enabled into v_enabled from public.user_totp where user_id = v_id;
  if coalesce(v_enabled, false) and not public.totp_check(v_id, p_code) then
    raise exception 'totp_required';
  end if;

  return query select * from public.profiles where id = v_id;
end;
$$;

grant execute on function public.verify_login_totp(text, text, text) to anon, authenticated;
