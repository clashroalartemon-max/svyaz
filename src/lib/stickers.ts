/**
 * Стикеры прототипа: крупные эмодзи. Отдельный тип сообщения не нужен —
 * текст помечается префиксом, а лента рисует его увеличенным.
 */
export const STICKER_PREFIX = '[sticker]';

export const STICKERS = [
  '😀',
  '😂',
  '👍',
  '❤️',
  '🔥',
  '🎉',
  '😎',
  '🤝',
  '✅',
  '🙏',
  '💪',
  '😅',
] as const;

export function toSticker(emoji: string): string {
  return `${STICKER_PREFIX}${emoji}`;
}

export function isSticker(text: string): boolean {
  return text.startsWith(STICKER_PREFIX) && text.length > STICKER_PREFIX.length;
}

export function stickerEmoji(text: string): string {
  return isSticker(text) ? text.slice(STICKER_PREFIX.length) : '';
}
