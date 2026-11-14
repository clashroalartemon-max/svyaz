import * as storage from './storage';

/** Реакции прототипа хранятся на устройстве (без отдельной таблицы БД). */
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '🔥', '😮', '😢', '🚔', '👮', '🚨', '🛡️', '🎖️', '⭐'] as const;

const key = (messageId: string): string => `svyaz.reaction.${messageId}`;

export function getReaction(messageId: string): string | null {
  const value = storage.readJson<string>(key(messageId));
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function setReaction(messageId: string, emoji: string | null): void {
  if (emoji) storage.writeJson(key(messageId), emoji);
  else storage.remove(key(messageId));
}

export function toggleReaction(messageId: string, emoji: string): string | null {
  const next = getReaction(messageId) === emoji ? null : emoji;
  setReaction(messageId, next);
  return next;
}
