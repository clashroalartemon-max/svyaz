import type { Message } from '../types';
import { parsePoll, POLL_PREFIX } from './polls';
import { parseTodo, TODO_PREFIX } from './todo';
import { parseLocation } from './location';
import { isSticker, stickerEmoji } from './stickers';

const MEDIA_LABEL: Record<Message['type'], string> = {
  text: '',
  voice: 'Голосовое сообщение',
  photo: 'Фото',
  video: 'Видео',
  circle: 'Видеокружок',
  document: 'Документ',
};

function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  return ` (${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')})`;
}

/**
 * Человекочитаемое описание сообщения: служебные маркеры `[poll]`,
 * `[todo]`, `[geo]`, `[sticker]` не должны попадать в превью и пересылку.
 */
export function summarizeMessage(type: Message['type'], text: string | null): string {
  if (type !== 'text') return MEDIA_LABEL[type];
  if (!text) return 'Сообщение';
  const prefix = (marker: string): string => {
    const index = text.indexOf(marker);
    return index > 0 ? text.slice(0, index).trim() : '';
  };
  const pollText = text.startsWith(POLL_PREFIX) ? text : text.slice(Math.max(0, text.indexOf(POLL_PREFIX)));
  const poll = text.includes(POLL_PREFIX) ? parsePoll(pollText) : null;
  if (poll) {
    const options = poll.options.slice(0, 3).join(', ');
    const head = prefix(POLL_PREFIX);
    return `${head ? `${head} ` : ''}Голосование: «${poll.q}»${options ? ` — ${options}` : ''}`;
  }
  const todoText = text.startsWith(TODO_PREFIX) ? text : text.slice(Math.max(0, text.indexOf(TODO_PREFIX)));
  const todo = text.includes(TODO_PREFIX) ? parseTodo(todoText) : null;
  if (todo) {
    const head = prefix(TODO_PREFIX);
    const list = todo.items.slice(0, 3).join(', ');
    return `${head ? `${head} ` : ''}Список задач${list ? `: ${list}` : ''}`;
  }
  if (parseLocation(text) || text.startsWith('[geo]')) return 'Геопозиция';
  if (isSticker(text)) return `Стикер ${stickerEmoji(text)}`;
  return text;
}

/** Короткая метка для списка чатов без автора и лишних деталей. */
export function describeMessage(msg: Message, text: string | null): string {
  if (msg.deleted) return 'Сообщение удалено';
  const label = summarizeMessage(msg.type, text);
  if (msg.type === 'voice' || msg.type === 'circle') {
    return `${label}${formatDuration(msg.duration)}`;
  }
  return label;
}
