-- ============================================================
-- Проверка каскадов при удалении пользователя.
--
-- Запуск: Supabase → SQL Editor → вставить целиком → Run.
-- Скрипт работает в транзакции и заканчивается ROLLBACK: данные не остаются.
-- Ожидаемые значения:
--   messages_left = 0, participants_left = 0,
--   chat_still_exists = 1, chat_owner_is_null = 1.
-- ============================================================

begin;

-- 1. Какие действия заданы для внешних ключей на profiles.
select
  conrelid::regclass as table_name,
  conname,
  case confdeltype
    when 'c' then 'CASCADE'
    when 'n' then 'SET NULL'
    when 'r' then 'RESTRICT'
    when 'a' then 'NO ACTION'
    when 'd' then 'SET DEFAULT'
  end as on_delete
from pg_constraint
where confrelid = 'public.profiles'::regclass
  and contype = 'f'
order by 1;

-- 2. Живой тест: пользователь, чат, участие и сообщение.
insert into public.profiles (id, login, full_name, group_name, role, role_level, created_at)
values ('00000000-0000-4000-8000-000000000001', 'cascade_probe', 'Каскад Тест', 'Проверка', 'cadet', 1, 0);

insert into public.chats (id, created_at, saved, owner_id, kind, title)
values ('00000000-0000-4000-8000-000000000002', 0, false, '00000000-0000-4000-8000-000000000001', 'group', 'Каскад');

insert into public.chat_participants (chat_id, user_id)
values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001');

insert into public.messages (id, chat_id, sender_id, ciphertext, iv, status, created_at)
values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'x', 'y', 'sent', 0);

delete from public.profiles where id = '00000000-0000-4000-8000-000000000001';

select 'messages_left' as check_name,
       count(*)::text as value
  from public.messages
 where sender_id = '00000000-0000-4000-8000-000000000001'
union all
select 'participants_left', count(*)::text
  from public.chat_participants
 where user_id = '00000000-0000-4000-8000-000000000001'
union all
select 'chat_still_exists', count(*)::text
  from public.chats
 where id = '00000000-0000-4000-8000-000000000002'
union all
select 'chat_owner_is_null', count(*)::text
  from public.chats
 where id = '00000000-0000-4000-8000-000000000002'
   and owner_id is null;

rollback;
