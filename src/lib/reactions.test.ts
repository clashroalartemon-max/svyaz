import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getReaction, setReaction, toggleReaction } from './reactions';

const store = new Map<string, string>();

beforeAll(() => {
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => void store.clear(),
  };
  vi.stubGlobal('window', { localStorage });
});

describe('реакции', () => {
  it('ставит, меняет и снимает реакцию', () => {
    setReaction('m1', '👍');
    expect(getReaction('m1')).toBe('👍');
    expect(toggleReaction('m1', '👍')).toBeNull();
    expect(getReaction('m1')).toBeNull();
    expect(toggleReaction('m1', '🔥')).toBe('🔥');
  });
});
