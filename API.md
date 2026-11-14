# API `src/lib/db.ts`

Все функции асинхронные, если не указано иное. Ошибки бросаются объектом
`Error` с сообщением Supabase. Типы — в `src/types.ts`.

## Пользователи и профиль

| Функция | Назначение |
|---------|------------|
| `normalizeLogin(login)` | привести логин к нижнему регистру и обрезать |
| `uid()` | UUID v4 (криптостойкий, с резервом) |
| `createUser(input)` | создать профиль + пароль (ключи генерируются на клиенте) |
| `createUsersBatch(inputs, onProgress)` | пакетное создание (seed) |
| `seedUsers()` | наполнить базу тестовыми пользователями |
| `countProfiles()` | число профилей |
| `getAllUsers()` | все профили (публичные поля) |
| `findUserByLogin(login)` | поиск по логину |
| `getUserById(id)` | профиль по id |
| `searchUsers({fullName, group})` | точный поиск по ФИО и взводу |
| `searchUserByUsername(username)` | поиск по нику |
| `verifyLogin(login, password)` | проверка пароля, восстановление ключа |
| `changePassword(userId, current, next)` | смена пароля + перешифровка ключа |
| `ensureUserKeyPair(userId)` | создать/починить пару ключей текущего пользователя |
| `repairAllUserKeys()` | однократная миграция ключей при старте |
| `markKeyMigrationDone()` | отметить версию формата ключей в localStorage |
| `getMyPublicKey(userId)` | публичный ключ |
| `isCurrentUserAdmin(userId)` | проверка роли |
| `setMyUsername(username)` | сохранить ник |
| `updateMyProfile({status,bio})` | статус и «О себе» (нужна схема `profile_social`) |
| `getMyKeyStatus(userId)` | состояние пары ключей |
| `hasMyPrivateKey(userId)` | есть ли приватный ключ на устройстве |
| `encryptForSelf(userId, text)` | зашифровать заметку для себя |
| `exportUserData(userId)` | экспорт данных профиля (без приватного ключа) |

## Чаты

| Функция | Назначение |
|---------|------------|
| `getOrCreateChat(a, b)` | личный чат двух пользователей |
| `createGroupChat(ownerId, title, memberIds)` | групповой чат |
| `addChatParticipants(chatId, userIds)` | добавить участников (права проверяет RLS) |
| `setChatSecret(chatId, secret)` | секретный чат (24 ч) |
| `ensureSavedChat(userId)` | чат «Избранное» |
| `getChatById(id)` | чат по id |
| `ensureAutoChats(userId)` | авточаты взвода/командира/курса/преподавателей |
| `createSquadGroupChat(userId, squad)` | общий чат взвода |
| `getSquadList()` | список взводов |
| `getUserChats(userId)` | список чатов с последним сообщением и непрочитанными |
| `getArchivedChatIds(userId)` | заархивированные чаты |
| `getChatReaders(chatId)` | кто прочитал чат (`last_read_at`) |
| `archiveChat` / `unarchiveChat` | архив |

## Сообщения

| Функция | Назначение |
|---------|------------|
| `getMessages(chatId)` | все сообщения чата |
| `getMessageById(id)` | одно сообщение |
| `saveMessage(msg)` | записать сообщение |
| `saveMessageOptimistic(msg, onError)` | показать сразу + записать/в очередь |
| `flushOfflineQueue()` | дослать офлайн-очередь |
| `getQueuedMessages(chatId?)` | сообщения из локальной очереди |
| `updateMessage(...)` | правка текста автором |
| `setMessageStatus(id, status)` | статус (для автора) |
| `markMessagesDelivered(userId)` | входящие: sent → delivered (RPC) |
| `markChatRead(chatId, userId)` | прочитано + last_read_at (RPC) |
| `softDeleteMessage(msg, userId)` | скрыть у себя (RPC `hide_message`) |
| `deleteMessageForAll(msg, userId)` | удалить у всех (автор, ≤15 мин) |
| `clearChatHistory(chatId, userId)` | скрыть историю только у себя (RPC) |
| `readMessageText(msg, userId)` | расшифровать текст |
| `buildChatTranscript(chatId, userId)` | экспорт истории в текст |

