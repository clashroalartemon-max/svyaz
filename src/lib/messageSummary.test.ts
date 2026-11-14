import { describe, expect, it } from 'vitest';
import { describeMessage, summarizeMessage } from './messageSummary';
import { encodePoll } from './polls';
import { encodeTodo } from './todo';
import { encodeLocation } from './location';
import type { Message } from '../types';

const base = {
  id: 'm1',
  chatId: 'c1',
  senderId: 'u1',
  status: 'sent' as const,
  createdAt: 1,
  ciphertext: '',
  iv: '',
};

describe('summarizeMessage', () => {
  it('оставляет обычный текст как есть', () => {
    expect(summarizeMessage('text', 'Привет')).toBe('Привет');
  });

  it('превращает опрос в читаемую строку', () => {
    const text = encodePoll({ q: 'Кто идёт в наряд?', options: ['Иванов', 'Петров'] });
    expect(summarizeMessage('text', text)).toBe(
      'Голосование: «Кто идёт в наряд?» — Иванов, Петров',
    );
  });

  it('превращает список задач в читаемую строку', () => {
    expect(summarizeMessage('text', encodeTodo(['Построение', 'Наряд']))).toBe(
      'Список задач: Построение, Наряд',
    );
  });

  it('распознаёт геопозицию и стикер', () => {
    expect(summarizeMessage('text', encodeLocation(55.75, 37.61))).toBe('Геопозиция');
    expect(summarizeMessage('text', '[sticker]🔥')).toBe('Стикер 🔥');
  });

  it('называет медиа без служебных скобок', () => {
    expect(summarizeMessage('voice', null)).toBe('Голосовое сообщение');
    expect(summarizeMessage('circle', null)).toBe('Видеокружок');
    expect(summarizeMessage('document', null)).toBe('Документ');
  });
});

describe('describeMessage', () => {
  it('добавляет длительность голосового и кружка', () => {
    const voice = { ...base, type: 'voice', duration: 65 } as Message;
    expect(describeMessage(voice, null)).toBe('Голосовое сообщение (1:05)');
  });

  it('удалённое сообщение не раскрывает содержимое', () => {
    const deleted = { ...base, type: 'text', deleted: true } as Message;
    expect(describeMessage(deleted, 'секрет')).toBe('Сообщение удалено');
  });
});
