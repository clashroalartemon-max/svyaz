import { describe, expect, it } from 'vitest';
import {
  MAX_MEDIA_BYTES,
  validateFileSize,
  validateGroupTitle,
  validateLogin,
  validateMediaType,
  validateMessage,
  validatePassword,
  validatePasswordChange,
} from './validation';

describe('логин', () => {
  it('принимает корректный', () => {
    expect(validateLogin('cadet143').ok).toBe(true);
    expect(validateLogin('admin').ok).toBe(true);
    expect(validateLogin('a.b-c_1').ok).toBe(true);
  });

  it('отклоняет пустой, короткий и с недопустимыми символами', () => {
    expect(validateLogin('').ok).toBe(false);
    expect(validateLogin('ab').ok).toBe(false);
    expect(validateLogin('Иван').ok).toBe(false);
    expect(validateLogin('user name').ok).toBe(false);
    expect(validateLogin('a'.repeat(40)).ok).toBe(false);
  });
});

describe('пароль', () => {
  it('требует минимум 6 символов и не равен логину', () => {
    expect(validatePassword('test1234').ok).toBe(true);
    expect(validatePassword('123').ok).toBe(false);
    expect(validatePassword('admin', 'admin').ok).toBe(false);
  });

  it('смена пароля проверяет совпадение и отличие', () => {
    expect(validatePasswordChange('old1234', 'new12345', 'new12345').ok).toBe(true);
    expect(validatePasswordChange('old1234', 'new12345', 'other123').ok).toBe(false);
    expect(validatePasswordChange('old1234', 'old1234', 'old1234').ok).toBe(false);
    expect(validatePasswordChange('', 'new12345', 'new12345').ok).toBe(false);
  });
});

describe('сообщения', () => {
  it('не пропускает пустое и слишком длинное', () => {
    expect(validateMessage('   ').ok).toBe(false);
    expect(validateMessage('привет').ok).toBe(true);
    expect(validateMessage('x'.repeat(4001)).ok).toBe(false);
  });
});

describe('групповой чат', () => {
  it('требует название и ограничивает длину', () => {
    expect(validateGroupTitle('').ok).toBe(false);
    expect(validateGroupTitle('Дежурная смена').ok).toBe(true);
    expect(validateGroupTitle('x'.repeat(61)).ok).toBe(false);
  });
});

describe('файлы', () => {
  it('отклоняет пустой и слишком большой файл (100 МБ)', () => {
    expect(validateFileSize(0).ok).toBe(false);
    expect(validateFileSize(1024).ok).toBe(true);
    expect(validateFileSize(100 * 1024 * 1024).ok).toBe(false);
    expect(validateFileSize(100 * 1024 * 1024).error).toBe('Файл больше 25 МБ');
    expect(validateFileSize(MAX_MEDIA_BYTES).ok).toBe(true);
    expect(validateFileSize(MAX_MEDIA_BYTES + 1).ok).toBe(false);
  });

  it('пропускает только изображения и видео', () => {
    expect(validateMediaType('image/jpeg').ok).toBe(true);
    expect(validateMediaType('video/webm').ok).toBe(true);
    expect(validateMediaType('application/pdf').ok).toBe(false);
    expect(validateMediaType('audio/webm').ok).toBe(false);
  });
});
