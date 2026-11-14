import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  decryptEnvelope,
  decryptEnvelopeToString,
  decryptGroupEnvelope,
  encryptFor,
  encryptForGroup,
  generateUserKeys,
  savePrivateKey,
} from './crypto';

/**
 * crypto.ts рассчитан на браузер: приватные ключи берёт из localStorage.
 * Для Node-тестов подставляем минимальные шимы хранилища и Web Crypto.
 */
const store = new Map<string, string>();

beforeAll(() => {
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  };
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('window', { localStorage, crypto: globalThis.crypto });
});

describe('E2EE: личные сообщения', () => {
  it('шифрует и расшифровывает текст у автора и получателя', async () => {
    const alice = await generateUserKeys();
    const bob = await generateUserKeys();
    savePrivateKey('alice', alice.privateKeyJwk);
    savePrivateKey('bob', bob.privateKeyJwk);

    const envelope = await encryptFor({
      myId: 'alice',
      myPublicKeyJwk: alice.publicKeyJwk,
      peerPublicKeyJwk: bob.publicKeyJwk,
      data: 'Секретное сообщение',
    });

    expect(envelope.ciphertext.length).toBeGreaterThan(0);
    expect(envelope.ciphertext).not.toContain('Секретное');

    const asAuthor = await decryptEnvelopeToString({
      myId: 'alice',
      own: true,
      senderPublicKeyJwk: alice.publicKeyJwk,
      peerPublicKeyJwk: bob.publicKeyJwk,
      envelope,
    });
    expect(asAuthor).toBe('Секретное сообщение');

    const asRecipient = await decryptEnvelopeToString({
      myId: 'bob',
      own: false,
      senderPublicKeyJwk: alice.publicKeyJwk,
      envelope,
    });
    expect(asRecipient).toBe('Секретное сообщение');
  });

  it('не расшифровывает подменённый шифротекст', async () => {
    const alice = await generateUserKeys();
    const bob = await generateUserKeys();
    savePrivateKey('alice', alice.privateKeyJwk);
    savePrivateKey('bob', bob.privateKeyJwk);

    const envelope = await encryptFor({
      myId: 'alice',
      myPublicKeyJwk: alice.publicKeyJwk,
      peerPublicKeyJwk: bob.publicKeyJwk,
      data: 'Важное',
    });
    const tampered = {
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -4)}AAAA`,
    };

    await expect(
      decryptEnvelopeToString({
        myId: 'bob',
        own: false,
        senderPublicKeyJwk: alice.publicKeyJwk,
        envelope: tampered,
      }),
    ).rejects.toThrow();
  });

  it('шифрует бинарные данные (медиа) и возвращает исходные байты', async () => {
    const alice = await generateUserKeys();
    const bob = await generateUserKeys();
    savePrivateKey('alice', alice.privateKeyJwk);
    savePrivateKey('bob', bob.privateKeyJwk);

    const bytes = new Uint8Array([0, 1, 2, 250, 255, 42]);
    const envelope = await encryptFor({
      myId: 'alice',
      myPublicKeyJwk: alice.publicKeyJwk,
      peerPublicKeyJwk: bob.publicKeyJwk,
      data: bytes.buffer,
    });
    const decoded = await decryptEnvelope({
      myId: 'bob',
      own: false,
      senderPublicKeyJwk: alice.publicKeyJwk,
      envelope,
    });
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });
});

describe('E2EE: групповые сообщения', () => {
  it('расшифровывает групповой текст каждым участником', async () => {
    const alice = await generateUserKeys();
    const bob = await generateUserKeys();
    savePrivateKey('alice', alice.privateKeyJwk);
    savePrivateKey('bob', bob.privateKeyJwk);

    const envelope = await encryptForGroup({
      myId: 'alice',
      myPublicKeyJwk: alice.publicKeyJwk,
      members: [
        { id: 'alice', publicKeyJwk: alice.publicKeyJwk },
        { id: 'bob', publicKeyJwk: bob.publicKeyJwk },
      ],
      data: 'Групповое сообщение',
    });

    const forAlice = await decryptGroupEnvelope({
      myId: 'alice',
      senderPublicKeyJwk: alice.publicKeyJwk,
      groupKeys: envelope.groupKeys,
      envelope,
    });
    expect(new TextDecoder().decode(forAlice)).toBe('Групповое сообщение');

    const forBob = await decryptGroupEnvelope({
      myId: 'bob',
      senderPublicKeyJwk: alice.publicKeyJwk,
      groupKeys: envelope.groupKeys,
      envelope,
    });
    expect(new TextDecoder().decode(forBob)).toBe('Групповое сообщение');
  });

  it('отказывает тому, кому ключ не выдавался', async () => {
    const alice = await generateUserKeys();
    const bob = await generateUserKeys();
    const eve = await generateUserKeys();
    savePrivateKey('alice', alice.privateKeyJwk);
    savePrivateKey('eve', eve.privateKeyJwk);

    const envelope = await encryptForGroup({
      myId: 'alice',
      myPublicKeyJwk: alice.publicKeyJwk,
      members: [
        { id: 'alice', publicKeyJwk: alice.publicKeyJwk },
        { id: 'bob', publicKeyJwk: bob.publicKeyJwk },
      ],
      data: 'Только для своих',
    });

    await expect(
      decryptGroupEnvelope({
        myId: 'eve',
        senderPublicKeyJwk: alice.publicKeyJwk,
        groupKeys: envelope.groupKeys,
        envelope,
      }),
    ).rejects.toThrow();
  });
});
