import * as storage from './storage';

/**
 * Закреплённое сообщение чата. Хранится на устройстве: в прототипе это
 * персональная закладка, а не общая настройка чата (для общей нужна колонка
 * messages.pinned и RPC, см. SUMMARY.md).
 */
const key = (chatId: string): string => `svyaz.pin.${chatId}`;

export function getPinnedId(chatId: string): string | null {
  const value = storage.readJson<string>(key(chatId));
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function savePinnedId(chatId: string, messageId: string | null): void {
  if (messageId) storage.writeJson(key(chatId), messageId);
  else storage.remove(key(chatId));
}
