/**
 * Криптография E2EE на Web Crypto API с резервной реализацией на TypeScript.
 *
 * ПОЧЕМУ ЕСТЬ РЕЗЕРВ.
 * `crypto.subtle` существует только в «безопасном контексте»: https:// или
 * http://localhost. Телефон, открывающий приложение по http://192.168.x.x,
 * получает `crypto.subtle === undefined`. Прежняя версия падала уже на
 * SHA-256 при создании базы: seed обрывался на первом пользователе, база
 * оставалась пустой, и любой вход отвечал «Неверный логин или пароль».
 * Теперь все примитивы продублированы на чистом TS (см. crypto-primitives.ts),
 * а формат байт-совместим с Web Crypto, поэтому история, зашифрованная в одном
 * контексте, читается в другом.
 *
 * СХЕМА («конверт»):
 *  1. У каждого пользователя — пара ключей ECDH P-256 (extractable: true).
 *     Публичный ключ лежит в User.publicKeyJwk, приватный — в svyaz.keys.<userId>.
 *  2. Для каждого сообщения генерируется случайный 32-байтовый ключ контента.
 *  3. Им шифруется текст или медиафайл ПЕРЕД записью в localStorage (AES-256-GCM).
 *  4. Ключ контента заворачивается дважды:
 *       • ECDH(приватный отправителя, публичный получателя) — для получателя;
 *       • ECDH(приватный отправителя, публичный отправителя) — для автора.
 *  5. В хранилище попадает только шифротекст, IV и два завёрнутых ключа.
 *
 * Чтение:
 *  • получатель: ECDH(мой приватный, публичный автора) → разворачивает wrappedKey;
 *  • автор:      ECDH(мой приватный, мой публичный)   → разворачивает wrappedSelfKey.
 *
 * Совместимость: если у сообщения нет wrappedSelfKey (старый формат), своё
 * сообщение читается ключом ECDH(мой приватный, публичный собеседника) —
 * этот же секрет был использован при отправке.
 *
 * В реальном продукте приватный ключ должен лежать в IndexedDB и быть
 * зашифрован паролем; в прототипе — localStorage (осознанное ограничение).
 */

import type { EnvelopeFields } from '../types';
import * as fallback from './crypto-primitives';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const IV_BYTES = 12;
const CONTENT_KEY_BYTES = 32;
const CURVE = 'P-256';
const ECDH_IMPORT: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };
const ECDH_GENERATE: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };
const AES_ALGO = 'AES-GCM';

// --- доступность и выбор реализации -------------------------------------------

/** Есть ли нативный Web Crypto (только https/localhost) */
export function hasWebCrypto(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof crypto.subtle.importKey === 'function' &&
    typeof crypto.subtle.digest === 'function'
  );
}

export type CryptoBackend = 'webcrypto' | 'js';

/** Какая реализация реально используется в этом окружении */
export function getCryptoBackend(): CryptoBackend {
  return hasWebCrypto() ? 'webcrypto' : 'js';
}

/**
 * Доступно ли шифрование вообще (нативное или резервное).
 * Проверка нужна data-слою: без генератора случайных чисел шифровать нельзя.
 */
export function isCryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function';
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return fallback.randomBytes(length);
}

// --- base64 (chunked — безопасно для больших медиа) --------------------------

