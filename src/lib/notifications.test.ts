import { describe, expect, it } from 'vitest';
import { shouldShowNotification } from './notifications';

describe('правило показа уведомления', () => {
  it('показывает только с разрешением', () => {
    expect(shouldShowNotification('default', true, false)).toBe(false);
    expect(shouldShowNotification('denied', true, false)).toBe(false);
    expect(shouldShowNotification('unsupported', true, false)).toBe(false);
  });

  it('показывает, если вкладка скрыта или чат не открыт', () => {
    expect(shouldShowNotification('granted', true, true)).toBe(true);
    expect(shouldShowNotification('granted', false, false)).toBe(true);
    expect(shouldShowNotification('granted', false, true)).toBe(false);
  });
});
