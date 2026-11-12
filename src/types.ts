export type Role = 'cadet' | 'admin';

/** Режим темы: светлая / тёмная / как в системе */
export type ThemeMode = 'light' | 'dark' | 'system';

export interface User {
  id: string;
  login: string;
  fullName: string;
  group: string;
  role: Role;
  publicKeyJwk: JsonWebKey;
  avatarUrl?: string;
  createdAt: number;
}

export type MessageType = 'text' | 'voice' | 'photo' | 'video' | 'circle';

/** Статус доставки собственного сообщения */
export type MessageStatus = 'sent' | 'delivered' | 'read';

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
  /** ответ на сообщение: id исходного сообщения, на которое отвечают */
  replyToId?: string;
  createdAt: number;
}

export interface Chat {
  id: string;
  participants: [string, string];
  createdAt: number;
  /** системный чат «Избранное» (переписка с самим собой) */
  saved?: boolean;
  /** секретный чат: сообщения удаляются автоматически через 24 часа */
  secret?: boolean;
}

export interface ChatListItem {
  chat: Chat;
  peer: User;
  lastMessage: Message | null;
  unread: number;
}