function toBase64(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// --- JWK ---------------------------------------------------------------------

/**
 * Оставляем только обязательные поля JWK. Экспортированный ключ содержит
 * key_ops/ext, из-за которых разные браузеры по-разному валидируют usages
 * при importKey. Чистый JWK импортируется предсказуемо везде.
 */
function sanitizePrivateJwk(jwk: JsonWebKey): JsonWebKey {
  return { kty: 'EC', crv: CURVE, x: jwk.x, y: jwk.y, d: jwk.d };
}

function sanitizePublicJwk(jwk: JsonWebKey): JsonWebKey {
  return { kty: 'EC', crv: CURVE, x: jwk.x, y: jwk.y };
}

/** Публичная часть из приватного JWK — всегда соответствует приватному ключу */
export function publicJwkFromPrivate(jwk: JsonWebKey): JsonWebKey | null {
  if (!jwk.x || !jwk.y) return null;
  return sanitizePublicJwk(jwk);
}

// --- ключи пользователя -------------------------------------------------------

export interface UserKeys {
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

/**
 * Генерация пары ключей ECDH P-256.
 * Оба ключа создаются с extractable: true — иначе exportKey бросит исключение
 * и приватный ключ некуда будет сохранить. Без Web Crypto используется
 * резервная реализация, выдающая такие же JWK.
 */
export async function generateUserKeys(): Promise<UserKeys> {
  if (hasWebCrypto()) {
    const pair = await crypto.subtle.generateKey(ECDH_GENERATE, true, ['deriveBits']);
    const publicKeyJwk = sanitizePublicJwk(await crypto.subtle.exportKey('jwk', pair.publicKey));
    const privateKeyJwk = sanitizePrivateJwk(await crypto.subtle.exportKey('jwk', pair.privateKey));
    if (!publicKeyJwk.x || !privateKeyJwk.d) {
      throw new Error('Не удалось экспортировать ключи ECDH');
    }
    return { publicKeyJwk, privateKeyJwk };
  }
  return fallback.generateKeyPairJwk();
}

/** Публичный ключ, соответствующий приватному (d * G) */
export async function derivePublicKeyJwk(privateJwk: JsonWebKey): Promise<JsonWebKey | null> {
  if (!privateJwk.d) return null;
  if (hasWebCrypto()) {
    try {
      const key = await crypto.subtle.importKey('jwk', sanitizePrivateJwk(privateJwk), ECDH_IMPORT, true, [
        'deriveBits',
      ]);
      return sanitizePublicJwk(await crypto.subtle.exportKey('jwk', key));
    } catch {
      return null;
    }
  }
  return fallback.publicKeyFromPrivate(privateJwk);
}

function keyStorageName(userId: string): string {
  return `svyaz.keys.${userId}`;
}

/** Приватный ключ пользователя из localStorage */
export function getPrivateKey(userId: string): JsonWebKey | null {
  try {
    const raw = window.localStorage.getItem(keyStorageName(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as JsonWebKey;
    return parsed && typeof parsed.d === 'string' && parsed.d ? parsed : null;
  } catch {
    return null;
  }
}

export function hasPrivateKey(userId: string): boolean {
  return getPrivateKey(userId) !== null;
}

export function savePrivateKey(userId: string, jwk: JsonWebKey): void {
  window.localStorage.setItem(keyStorageName(userId), JSON.stringify(jwk));
}

/** Удалить приватный ключ пользователя с устройства (выход из аккаунта). */
export function clearPrivateKey(userId: string): void {
  try {
    window.localStorage.removeItem(keyStorageName(userId));
  } catch {
    /* приватный ключ и так недоступен */
  }
}

// --- переносимость ключа: шифрование приватного ключа паролем ------------------

/** SHA-256 в байтах (32) — для вывода ключа шифрования из пароля */
export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (hasWebCrypto()) {
    // digest() принимает BufferSource — копируем в новый ArrayBuffer явно.
    const buf = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return new Uint8Array(digest);
  }
  return fallback.sha256(data);
}

/** 32-байтовый ключ AES-GCM из пароля пользователя (детерминированный) */
export async function deriveKeyFromPassword(password: string): Promise<Uint8Array<ArrayBuffer>> {
  return sha256Bytes(textEncoder.encode(password));
}

/**
 * Зашифровать приватный ключ (JWK-строку) паролем. Формат: base64(iv || ciphertext).
 * Соль не нужна: тот же пароль даёт тот же ключ — это осознанный компромисс для
 * переносимости ключей между устройствами закрытой группы.
 */
export async function encryptPrivateKeyWithPassword(
  privateJwk: JsonWebKey,
  password: string,
): Promise<string> {
  const keyBytes = await deriveKeyFromPassword(password);
  const iv = randomBytes(IV_BYTES);
  const plaintext = textEncoder.encode(JSON.stringify(privateJwk));
  const ciphertext = await aesEncryptBytes(keyBytes, iv, plaintext);
  const out = new Uint8Array(new ArrayBuffer(iv.length + ciphertext.length));
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return toBase64(out);
}

/** Расшифровать приватный ключ из base64(iv || ciphertext) паролем пользователя */
export async function decryptPrivateKeyWithPassword(
  encrypted: string,
  password: string,
): Promise<JsonWebKey> {
  const keyBytes = await deriveKeyFromPassword(password);
  const data = fromBase64(encrypted);
  const iv = data.subarray(0, IV_BYTES);
  const ciphertext = data.subarray(IV_BYTES);
  const plaintext = await aesDecryptBytes(keyBytes, iv, ciphertext);
  const jwk = JSON.parse(textDecoder.decode(plaintext)) as JsonWebKey;
  if (!jwk || typeof jwk.d !== 'string' || !jwk.d) throw new Error('Неверный ключ');
  return sanitizePrivateJwk(jwk);
}

// --- пароли -------------------------------------------------------------------

/** SHA-256 в hex: Web Crypto, при его отсутствии — резервная реализация */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = textEncoder.encode(text);
  if (hasWebCrypto()) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const view = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
    return hex;
  }
  return fallback.bytesToHex(fallback.sha256(bytes));
}

/** SHA-256(login + ':' + password) в hex — формат хранения с первой версии */
export async function hashPassword(login: string, password: string): Promise<string> {
  return sha256Hex(`${login}:${password}`);
}

// --- низкоуровневые операции ----------------------------------------------------

/** Общий секрет ECDH → 32 байта ключа AES-256 */
async function deriveAesKeyBytes(
  privateJwk: JsonWebKey,
  publicJwk: JsonWebKey,
): Promise<Uint8Array<ArrayBuffer>> {
  if (hasWebCrypto()) {
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      sanitizePrivateJwk(privateJwk),
      ECDH_IMPORT,
      false,
      ['deriveBits'],
    );
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      sanitizePublicJwk(publicJwk),
      ECDH_IMPORT,
      false,
      [],
    );
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
    return new Uint8Array(bits);
  }
  return fallback.deriveSharedSecret(privateJwk, publicJwk);
}

