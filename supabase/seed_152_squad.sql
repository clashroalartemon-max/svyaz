-- ============================================================
-- 152 взвод: реальный состав с иерархией, званиями и должностями.
--
-- Скрипт идемпотентен:
--   • если человек с таким ФИО уже есть — обновляем звание, должность,
--     уровень прав, взвод, подразделение, телефон и пароль;
--   • если нет — создаём профиль и выдаём свободный логин cadetNNN.
-- Пароль для всех — test1234 (SHA-256 от «логин:пароль»).
-- При следующем входе приватный ключ создастся заново под новый пароль.
-- ============================================================

-- Чистка дублей из прошлых запусков: «ё» могла прийти в двух юникод-формах
-- («Артём» и «Артëм»), из-за чего создавалась вторая копия. Удаляем более
-- позднюю копию, только если у неё нет ни сообщений, ни чатов.
delete from public.profiles p
using public.profiles p2
where p2.id <> p.id
  and p2.group_name = p.group_name
  and lower(translate(trim(p2.full_name), 'ë', 'ё'))
      = lower(translate(trim(p.full_name), 'ë', 'ё'))
  and p2.created_at < p.created_at
  and not exists (select 1 from public.messages m where m.sender_id = p.id)
  and not exists (select 1 from public.chat_participants cp where cp.user_id = p.id)
  and not exists (select 1 from public.chats c where c.owner_id = p.id);

do $$
declare
  rec record;
  v_login text;
  v_id uuid;
  v_n integer;
  v_hash text;
  v_dept text := 'Факультет подготовки сотрудников для оперативных подразделений полиции';
  v_group text := '152 взвод';
begin
  for rec in
    select *
    from (values
      -- начальник курса
      ('Куликов Алексей Анатольевич',      'подполковник полиции',     'начальник курса',              8, '8-968-028-10-57'),
      -- заместитель командира взвода
      ('Паневкин Егор Павлович',           'младший сержант полиции',  'заместитель командира взвода', 4, '8-910-565-69-53'),
      -- командиры отделения
      ('Богодаев Богдан Валерьевич',       'младший сержант полиции',  'командир отделения',           3, '8-960-573-15-46'),
      ('Грушин Арсений Витальевич',        'младший сержант полиции',  'командир отделения',           3, '8-989-098-02-98'),
      ('Рвачев Станислав Владимирович',    'младший сержант полиции',  'командир отделения',           3, '8-910-485-66-72'),
      -- курсанты
      ('Майоров Вячеслав Сергеевич',       'рядовой полиции',          'курсант',                      1, null),
      ('Такиев Диас Эльманович',           'рядовой полиции',          'курсант',                      1, null),
      ('Касьян Богдан Анатольевич',        'рядовой полиции',          'курсант',                      1, null),
      ('Новов Денис Денисович',            'рядовой полиции',          'курсант',                      1, null),
      ('Власов Вадим Олегович',            'рядовой полиции',          'курсант',                      1, null),
      ('Колышевский Николай Николаевич',   'рядовой полиции',          'курсант',                      1, null),
      ('Зеленцов Денис Витальевич',        'рядовой полиции',          'курсант',                      1, null),
      ('Копытенков Данила Андреевич',      'рядовой полиции',          'курсант',                      1, null),
      ('Коновалов Владимир Игоревич',      'рядовой полиции',          'курсант',                      1, null),
      ('Пашковский Александр Олегович',    'рядовой полиции',          'курсант',                      1, null),
      ('Евсеев Данила Александрович',      'рядовой полиции',          'курсант',                      1, null),
      ('Денисов Даниил Георгиевич',        'рядовой полиции',          'курсант',                      1, null),
      ('Дианов Дмитрий Игоревич',          'рядовой полиции',          'курсант',                      1, null),
      ('Александров Святослав Сергеевич',  'рядовой полиции',          'курсант',                      1, null),
      ('Василевский Григорий Дмитриевич',  'рядовой полиции',          'курсант',                      1, null),
      ('Ерохов Леонид Ильич',              'рядовой полиции',          'курсант',                      1, null),
      ('Рюрников Николай Олегович',        'рядовой полиции',          'курсант',                      1, null),
      ('Новиков Егор Дмитриевич',          'рядовой полиции',          'курсант',                      1, null),
      ('Васин Михаил Алексеевич',          'рядовой полиции',          'курсант',                      1, null),
      ('Сабитова Виолетта Михайловна',     'рядовой полиции',          'курсант',                      1, null),
      ('Виляев Артём Дмитриевич',          'рядовой полиции',          'курсант',                      1, null),
      ('Грачёв Владимир Владимирович',     'рядовой полиции',          'курсант',                      1, null),
      ('Жукова Елизавета Михайловна',      'рядовой полиции',          'курсант',                      1, null),
      ('Никифоров Степан Ильич',           'рядовой полиции',          'курсант',                      1, null)
    ) as t(full_name, rank_name, position_name, lvl, phone)
  loop
    -- 1) Ищем существующий профиль по ФИО (без учёта регистра).
    select p.id, p.login into v_id, v_login
      from public.profiles p
     where lower(translate(trim(p.full_name), 'ë', 'ё'))
           = lower(translate(trim(rec.full_name), 'ë', 'ё'))
     limit 1;

    if v_id is null then
      -- 2) Свободный логин cadetNNN.
      v_n := 1;
      loop
        v_login := 'cadet' || lpad(v_n::text, 3, '0');
        exit when not exists (select 1 from public.profiles where login = v_login);
        v_n := v_n + 1;
        if v_n > 999 then
          raise exception 'Не удалось подобрать свободный логин';
        end if;
      end loop;

      v_id := gen_random_uuid();
      insert into public.profiles
        (id, login, full_name, group_name, role, military_rank, position, role_level, department, phone)
      values
        (v_id, v_login, rec.full_name, v_group, 'cadet', rec.rank_name, rec.position_name,
         rec.lvl, v_dept, rec.phone);
    else
      update public.profiles
         set group_name = v_group,
             role = 'cadet',
             military_rank = rec.rank_name,
             position = rec.position_name,
             role_level = rec.lvl,
             department = v_dept,
             phone = rec.phone,
             -- старый ключ зашифрован прежним паролем — сбрасываем,
             -- чтобы он пересоздался при входе с новым паролем
             encrypted_private_key = null
       where id = v_id;
    end if;

    -- 3) Пароль test1234 для всех.
    v_hash := encode(sha256(convert_to(v_login || ':test1234', 'UTF8')), 'hex');
    insert into public.credentials (profile_id, password_hash)
      values (v_id, v_hash)
      on conflict (profile_id) do update set password_hash = excluded.password_hash;
  end loop;

  raise notice 'Состав 152 взвода загружен';
end $$;
