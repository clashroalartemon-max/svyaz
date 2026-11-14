/**
 * Маскирование секретов в логах.
 *
 * Приватные ключи, пароли, токены и шифротекст не должны попадать в консоль
 * или отчёты об ошибках. Функции ниже рекурсивно заменяют значения полей с
 * «секретными» именами и приводят ошибку к безопасной строке.
 */

const SECRET_KEY_RE = /(private|password|secret|token|ciphertext|wrapped)/i;

export function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => maskSecrets(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      result[key] = SECRET_KEY_RE.test(key) ? '[скрыто]' : maskSecrets(item);
    }
    return result as T;
  }
  return value;
}

/** Безопасное описание ошибки: без ключей, паролей и шифротекста. */
export function safeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(maskSecrets(error));
  } catch {
    return 'неизвестная ошибка';
  }
}