async function aesEncryptBytes(
  keyBytes: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (hasWebCrypto()) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: AES_ALGO }, false, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt({ name: AES_ALGO, iv }, key, data);
    return new Uint8Array(ciphertext);
  }
  return fallback.aesGcmEncrypt(keyBytes, iv, data);
}

async function aesDecryptBytes(
  keyBytes: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (hasWebCrypto()) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: AES_ALGO }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: AES_ALGO, iv }, key, data);
    return new Uint8Array(plaintext);
  }
  return fallback.aesGcmDecrypt(keyBytes, iv, data);
}

/** Завернуть ключ контента: AES-GCM ключом-обёрткой, IV всегда новый */
async function wrapKeyBytes(
  wrappingKey: Uint8Array<ArrayBuffer>,
  rawKey: Uint8Array<ArrayBuffer>,
): Promise<{ wrapped: string; iv: string }> {
  const iv = randomBytes(IV_BYTES);
  const wrapped = await aesEncryptBytes(wrappingKey, iv, rawKey);
  return { wrapped: toBase64(wrapped), iv: toBase64(iv) };
}

async function unwrapKeyBytes(
  wrappingKey: Uint8Array<ArrayBuffer>,
  wrappedB64: string,
  ivB64: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return aesDecryptBytes(wrappingKey, fromBase64(ivB64), fromBase64(wrappedB64));
}

// --- проверка пары ------------------------------------------------------------

export type KeyPairStatus = 'ok' | 'missing' | 'mismatch';

export interface KeyPairCheckOptions {
  /**
   * 'full' — вывести публичный ключ из приватного И проверить ECDH-обмен
   *          с одноразовой парой (вход пользователя);
   * 'quick' — только вывод публичного ключа (массовое восстановление при старте).
   */
  mode?: 'full' | 'quick';
}

