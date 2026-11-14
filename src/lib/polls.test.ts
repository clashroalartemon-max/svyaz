import { describe, expect, it } from 'vitest';
import { encodePoll, parsePoll, POLL_PREFIX } from './polls';

describe('опросы', () => {
  it('кодирует и разбирает вопрос с вариантами', () => {
    const text = encodePoll({ q: 'Староста?', options: ['Иванов', 'Петров'] });
    expect(text.startsWith(POLL_PREFIX)).toBe(true);
    expect(parsePoll(text)).toEqual({ q: 'Староста?', options: ['Иванов', 'Петров'] });
  });

  it('обычный текст опросом не считается', () => {
    expect(parsePoll('привет')).toBeNull();
    expect(parsePoll('[poll]не json')).toBeNull();
  });
});
