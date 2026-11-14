-- ============================================================
-- Симуляция нагрузки: 100 пользователей, чаты и сообщения.
--
-- Запуск: Supabase → SQL Editor:
--   select * from public.simulate_load(100, 20);
-- Ожидаемый результат: users = 100, chats ≈ 104, messages ≈ 2000+.
-- Повторный запуск сначала очищает предыдущие тестовые данные.
--
-- ВАЖНО: это только база. Полноценный клиентский E2EE-тест описан
-- в TESTING.md (сценарий «100 сообщений»).
-- ============================================================

create or replace function public.cleanup_load_test()
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.chats
   where title like '%нагрузка%' or title like 'Нагрузочная группа%';
  delete from public.profiles where login like 'loadtest_%';
end;
$$;

create or replace function public.simulate_load(
  p_users integer default 100,
  p_messages integer default 20
)
returns table(users integer, chats integer, messages integer)
language plpgsql security definer set search_path = public as $$
declare
  v_users integer := greatest(1, least(500, coalesce(p_users, 100)));
  v_msgs integer := greatest(1, least(100, coalesce(p_messages, 20)));
  v_start bigint := (extract(epoch from now()) * 1000)::bigint;
  i integer;
  j integer;
  v_id uuid;
  v_chat uuid;
  v_login text;
  v_group text;
  v_hash text;
begin
  perform public.cleanup_load_test();

  -- 1. 100 профилей с разными взводами, должностями и званиями.
  for i in 1..v_users loop
    v_login := 'loadtest_' || lpad(i::text, 3, '0');
    v_group := (((i - 1) / 25) + 1)::text || ' взвод';
    v_id := gen_random_uuid();
    insert into public.profiles
      (id, login, full_name, group_name, role, military_rank, position, role_level, created_at)
    values
      (v_id, v_login, 'Нагрузка ' || i, v_group, 'cadet',
       case when i % 5 = 0 then 'младший сержант' else 'рядовой' end,
       case when i % 5 = 0 then 'командир отделения' else 'курсант' end,
       case when i % 5 = 0 then 3 else 1 end,
       v_start);

    v_hash := encode(sha256(convert_to(v_login || ':test1234', 'UTF8')), 'hex');
    insert into public.credentials (profile_id, password_hash)
      values (v_id, v_hash)
      on conflict (profile_id) do update set password_hash = excluded.password_hash;
  end loop;

  -- 2. Чаты взводов: все курсанты взвода + первые сообщения.
  for i in 1..4 loop
    v_chat := gen_random_uuid();
    insert into public.chats (id, created_at, saved, owner_id, secret, kind, title, target)
    values (v_chat, v_start, false, null, false, 'squad',
            i || ' взвод (нагрузка)', i::text);
    insert into public.chat_participants (chat_id, user_id)
      select v_chat, p.id from public.profiles p
       where p.login like 'loadtest_%' and p.group_name = i || ' взвод';

    insert into public.messages (id, chat_id, sender_id, ciphertext, iv, status, created_at)
      select gen_random_uuid(), v_chat, cp.user_id, 'loadtest', 'loadtest', 'sent',
             v_start + row_number() over ()
        from public.chat_participants cp
       where cp.chat_id = v_chat;
  end loop;

  -- 3. Групповые чаты по 2 участника и по p_messages сообщений на каждого.
  for i in 1..v_users loop
    v_login := 'loadtest_' || lpad(i::text, 3, '0');
    select id into v_id from public.profiles where login = v_login;
    v_chat := gen_random_uuid();

    insert into public.chats (id, created_at, saved, owner_id, secret, kind, title, target)
    values (v_chat, v_start, false, v_id, false, 'group',
            'Нагрузочная группа ' || i, null);

    insert into public.chat_participants (chat_id, user_id)
      values (v_chat, v_id), (
        v_chat,
        (select id from public.profiles
          where login = 'loadtest_' || lpad((((i) % v_users) + 1)::text, 3, '0'))
      )
    on conflict do nothing;

    for j in 1..v_msgs loop
      insert into public.messages
        (id, chat_id, sender_id, ciphertext, iv, status, created_at)
      values
        (gen_random_uuid(), v_chat, v_id, 'loadtest', 'loadtest', 'sent', v_start + j);
    end loop;
  end loop;

  return query
    select
      (select count(*)::integer from public.profiles where login like 'loadtest_%'),
      (select count(*)::integer from public.chats
        where title like '%нагрузка%' or title like 'Нагрузочная группа%'),
      (select count(*)::integer from public.messages where ciphertext = 'loadtest');
end;
$$;

grant execute on function public.simulate_load(integer, integer) to anon, authenticated;
grant execute on function public.cleanup_load_test() to anon, authenticated;

-- Проверка целостности после симуляции:
--   • нет дублей участников (PRIMARY KEY сам это гарантирует);
--   • нет сообщений без чата (FK);
--   • количество сообщений сходится.
select count(*) as duplicate_participants from (
  select chat_id, user_id from public.chat_participants
   group by chat_id, user_id having count(*) > 1
) d;