/**
 * Проверяет, что сохранённый приватный ключ действительно соответствует
 * публичному ключу пользователя.
 */
export async function getKeyPairStatus(
  userId: string,
  publicKeyJwk: JsonWebKey | undefined | null,
  options: KeyPairCheckOptions = {},
): Promise<KeyPairStatus> {
  const privateJwk = getPrivateKey(userId);
  if (!privateJwk) return 'missing';
  if (!publicKeyJwk || !publicKeyJwk.x || !publicKeyJwk.y) return 'mismatch';
  if (!isCryptoAvailable()) return 'ok';

  try {
    // 1. Публичный ключ должен выводиться из приватного: Q = d * G
    const derived = await derivePublicKeyJwk(privateJwk);
    if (!derived || derived.x !== publicKeyJwk.x || derived.y !== publicKeyJwk.y) {
      return 'mismatch';
    }
    if ((options.mode ?? 'full') === 'quick') return 'ok';

    // 2. Контрольный ECDH: секрет с двух сторон должен совпасть
    if (hasWebCrypto()) {
      const privateKey = await crypto.subtle.importKey(
        'jwk',
        sanitizePrivateJwk(privateJwk),
        ECDH_IMPORT,
        false,
        ['deriveBits'],
      );
      const ephemeral = await crypto.subtle.generateKey(ECDH_GENERATE, true, ['deriveBits']);
      const myPublic = await crypto.subtle.importKey(
        'jwk',
        sanitizePublicJwk(publicKeyJwk),
        ECDH_IMPORT,
        false,
        [],
      );
      const fromMySide = new Uint8Array(
        await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeral.publicKey }, privateKey, 256),
      );
      const fromOtherSide = new Uint8Array(
        await crypto.subtle.deriveBits({ name: 'ECDH', public: myPublic }, ephemeral.privateKey, 256),
      );
      return sameBytes(fromMySide, fromOtherSide) ? 'ok' : 'mismatch';
    }

    const ephemeral = fallback.generateKeyPairJwk();
    const fromMySide = fallback.deriveSharedSecret(privateJwk, ephemeral.publicKeyJwk);
    const fromOtherSide = fallback.deriveSharedSecret(ephemeral.privateKeyJwk, publicKeyJwk);
    return sameBytes(fromMySide, fromOtherSide) ? 'ok' : 'mismatch';
  } catch {
    return 'mismatch';
  }
}

// Объявлено ниже, чтобы не дублировать сравнение массивов
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// --- публичное API -----------------------------------------------------------

export interface EncryptParams {
  myId: string;
  /** публичный ключ автора (по возможности берём из приватного JWK) */
  myPublicKeyJwk: JsonWebKey;
  /** публичный ключ получателя (для «Избранного» — свой же) */
  peerPublicKeyJwk: JsonWebKey;
  data: string | ArrayBuffer;
}

/** Групповой вариант: ключ контента заворачивается для каждого участника */
export interface EncryptGroupParams {
  myId: string;
  myPublicKeyJwk: JsonWebKey;
  /** публичные ключи всех участников чата (включая себя) */
  members: Array<{ id: string; publicKeyJwk: JsonWebKey }>;
  data: string | ArrayBuffer;
}

/**
 * Зашифровать данные для группы. Контент шифруется одним случайным ключом,
 * который заворачивается ECDH-секретом для каждого участника — приходит
 * в groupKeys. Свою копию ключа кладём в groupKeys[myId].
 */
