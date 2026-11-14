import { beforeAll, describe, expect, it, vi } from 'vitest';
import { isIncognito, setIncognito } from './incognito';

const store = new Map<string, string>();

beforeAll(() => {
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => void store.clear(),
  };
  vi.stubGlobal('window', {
    localStorage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

describe('режим инкогнито', () => {
  it('по умолчанию выключен и включается/выключается', () => {
    expect(isIncognito()).toBe(false);
    setIncognito(true);
    expect(isIncognito()).toBe(true);
    setIncognito(false);
    expect(isIncognito()).toBe(false);
  });
});
