import { describe, expect, it } from 'vitest';
import { buildAuthHeaders } from './session';

describe('идентификация запросов', () => {
  it('с токеном отправляет только x-session-token', () => {
    expect(buildAuthHeaders('user-1', 'token-abc')).toEqual({
      'x-session-token': 'token-abc',
    });
    expect(buildAuthHeaders('user-1', 'token-abc')).not.toHaveProperty('x-user-id');
  });

  it('без токена использует x-user-id только для старой базы', () => {
    expect(buildAuthHeaders('user-1', null)).toEqual({ 'x-user-id': 'user-1' });
  });

  it('без пользователя не отправляет ничего', () => {
    expect(buildAuthHeaders(null, null)).toEqual({});
  });
});
