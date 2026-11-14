import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getPinnedId, savePinnedId } from './pins';

const store = new Map<string, string>();

beforeAll(() => {
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
  vi.stubGlobal('window', { localStorage });
});

describe('закреплённое сообщение', () => {
  it('сохраняет и читает id для конкретного чата', () => {
    savePinnedId('chat-1', 'msg-7');
    expect(getPinnedId('chat-1')).toBe('msg-7');
    expect(getPinnedId('chat-2')).toBeNull();
  });

  it('снимает закрепление', () => {
    savePinnedId('chat-1', 'msg-7');
    savePinnedId('chat-1', null);
    expect(getPinnedId('chat-1')).toBeNull();
  });
});
