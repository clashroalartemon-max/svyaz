export type Role = 'cadet' | 'admin';

/** Звания (в порядке старшинства) */
export const RANKS = [
  'курсант',
  'рядовой',
  'ефрейтор',
  'младший сержант',
  'сержант',
  'старший сержант',
  'старшина',
  'прапорщик',
  'старший прапорщик',
  'младший лейтенант',
  'лейтенант',
  'старший лейтенант',
  'капитан',
  'майор',
  'подполковник',
  'полковник',
  'генерал-майор',
  'генерал-лейтенант',
  'генерал-полковник',
] as const;

export type Rank = (typeof RANKS)[number];

/** Должности */
export const POSITIONS = [
  'курсант',
  'староста группы',
  'командир отделения',
  'заместитель командира взвода',
  'командир взвода',
  'начальник курса',
  'преподаватель',
  'доцент кафедры',
  'начальник кафедры',
  'начальник факультета',
  'начальник университета',
] as const;

export type Position = (typeof POSITIONS)[number];

/** Тип чата: личный или групповой/системный */
export type ChatKind =
  | 'direct'
  | 'squad'
  | 'commander'
  | 'course'
  | 'teachers'
  | 'group'
  | 'broadcast';

/** Режим темы: светлая / тёмная / как в системе */
export type ThemeMode = 'light' | 'dark' | 'system';

export interface User {
  id: string;
  login: string;
  fullName: string;
  group: string;
  role: Role;
  /** звание (например «рядовой», «сержант», «лейтенант») */
  rank?: string;
  /** должность (например «курсант», «командир взвода») */
  position?: string;
  /** уровень прав: 1 — курсант, 10 — начальник университета */
  roleLevel?: number;
  /** уникальный ник, задаёт сам пользователь */
  username?: string;
  /** подразделение (факультет / кафедра / управление) из таблицы departments */
  department?: string;
  /** контактный телефон */
  phone?: string;
  /** короткий статус: «На учёбе», «В наряде», «Свободен» */
  status?: string;
  /** краткое био «О себе» */
  bio?: string;
  publicKeyJwk: JsonWebKey;
  avatarUrl?: string;
  createdAt: number;
}

export type MessageType = 'text' | 'voice' | 'photo' | 'video' | 'circle' | 'document';

/** Статус доставки собственного сообщения */
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read';

/**
 * Поля «конверта»: контент зашифрован случайным AES-ключом,
 * сам ключ завёрнут через ECDH отдельно для получателя и для отправителя.
 * Так обе стороны могут прочитать сообщение своими приватными ключами.
 */
export interface EnvelopeFields {
  /** base64-шифротекст содержимого */
  ciphertext: string;
  /** base64 IV содержимого */
  iv: string;
  /** ключ контента, завёрнутый ECDH(myPrivate, peerPublic) — для получателя */
  wrappedKey?: string;
  wrappedKeyIv?: string;
  /** ключ контента, завёрнутый ECDH(myPrivate, myPublic) — для автора */
  wrappedSelfKey?: string;
  wrappedSelfKeyIv?: string;
}

export interface Message extends EnvelopeFields {
  id: string;
  chatId: string;
  senderId: string;
  type: MessageType;
  mimeType?: string;
  /** длительность в секундах (voice, circle, video) */
  duration?: number;
  /** огибающая громкости голосового: 0..1 */
  waveform?: number[];
  status: MessageStatus;
  /** время последнего редактирования */
  editedAt?: number;
  /** мягкое удаление: текст/медиа стёрты, показывается «Сообщение удалено» */
  deleted?: boolean;
  /** «Удалить у себя»: пользователи, для которых сообщение скрыто */
  deletedFor?: string[];
  /** ссылка на зашифрованное медиа в Supabase Storage (bucket 'media') */
  storagePath?: string;
  /** ответ на сообщение: id исходного сообщения, на которое отвечают */
  replyToId?: string;
  /** групповое шифрование: ключ контента для каждого участника чата */
  groupKeys?: Record<string, { w: string; i: string }>;
  createdAt: number;
}

export interface Chat {
  id: string;
  /** все участники чата (у 1:1 — два) */
  participants: string[];
  createdAt: number;
  /** создатель чата (для групповых) */
  ownerId?: string;
  /** системный чат «Избранное» (переписка с самим собой) */
  saved?: boolean;
  /** секретный чат: сообщения удаляются автоматически через 24 часа */
  secret?: boolean;
  /** тип чата: direct / squad / commander / course / teachers / group / broadcast */
  kind?: ChatKind;
  /** название группового чата */
  title?: string;
  /** целевая группа (например «152» или «курс 1») */
  target?: string;
}

export interface ChatListItem {
  chat: Chat;
  peer: User;
  lastMessage: Message | null;
  unread: number;
}

/** Оповещение (рассылка) — сохраняется отдельно от чатов. */
export interface Broadcast {
  id: string;
  senderId: string;
  /** цель: взвод / курс / факультет / университет / выборочно из контактов */
  targetType: 'squad' | 'course' | 'faculty' | 'university' | 'custom';
  targetValue?: string;
  text: string;
  targetUserIds?: string[];
  createdAt: number;
  read?: boolean;
}