export async function encryptForGroup(params: EncryptGroupParams): Promise<EnvelopeFields & {
  groupKeys: Record<string, { w: string; i: string }>;
}> {
  const { myId, members, data } = params;
  if (!isCryptoAvailable()) {
    throw new Error('Шифрование недоступно: браузер не даёт доступа к генератору случайных чисел');
  }
  const myPrivateJwk = getPrivateKey(myId);
  if (!myPrivateJwk) throw new Error('Приватный ключ пользователя не найден в этом браузере');

  const contentKey = randomBytes(CONTENT_KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const plaintext =
    typeof data === 'string' ? textEncoder.encode(data) : new Uint8Array(data);
  const ciphertext = await aesEncryptBytes(contentKey, iv, plaintext);

  const groupKeys: Record<string, { w: string; i: string }> = {};
  const seen = new Set<string>();
  for (const m of members) {
    if (!m.publicKeyJwk || !m.publicKeyJwk.x || !m.publicKeyJwk.y || seen.has(m.id)) continue;
    seen.add(m.id);
    const wrapping = await deriveAesKeyBytes(myPrivateJwk, m.publicKeyJwk);
    const { wrapped, iv: wrappedIv } = await wrapKeyBytes(wrapping, contentKey);
    groupKeys[m.id] = { w: wrapped, i: wrappedIv };
  }
  if (Object.keys(groupKeys).length === 0) {
    throw new Error('Нет участников с ключами для группового шифрования');
  }

  return {
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv),
    groupKeys,
  };
}

/**
 * Зашифровать данные для получателя. Возвращает конверт: зашифрованный контент
 * плюс ключ контента, завёрнутый для получателя и для автора.
 */
export async function encryptFor(params: EncryptParams): Promise<EnvelopeFields> {
  const { myId, myPublicKeyJwk, peerPublicKeyJwk, data } = params;

  if (!isCryptoAvailable()) {
    throw new Error('Шифрование недоступно: браузер не даёт доступа к генератору случайных чисел');
  }

  const myPrivateJwk = getPrivateKey(myId);
  if (!myPrivateJwk) throw new Error('Приватный ключ пользователя не найден в этом браузере');
  if (!peerPublicKeyJwk || !peerPublicKeyJwk.x || !peerPublicKeyJwk.y) {
    throw new Error('Собеседник ещё не заходил в приложение. Попросите его войти, чтобы он получил ключи');
  }

  const contentKey = randomBytes(CONTENT_KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const plaintext =
    typeof data === 'string' ? textEncoder.encode(data) : new Uint8Array(data);
  const ciphertext = await aesEncryptBytes(contentKey, iv, plaintext);

  const peerWrappingKey = await deriveAesKeyBytes(myPrivateJwk, peerPublicKeyJwk);
  const forPeer = await wrapKeyBytes(peerWrappingKey, contentKey);

  // Публичный ключ автора берём из приватного JWK: даже если в профиле
  // лежит устаревший ключ, своё сообщение автор прочитает гарантированно.
  const selfPublicJwk = publicJwkFromPrivate(myPrivateJwk) ?? myPublicKeyJwk;
  const selfWrappingKey = await deriveAesKeyBytes(myPrivateJwk, selfPublicJwk);
  const forSelf = await wrapKeyBytes(selfWrappingKey, contentKey);

  return {
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv),
    wrappedKey: forPeer.wrapped,
    wrappedKeyIv: forPeer.iv,
    wrappedSelfKey: forSelf.wrapped,
    wrappedSelfKeyIv: forSelf.iv,
  };
}

export interface DecryptParams {
  myId: string;
  /** own=true → читаем своё сообщение */
  own: boolean;
  /** публичный ключ автора сообщения */
  senderPublicKeyJwk: JsonWebKey;
  /**
   * Публичный ключ собеседника. Нужен для чтения собственных сообщений
   * старого формата (без wrappedSelfKey).
   */
  peerPublicKeyJwk?: JsonWebKey;
  envelope: EnvelopeFields;
}

/**
 * Расшифровать групповое сообщение: ключ контента берётся из groupKeys[myId],
 * завёрнутый ECDH(приватный автора, мой публичный) — разворачивается
 * ECDH(мой приватный, публичный автора). Автор и получатели читают одинаково.
 */
