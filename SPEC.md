# SPEC — «Связь»: закрытый мессенджер (SPA + Supabase)

## Цель
Рабочий прототип закрытого мессенджера для закрытой группы (курсанты + админ).
Общая база — Supabase (PostgreSQL): пользователи, чаты, сообщения и друзья
синхронизируются между устройствами. Приватные ключи E2EE остаются только
в браузере, в базу попадает лишь шифротекст.

## Стек (зафиксирован, не менять без согласования)
- Vite + React 18 + TypeScript + TailwindCSS (v3, `npx tailwindcss init -p`)
- Шрифт Inter через @fontsource/inter (без CDN)
- React Router DOM v6
- @supabase/supabase-js (клиент БД и Realtime)
- Допустимые зависимости: react, react-dom, react-router-dom, @fontsource/inter,
  @supabase/supabase-js, tailwindcss, clsx, lucide-react
  (+dev: vite, @vitejs/plugin-react, typescript, @types/react, @types/react-dom,
  postcss, autoprefixer)
- ЗАПРЕЩЕНО: тяжёлые UI-библиотеки, эмодзи в UI, WebRTC-звонки,
  `service_role`-ключ во фронтенде.

## Дизайн-система (строгая, служебная)
- Без градиентов/теней/эмодзи; радиус ≤8px; границы 1px; акцент #3B5BDB (только активное)
- CSS-переменные на <html data-theme="light|dark">:
  светлая: bg #FFFFFF, surface #F7F7F8, border #E5E7EB, text #111827,
    text-muted #6B7280, accent #3B5BDB, danger #DC2626, own-msg #EEF2FF, other-msg #F3F4F6
  тёмная: bg #0F1115, surface #161A21, border #262B35, text #E5E7EB,
    text-muted #9099A8, accent #5B7BE8, danger #EF4444, own-msg #1E2A4A, other-msg #1C2028
- Типографика: 13px подписи, 15px основной, 17px заголовки, 22px крупные
- UI-кит в /src/ui/: Button (primary/secondary/ghost/danger), Input (label+error),
  Avatar (sm/md/lg, инициалы), Badge (непрочитанные), ThemeToggle

## Данные (Supabase)
Таблицы: `profiles`, `credentials`, `chats`, `chat_participants`, `messages`,
`media`, `friendships`, `read_state`, `presence` (см. `supabase/schema.sql`).
- User { id, login, fullName, group, role, publicKeyJwk, createdAt }
  (пароль — в отдельной `credentials`, снаружи не читается)
- Message { id, chatId, senderId, type: text|voice|photo|video|circle,
  ciphertext, iv, wrappedKey(+iv), wrappedSelfKey(+iv), mimeType?, duration?,
  status, editedAt?, deleted?, createdAt }
- Весь доступ ТОЛЬКО через `src/lib/db.ts` (async-функции).
- RLS: пользователь видит только свои чаты и сообщения; вход/смена пароля —
  через SECURITY DEFINER-функции `verify_login` / `change_password`.
- Сессия — `localStorage` (`svyaz.currentUserId`), приватные ключи — там же
  (`svyaz.keys.<userId>`), тема — `svyaz.theme`.

## Seed (src/lib/seed.ts + supabase/schema.sql)
- При первом запуске, если профилей меньше 201, клиент вызывает серверную
  функцию `seed_svyaz_users()`.
- Она создаёт админа admin/admin12345 («Администратор Системы», группа 000) и
  200 курсантов cadet001..cadet200 / test1234, русские ФИО, взводы 1..10.
- Идемпотентно: повторный запуск досоздаёт только отсутствующих.
- Логин-экран: серая подсказка с кредами.

## Крипто (src/lib/crypto.ts, Web Crypto)
- ECDH P-256 при создании пользователя; публичный ключ JWK → User.publicKeyJwk;
  приватный JWK → svyaz.keys.<userId> (пометка: в реале IndexedDB+пароль)
- encryptFor(recipientJwk, plaintext) → {ciphertext, iv} (AES-GCM 256, IV 12 байт)
- decryptFrom(senderJwk, ciphertextB64, ivB64) → ArrayBuffer
- Ключи не покидают localStorage; в хранилище только ciphertext.

## Синхронизация (src/lib/realtime.ts)
Supabase Realtime, канал `broadcast`: события `message` (chatId, messageId,
senderId, kind: new|updated) и `typing`. Получатель перечитывает данные обычным
запросом под RLS. BroadcastChannel (`src/lib/bus.ts`) остаётся локальной шиной
между вкладками одного браузера. Polling localStorage убран.

## Экраны
- /login: лого «Связь», «Закрытая система», логин/пароль, ошибка, тестовая подсказка
- /main: слева 340px (шапка: аватар, ФИО, группа, настройки, тема; поиск; список чатов
  с последним сообщением, временем, бейджем; кнопка «+» → /friends); справа чат или
  заглушка «Выберите чат»
- /friends: поиск ТОЛЬКО по точному ФИО + группе; карточка результата с
  «Добавить в друзья» / «Открыть чат»; кнопка «Назад»
- /settings: ФИО, группа (readonly), тема, «Выйти» (danger)
- /chat/:id — мобильная версия чата

## Компонент Chat
- Шапка: аватар, ФИО, группа, «назад» (мобильный)
- Лента: own справа (--own-msg), other слева; время HH:MM; скролл к последнему
- Типы: text; voice — плеер (play/pause, прогресс, длительность); photo — превью 240px,
  тап → fullscreen; video — превью с play, тап → открыть; circle — круглое видео 200px,
  автовоспроизведение после тапа
- Ввод: скрепка (Фото/Видео, Снять фото, Записать кружок), поле текста,
  микрофон (зажать → запись → отпустить → отправить; отмена)
- Voice: MediaRecorder audio/webm; media шифруются и кладутся в таблицу `media`
- Фото/видео: file input accept="image/*,video/*" или getUserMedia
- Кружок: getUserMedia({video: {facingMode:'user'}}), лимит 15с, автозапуск после стопа
- Расшифровка при получении/подписке на bus; ошибка → «[Не удалось расшифровать]» серым

## Навигация и защита
- Нет currentUserId → /login; есть → с /login на /main
- «Выйти»: чистит currentUserId, ключи НЕ удаляет (нужны для истории)

## Адаптив
- ≥900px: двухпанельный; <900px: одна панель (/main — список, /chat/:id — чат)

## Критерии готовности (12 пунктов из ТЗ — см. DEV-JOURNAL.md, чек-лист)

## Решения, принятые агентом
1. Node.js в системе не было (и нет winget) → официальный Node LTS zip распакован
   в `%LOCALAPPDATA%\Programs\nodejs` (портативно, без админа, без системного PATH).
2. Регистрации нет (только seed-креды) — по ТЗ.
3. Дружба auto-accept — по ТЗ.
4. Переход на Supabase: `password_hash` вынесен из `profiles` в `credentials`,
   чтобы RLS не отдавал пароли вместе с публичными профилями. Вход и смена пароля —
   SECURITY DEFINER-функции.
5. Realtime — `broadcast`, а не `postgres_changes`: у второго RLS проверяется под
   anon без заголовка `x-user-id` и события не доходят.
6. Сессия — в `localStorage` (по требованию ТЗ): вход сохраняется после закрытия
   браузера; вкладки синхронизируются через событие `storage`.
7. Seed — серверная функция `seed_svyaz_users()`: 201 запись одним вызовом,
   идемпотентно, одинаковые пароли на всех устройствах.
