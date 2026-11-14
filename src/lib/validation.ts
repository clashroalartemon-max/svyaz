/**
 * Единые правила валидации форм. Чистые функции без побочных эффектов —
 * их используют и интерфейс, и автотесты (см. validation.test.ts).
 */

export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_GROUP_TITLE_LENGTH = 60;
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 МБ
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export const MIN_LOGIN_LENGTH = 3;
export const MAX_LOGIN_LENGTH = 32;

const LOGIN_RE = /^[a-z0-9._-]+$/i;

export interface ValidationResult {
  ok: boolean;
  error: string | null;
}

const ok: ValidationResult = { ok: true, error: null };

function fail(error: string): ValidationResult {
  return { ok: false, error };
}

/** Логин: 3–32 символа, латиница/цифры/точка/дефис/подчёркивание. */
export function validateLogin(login: string): ValidationResult {
  const value = login.trim();
  if (!value) return fail('Введите логин');
  if (value.length < MIN_LOGIN_LENGTH) return fail('Логин короче 3 символов');
  if (value.length > MAX_LOGIN_LENGTH) return fail('Логин длиннее 32 символов');
  if (!LOGIN_RE.test(value)) return fail('Логин: только латиница, цифры, «.», «-», «_»');
  return ok;
}

/** Пароль: минимум 6 символов, не равен логину, не длиннее 128. */
export function validatePassword(password: string, login?: string): ValidationResult {
  if (!password) return fail('Введите пароль');
  if (password.length < MIN_PASSWORD_LENGTH) return fail('Пароль короче 6 символов');
  if (password.length > MAX_PASSWORD_LENGTH) return fail('Пароль слишком длинный');
  if (login && password.toLowerCase() === login.trim().toLowerCase()) {
    return fail('Пароль не должен совпадать с логином');
  }
  return ok;
}

/** Смена пароля: новый пароль должен отличаться от текущего. */
export function validatePasswordChange(
  currentPassword: string,
  newPassword: string,
  repeatPassword: string,
  login?: string,
): ValidationResult {
  if (!currentPassword) return fail('Введите текущий пароль');
  const next = validatePassword(newPassword, login);
  if (!next.ok) return next;
  if (newPassword === currentPassword) return fail('Новый пароль совпадает с текущим');
  if (newPassword !== repeatPassword) return fail('Пароли не совпадают');
  return ok;
}

/** Текст сообщения: не пустой и не длиннее 4000 символов. */
export function validateMessage(text: string): ValidationResult {
  const value = text.trim();
  if (!value) return fail('Сообщение пустое');
  if (value.length > MAX_MESSAGE_LENGTH) return fail('Сообщение длиннее 4000 символов');
  return ok;
}

/** Название группы: 1–60 символов. */
export function validateGroupTitle(title: string): ValidationResult {
  const value = title.trim();
  if (!value) return fail('Введите название чата');
  if (value.length > MAX_GROUP_TITLE_LENGTH) return fail('Название длиннее 60 символов');
  return ok;
}

/** Размер файла: не больше лимита (по умолчанию 25 МБ). */
export function validateFileSize(bytes: number, limit = MAX_MEDIA_BYTES): ValidationResult {
  if (!Number.isFinite(bytes) || bytes <= 0) return fail('Файл пустой');
  if (bytes > limit) {
    const mb = Math.round(limit / (1024 * 1024));
    return fail(`Файл больше ${mb} МБ`);
  }
  return ok;
}

/** Тип медиа: только изображения и видео. */
export function validateMediaType(mime: string): ValidationResult {
  if (mime.startsWith('image/') || mime.startsWith('video/')) return ok;
  return fail('Можно отправлять только фото и видео');
}