export async function decryptGroupEnvelope(params: {
  myId: string;
  senderPublicKeyJwk: JsonWebKey;
  groupKeys: Record<string, { w: string; i: string }> | undefined;
  envelope: EnvelopeFields;
}): Promise<Uint8Array<ArrayBuffer>> {
  const { myId, senderPublicKeyJwk, groupKeys, envelope } = params;
  if (!isCryptoAvailable()) throw new Error('Шифрование недоступно в этом браузере');
  const myPrivateJwk = getPrivateKey(myId);
  if (!myPrivateJwk) throw new Error('Приватный ключ пользователя не найден в этом браузере');
  const mine = groupKeys?.[myId];
  if (!mine || !mine.w || !mine.i) throw new Error('Нет ключа для этого участника');

  const wrappingKey = await deriveAesKeyBytes(myPrivateJwk, senderPublicKeyJwk);
  const contentKey = await unwrapKeyBytes(wrappingKey, mine.w, mine.i);
  return aesDecryptBytes(contentKey, fromBase64(envelope.iv), fromBase64(envelope.ciphertext));
}

async function decryptWithWrappingKey(
  wrappingKey: Uint8Array<ArrayBuffer>,
  envelope: EnvelopeFields,
  wrappedB64?: string,
  wrappedIvB64?: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = fromBase64(envelope.iv);
  const ciphertext = fromBase64(envelope.ciphertext);
  if (wrappedB64 && wrappedIvB64) {
    const contentKey = await unwrapKeyBytes(wrappingKey, wrappedB64, wrappedIvB64);
    return aesDecryptBytes(contentKey, iv, ciphertext);
  }
  // самый старый формат: ключ контента не заворачивался, работал сам ECDH-секрет
  return aesDecryptBytes(wrappingKey, iv, ciphertext);
}

/**
 * Расшифровать конверт. Возвращает сырые байты (текст или медиа).
 * Перебирает совместимые варианты ключа, чтобы читались и старые сообщения.
 */
export async function decryptEnvelope(params: DecryptParams): Promise<Uint8Array<ArrayBuffer>> {
  const { myId, own, senderPublicKeyJwk, peerPublicKeyJwk, envelope } = params;

  if (!isCryptoAvailable()) {
    throw new Error('Шифрование недоступно в этом браузере');
  }

  const myPrivateJwk = getPrivateKey(myId);
  if (!myPrivateJwk) throw new Error('Приватный ключ пользователя не найден в этом браузере');
  if (!envelope.ciphertext || !envelope.iv) {
    throw new Error('Сообщение не содержит шифротекста');
  }

  // Групповое сообщение: ключ контента лежит в groupKeys — заворачивается
  // и разворачивается иначе, чем в личном конверте. Пробуем сначала его.
  const groupKeys = (envelope as EnvelopeFields & { groupKeys?: Record<string, { w: string; i: string }> })
    .groupKeys;
  if (groupKeys && groupKeys[myId]) {
    return decryptGroupEnvelope({
      myId,
      senderPublicKeyJwk,
      groupKeys,
      envelope,
    });
  }

  const attempts: Array<() => Promise<Uint8Array<ArrayBuffer>>> = [];

  if (own) {
    const selfPublicJwk = publicJwkFromPrivate(myPrivateJwk) ?? senderPublicKeyJwk;
    // 1. Текущий формат: ключ автора, завёрнутый на собственный ECDH-секрет
    if (envelope.wrappedSelfKey && envelope.wrappedSelfKeyIv) {
      const wrappedSelfKey = envelope.wrappedSelfKey;
      const wrappedSelfKeyIv = envelope.wrappedSelfKeyIv;
      attempts.push(async () => {
        const wrapping = await deriveAesKeyBytes(myPrivateJwk, selfPublicJwk);
        return decryptWithWrappingKey(wrapping, envelope, wrappedSelfKey, wrappedSelfKeyIv);
      });
    }
    // 2. Старый формат: ключ, завёрнутый на секрет «я ↔ собеседник»
    const peerJwk = peerPublicKeyJwk ?? senderPublicKeyJwk;
    if (envelope.wrappedKey && envelope.wrappedKeyIv) {
      const wrappedKey = envelope.wrappedKey;
      const wrappedKeyIv = envelope.wrappedKeyIv;
      attempts.push(async () => {
        const wrapping = await deriveAesKeyBytes(myPrivateJwk, peerJwk);
        return decryptWithWrappingKey(wrapping, envelope, wrappedKey, wrappedKeyIv);
      });
    }
    // 3. Совсем старый формат: без завёрнутого ключа
    attempts.push(async () => {
      const wrapping = await deriveAesKeyBytes(myPrivateJwk, peerJwk);
      return decryptWithWrappingKey(wrapping, envelope);
    });
  } else {
    // Входящее: ключ завёрнут на ECDH(приватный автора, мой публичный).
    // Если ключ автора в профиле устарел, пробуем ещё и с публичным ключом
    // собеседника — на случай старых сообщений, отправленных до пересоздания пары.
    const candidates: JsonWebKey[] = [senderPublicKeyJwk];
    if (peerPublicKeyJwk && peerPublicKeyJwk.x && peerPublicKeyJwk.y) {
      candidates.push(peerPublicKeyJwk);
    }
    for (const senderJwk of candidates) {
      if (!senderJwk || !senderJwk.x || !senderJwk.y) continue;
      attempts.push(async () => {
        const wrapping = await deriveAesKeyBytes(myPrivateJwk, senderJwk);
        return decryptWithWrappingKey(
          wrapping,
          envelope,
          envelope.wrappedKey,
          envelope.wrappedKeyIv,
        );
      });
    }
  }

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Не удалось расшифровать сообщение');
}

