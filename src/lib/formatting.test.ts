import { describe, expect, it } from 'vitest';
import { parseFormatting } from './formatting';

describe('разметка сообщений', () => {
  it('разбирает жирный, курсив, зачёркнутый и код', () => {
    expect(parseFormatting('**важно** и *курсив* ~~старое~~ `код`')).toEqual([
      { type: 'bold', value: 'важно' },
      { type: 'text', value: ' и ' },
      { type: 'italic', value: 'курсив' },
      { type: 'text', value: ' ' },
      { type: 'strike', value: 'старое' },
      { type: 'text', value: ' ' },
      { type: 'code', value: 'код' },
    ]);
  });

  it('разбирает подчёркивание и спойлер', () => {
    expect(parseFormatting('__подчёркнуто__ ||секрет||')).toEqual([
      { type: 'underline', value: 'подчёркнуто' },
      { type: 'text', value: ' ' },
      { type: 'spoiler', value: 'секрет' },
    ]);
  });

  it('обычный текст остаётся одним токеном', () => {
    expect(parseFormatting('привет, мир')).toEqual([
      { type: 'text', value: 'привет, мир' },
    ]);
  });

  it('не ломается на незакрытой разметке', () => {
    expect(parseFormatting('**не закрыто')).toEqual([
      { type: 'text', value: '**не закрыто' },
    ]);
  });
});