## Медиа и файлы

| Функция | Назначение |
|---------|------------|
| `saveMedia(msgId, media)` | зашифрованное медиа в таблицу `media` |
| `getMedia(msgId)` | конверт из таблицы |
| `saveMediaMessage(meta, envelope)` | строка сообщения + файл (Storage или media) |
| `uploadStoredMedia(msgId, envelope)` | зашифрованный файл в Storage |
| `getStoredMediaEnvelope(path)` | скачать конверт из Storage |
| `getDecryptedMediaBlob(msg, userId)` | расшифрованный Blob |
| `deleteStoredMedia(path)` | удалить файл из Storage |
| `uploadAvatar(userId, file)` | аватар |

## Оповещения и контакты

| Функция | Назначение |
|---------|------------|
| `sendBroadcast(...)` | рассылка по взводу/курсу/факультету/университету/выборке |
| `getMyBroadcasts(userId)` | свои и полученные оповещения |
| `getContacts(userId)` | контакты с папками |
| `addContact` / `removeContact` | добавить/убрать контакт |
| `moveContactToFolder(ownerId, userId, folder)` | перенести в папку |
| `getContactIds(ownerId)` | Set id контактов |

## Присутствие, сессии, тема

| Функция | Назначение |
|---------|------------|
| `notifyTyping` / `stopTyping` | «печатает…» |
| `touchPresence(userId)` | пульс онлайна |
| `isUserOnline(userId)` | онлайн? |
| `registerSession(userId)` | записать устройство |
| `getMySessions(userId)` | список устройств |
| `logoutAllDevicesExcept(...)` | выйти на других устройствах |
| `getCurrentUserId()` / `setCurrentUserId(id)` | сессия |
| `logout()` | выход + очистка ключей/кэша/очереди |
| `ensureSessionToken()` | после обновления схемы разлогинивает сессии без токена |
| `getThemeMode()` / `setThemeMode(mode)` | тема |
| `notifyTyping` | см. выше |

## Администрирование

| Функция | Назначение |
|---------|------------|
| `getAdminStats()` | счётчики дашборда |
| `getAdminActivity(days)` | активность по дням (RPC `admin_activity`) |
| `adminGetChats()` | все чаты (RPC `admin_list_chats`) |
| `adminDeleteChat` | удалить чат |
| `adminToggleChatPin` | закрепить/открепить |
| `adminMergeDuplicateChats()` | слить дубли авточатов (RPC) |
| `adminGetBroadcasts` / `adminDeleteBroadcast` / `adminUpdateBroadcastText` | рассылки |
| `getAuditLog(filters)` / `logAudit(...)` | журнал действий |
| `exportBackup()` | JSON-копия профилей, структуры и журнала |
| `getAppSettings()` / `setAppSetting(key, value)` | настройки системы |
| `adminUpdateProfile(...)` | изменить ФИО/группу/звание/должность |
| `adminResetPassword(...)` | сбросить пароль |
| `adminDeleteUser(userId)` | удалить пользователя |
| `adminLogoutUser(userId)` | завершить сессии |
| `adminFixKeys(...)` | восстановить ключи |
| `adminAddDepartment` / `adminRenameDepartment` / `adminDeleteDepartment` | структура |
| `adminBulkMoveGroup` / `adminBulkDelete` / `adminBulkResetPassword` | массовые операции |
| `adminImportUsers(rows)` | импорт CSV |

## Структура

| Функция | Назначение |
|---------|------------|
| `getDepartments()` | подразделения |
| `getPositions()` | должности |
| `searchUsers` | см. выше |

## Служебные

`emit`-события: `chat:updated`, `message:new`, `message:updated`,
`chat:cleared`, `broadcast:new`, `settings:changed`, `keys:updated`,
`avatar:updated`, `auth:changed`, `presence`, `typing`.