/** Удобная обёртка: конверт → строка */
export async function decryptEnvelopeToString(params: DecryptParams): Promise<string> {
  const bytes = await decryptEnvelope(params);
  return textDecoder.decode(bytes);
}

// --- мастер-ключ ---------------------------------------------------------------

/** Случайный мастер-ключ AES-GCM 256 (base64). */
export function generateMasterKey(): string {
  return toBase64(randomBytes(32));
}

/** Зашифровать произвольную строку паролем: base64(iv || ciphertext). */
export async function encryptSecretWithPassword(value: string, password: string): Promise<string> {
  const keyBytes = await deriveKeyFromPassword(password);
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await aesEncryptBytes(keyBytes, iv, textEncoder.encode(value));
  const out = new Uint8Array(new ArrayBuffer(iv.length + ciphertext.length));
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return toBase64(out);
}

/** Расшифровать строку, зашифрованную паролем. */
export async function decryptSecretWithPassword(encrypted: string, password: string): Promise<string> {
  const keyBytes = await deriveKeyFromPassword(password);
  const data = fromBase64(encrypted);
  const iv = data.subarray(0, IV_BYTES);
  const ciphertext = data.subarray(IV_BYTES);
  const plaintext = await aesDecryptBytes(keyBytes, iv, ciphertext);
  return textDecoder.decode(plaintext);
}

/** Зашифровать приватный ключ мастер-ключом. */
export async function encryptWithMasterKey(
  value: string,
  masterKeyB64: string,
): Promise<string> {
  const keyBytes = fromBase64(masterKeyB64);
  if (keyBytes.length !== 32) throw new Error('Мастер-ключ должен быть 32 байта');
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await aesEncryptBytes(keyBytes, iv, textEncoder.encode(value));
  const out = new Uint8Array(new ArrayBuffer(iv.length + ciphertext.length));
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return toBase64(out);
}

/** Расшифровать приватный ключ мастер-ключом. */
export async function decryptWithMasterKey(
  encrypted: string,
  masterKeyB64: string,
): Promise<string> {
  const keyBytes = fromBase64(masterKeyB64);
  const data = fromBase64(encrypted);
  const iv = data.subarray(0, IV_BYTES);
  const ciphertext = data.subarray(IV_BYTES);
  const plaintext = await aesDecryptBytes(keyBytes, iv, ciphertext);
  return textDecoder.decode(plaintext);
}
