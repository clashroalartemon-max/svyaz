import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Тесты слоя данных без сети: Supabase замокан, проверяем именно SQL-строки,
 * которые уходят в базу (создание чата и отправка сообщения).
 */
const { insertMock, updateMock } = vi.hoisted(() => ({
  insertMock: vi.fn<(table: string, rows: unknown) => Promise<{ error: { message: string } | null }>>(),
  updateMock: vi.fn<(table: string, patch: unknown) => void>(),
}));

vi.mock('./supabase', () => ({
  supabase: () => ({
    from: (table: string) => ({
      insert: (rows: unknown) => insertMock(table, rows),
      update: (patch: unknown) => ({
        eq: () => {
          updateMock(table, patch);
          return Promise.resolve({ error: null });
        },
      }),
    }),
  }),
  setSupabaseUser: vi.fn(),
  setSessionToken: vi.fn(),
}));

import {
  createGroupChat,
  flushOfflineQueue,
  getQueuedMessages,
  saveMessage,
  saveMessageOptimistic,
} from './db';
import type { Message } from '../types';

const storage = new Map<string, string>();

beforeAll(() => {
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => void storage.clear(),
  };
  vi.stubGlobal('window', {
    localStorage,
    sessionStorage: localStorage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  // Realtime в тестах не нужен: без BroadcastChannel шина работает локально.
  vi.stubGlobal('BroadcastChannel', undefined);
});

beforeEach(() => {
  insertMock.mockReset();
  insertMock.mockResolvedValue({ error: null });
  updateMock.mockReset();
  storage.clear();
});

function setOnline(value: boolean) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: value },
    configurable: true,
  });
}

describe('создание чата', () => {
  it('пишет чат и всех участников, включая владельца', async () => {
    const chat = await createGroupChat('owner-1', 'Дежурная смена', ['user-2', 'user-3']);

    expect(chat.title).toBe('Дежурная смена');
    expect(chat.kind).toBe('group');
    expect(chat.participants.sort()).toEqual(['owner-1', 'user-2', 'user-3']);

    const chatCall = insertMock.mock.calls.find(([table]) => table === 'chats');
    expect(chatCall).toBeDefined();
    expect(chatCall?.[1]).toMatchObject({
      owner_id: 'owner-1',
      kind: 'group',
      title: 'Дежурная смена',
      saved: false,
    });

    const partCall = insertMock.mock.calls.find(([table]) => table === 'chat_participants');
    expect(partCall).toBeDefined();
    const rows = partCall?.[1] as Array<{ chat_id: string; user_id: string }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.chat_id === chat.id)).toBe(true);
    expect(rows.map((row) => row.user_id).sort()).toEqual(['owner-1', 'user-2', 'user-3']);
  });

  it('не создаёт чат без владельца: ошибка базы пробрасывается', async () => {
    insertMock.mockResolvedValueOnce({ error: { message: 'RLS denied' } });
    await expect(createGroupChat('owner-1', 'Чат', [])).rejects.toThrow('RLS denied');
  });
});

describe('отправка сообщения', () => {
  const base: Message = {
    id: 'msg-1',
    chatId: 'chat-1',
    senderId: 'user-1',
    type: 'text',
    status: 'sent',
    createdAt: 1700000000000,
    ciphertext: 'cipher',
    iv: 'iv',
  };

  it('пишет зашифрованную строку с правильными id', async () => {
    await saveMessage(base);

    const call = insertMock.mock.calls.find(([table]) => table === 'messages');
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      id: 'msg-1',
      chat_id: 'chat-1',
      sender_id: 'user-1',
      ciphertext: 'cipher',
      iv: 'iv',
      status: 'sent',
    });
  });

  it('клиентский статус queued превращается в sent (CHECK в базе)', async () => {
    await saveMessage({ ...base, status: 'queued' });
    const call = insertMock.mock.calls.find(([table]) => table === 'messages');
    expect((call?.[1] as { status: string }).status).toBe('sent');
  });

  it('не глотает ошибку вставки', async () => {
    insertMock.mockResolvedValueOnce({ error: { message: 'new row violates row-level security' } });
    await expect(saveMessage(base)).rejects.toThrow('row-level security');
  });
});

describe('офлайн-очередь', () => {
  const message: Message = {
    id: 'offline-1',
    chatId: 'chat-1',
    senderId: 'user-1',
    type: 'text',
    status: 'sent',
    createdAt: 1700000000000,
    ciphertext: 'cipher',
    iv: 'iv',
  };

  it('без сети кладёт сообщение в очередь и не пишет в базу', async () => {
    setOnline(false);
    await saveMessageOptimistic(message);

    const queued = getQueuedMessages('chat-1');
    expect(queued).toHaveLength(1);
    expect(queued[0].id).toBe('offline-1');
    expect(queued[0].status).toBe('queued');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('при возврате сети досылает очередь и снимает статус queued', async () => {
    setOnline(false);
    await saveMessageOptimistic(message);
    await saveMessageOptimistic({ ...message, id: 'offline-2' });
    expect(getQueuedMessages('chat-1')).toHaveLength(2);

    setOnline(true);
    insertMock.mockClear();
    const sent = await flushOfflineQueue();

    expect(sent).toBe(2);
    expect(getQueuedMessages()).toHaveLength(0);
    expect(insertMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenCalledWith('messages', { status: 'sent' });
  });

  it('если сеть так и не появилась — сообщения остаются в очереди', async () => {
    setOnline(false);
    await saveMessageOptimistic(message);
    const sent = await flushOfflineQueue();
    expect(sent).toBe(0);
    expect(getQueuedMessages('chat-1')).toHaveLength(1);
  });
});
