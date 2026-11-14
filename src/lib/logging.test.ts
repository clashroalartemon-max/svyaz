import { describe, expect, it } from 'vitest';
import { maskSecrets, safeError } from './logging';

describe('маскирование секретов в логах', () => {
  it('скрывает приватный ключ, пароль, токен и шифротекст', () => {
    const masked = maskSecrets({
      login: 'cadet143',
      privateKeyJwk: { d: 'secret' },
      password: 'test1234',
      session_token: 'abc',
      ciphertext: 'AAAA',
      wrapped_key: 'BBBB',
    });

    expect(masked).toEqual({
      login: 'cadet143',
      privateKeyJwk: '[скрыто]',
      password: '[скрыто]',
      session_token: '[скрыто]',
      ciphertext: '[скрыто]',
      wrapped_key: '[скрыто]',
    });
  });

  it('работает с вложенными объектами и массивами', () => {
    const masked = maskSecrets({
      user: { fullName: 'Иван', passwordHash: 'hash' },
      keys: [{ privateKey: 'x', publicKey: 'y' }],
    });

    expect(masked.user).toEqual({ fullName: 'Иван', passwordHash: '[скрыто]' });
    expect(masked.keys[0]).toEqual({ privateKey: '[скрыто]', publicKey: 'y' });
  });

  it('safeError не печатает содержимое объекта с ключами', () => {
    expect(safeError(new Error('не удалось расшифровать'))).toBe('не удалось расшифровать');
    const text = safeError({ privateKeyJwk: { d: 'secret' }, reason: 'bad key' });
    expect(text).toContain('bad key');
    expect(text).not.toContain('secret');
  });
});
