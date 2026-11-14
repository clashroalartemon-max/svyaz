/**
 * Заголовки идентификации запроса.
 *
 * Основной режим — сессионный токен, выданный сервером после проверки пароля.
 * Заголовок x-user-id остаётся только для совместимости со старой базой, где
 * ещё не применён schema.sql с таблицей auth_tokens: как только токен есть,
 * идентификатор в заголовке не отправляется.
 */
export function buildAuthHeaders(
  userId: string | null,
  token: string | null,
): Record<string, string> {
  if (token) return { 'x-session-token': token };
  if (userId) return { 'x-user-id': userId };
  return {};
}
