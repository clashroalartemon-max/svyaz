import { describe, expect, it } from 'vitest';
import { encodeTodo, parseTodo, TODO_PREFIX } from './todo';

describe('список задач', () => {
  it('кодирует и разбирает пункты', () => {
    const text = encodeTodo(['Купить хлеб', 'Позвонить']);
    expect(text.startsWith(TODO_PREFIX)).toBe(true);
    expect(parseTodo(text)).toEqual({ items: ['Купить хлеб', 'Позвонить'] });
  });

  it('обычный текст не считается списком', () => {
    expect(parseTodo('привет')).toBeNull();
    expect(parseTodo('[todo]не json')).toBeNull();
  });
});
