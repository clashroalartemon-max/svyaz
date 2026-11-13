/**
 * Резервные примитивы шифрования на чистом TypeScript — без Web Crypto.
 *
 * ЗАЧЕМ ЭТО НУЖНО.
 * `crypto.subtle` существует только в «безопасном контексте»: https:// или
 * http://localhost. Если открыть приложение с телефона по http://192.168.x.x,
 * объекта `crypto.subtle` в браузере просто нет. Без резервной реализации там
 * не работают ни вход (SHA-256), ни E2EE (ECDH + AES-GCM) — именно поэтому
 * телефон отвечал «Неверный логин или пароль»: seed падал на первом же
 * пользователе, база оставалась пустой.
 *
 * РЕАЛИЗАЦИЯ БАЙТ-СОВМЕСТИМА С WEB CRYPTO:
 *  • SHA-256 — стандартный;
 *  • ECDH P-256 — ключи в формате JWK (kty/crv/x/y/d, base64url), общий секрет =
 *    X-координата точки, 32 байта;
 *  • AES-256-GCM — шифротекст || 16-байтовый тег, IV 12 байт.
 * Поэтому всё, что зашифровано здесь, читается через Web Crypto, и наоборот:
 * один и тот же localStorage можно открыть в защищённом и незащищённом
 * контексте без потери истории.
 *
 * Код намеренно написан без сторонних библиотек и без `eval`.
 */

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Общие утилиты
// ---------------------------------------------------------------------------

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(length));
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('Криптографический генератор случайных чисел недоступен');
  }
  // getRandomValues работает и в незащищённом контексте — в отличие от subtle
  crypto.getRandomValues(out);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(length));
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// base64url (как в JWK: без padding, '+' → '-', '/' → '_')
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + pad);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** SHA-256, возвращает 32 байта */
export function sha256(message: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = message.length;
  // padding: 0x80, нули, 8 байт длины в битах (big-endian)
  const paddedLength = (((length + 9 + 63) >> 6) << 6) >>> 0;
  const padded = new Uint8Array(new ArrayBuffer(paddedLength));
  padded.set(message);
  padded[length] = 0x80;

  const bitLength = BigInt(length) * 8n;
  for (let i = 0; i < 8; i++) {
    padded[paddedLength - 1 - i] = Number((bitLength >> BigInt(8 * i)) & 0xffn);
  }

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let t = 0; t < 16; t++) {
      const i = offset + t * 4;
      w[t] = ((padded[i] << 24) | (padded[i + 1] << 16) | (padded[i + 2] << 8) | padded[i + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = (rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)) >>> 0;
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let t = 0; t < 64; t++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (h[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (h[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (h[i] >>> 8) & 0xff;
    out[i * 4 + 3] = h[i] & 0xff;
  }
  return out;
}

/** SHA-256 строки (UTF-8) в hex — используется для хэша пароля */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(textEncoder.encode(text)));
}

// ---------------------------------------------------------------------------
// AES-256 (шифрование блока) + GCM
// ---------------------------------------------------------------------------

function xtime(a: number): number {
  return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
}

/** S-box AES: мультипликативное обратное в GF(2^8) + аффинное преобразование */
const SBOX = (() => {
  const exp = new Uint8Array(510);
  const log = new Uint8Array(256);
  let v = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = v;
    log[v] = i;
    const doubled = xtime(v);
    v = doubled ^ v; // умножение на 3 — образующий элемент поля
  }
  for (let i = 255; i < 510; i++) exp[i] = exp[i - 255];

  const inv = new Uint8Array(256);
  for (let i = 1; i < 256; i++) inv[i] = exp[(255 - log[i]) % 255];

  const sbox = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const x = inv[i];
    let s = x;
    let rotated = x;
    for (let j = 0; j < 4; j++) {
      rotated = ((rotated << 1) | (rotated >>> 7)) & 0xff;
      s ^= rotated;
    }
    sbox[i] = s ^ 0x63;
  }
  return sbox;
})();

// Таблицы для быстрого раунда (классическая схема с Te0..Te3)
const TE0 = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  const s = SBOX[i];
  const s2 = xtime(s);
  const s3 = s2 ^ s;
  TE0[i] = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
}
const TE1 = new Uint32Array(256);
const TE2 = new Uint32Array(256);
const TE3 = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  TE1[i] = ((TE0[i] >>> 8) | (TE0[i] << 24)) >>> 0;
  TE2[i] = ((TE1[i] >>> 8) | (TE1[i] << 24)) >>> 0;
  TE3[i] = ((TE2[i] >>> 8) | (TE2[i] << 24)) >>> 0;
}

/** Раскрытие ключа AES-256: 15 раундовых ключей по 4 слова */
function aesExpandKey(key: Uint8Array): Uint32Array {
  if (key.length !== 32) throw new Error('AES-256 требует ключ 32 байта');
  const nk = 8;
  const nr = 14;
  const words = new Uint32Array(4 * (nr + 1));
  for (let i = 0; i < nk; i++) {
    words[i] =
      ((key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3]) >>> 0;
  }
  let rcon = 1;
  for (let i = nk; i < words.length; i++) {
    let temp = words[i - 1];
    if (i % nk === 0) {
      temp = ((temp << 8) | (temp >>> 24)) >>> 0; // RotWord
      temp =
        ((SBOX[temp >>> 24] << 24) |
          (SBOX[(temp >>> 16) & 0xff] << 16) |
          (SBOX[(temp >>> 8) & 0xff] << 8) |
          SBOX[temp & 0xff]) >>>
        0;
      temp = (temp ^ (rcon << 24)) >>> 0;
      rcon = xtime(rcon);
    } else if (i % nk === 4) {
      temp =
        ((SBOX[temp >>> 24] << 24) |
          (SBOX[(temp >>> 16) & 0xff] << 16) |
          (SBOX[(temp >>> 8) & 0xff] << 8) |
          SBOX[temp & 0xff]) >>>
        0;
    }
    words[i] = (words[i - nk] ^ temp) >>> 0;
  }
  return words;
}

/** Один блок AES-256: in/out — 16 байт, состояние собирается как 4 big-endian слова */
function aesEncryptBlock(roundKeys: Uint32Array, input: Uint8Array, output: Uint8Array): void {
  let s0 = ((input[0] << 24) | (input[1] << 16) | (input[2] << 8) | input[3]) ^ roundKeys[0];
  let s1 = ((input[4] << 24) | (input[5] << 16) | (input[6] << 8) | input[7]) ^ roundKeys[1];
  let s2 = ((input[8] << 24) | (input[9] << 16) | (input[10] << 8) | input[11]) ^ roundKeys[2];
  let s3 = ((input[12] << 24) | (input[13] << 16) | (input[14] << 8) | input[15]) ^ roundKeys[3];

  let k = 4;
  for (let round = 0; round < 13; round++) {
    const t0 =
      (TE0[s0 >>> 24] ^ TE1[(s1 >>> 16) & 0xff] ^ TE2[(s2 >>> 8) & 0xff] ^ TE3[s3 & 0xff] ^
        roundKeys[k]) >>>
      0;
    const t1 =
      (TE0[s1 >>> 24] ^ TE1[(s2 >>> 16) & 0xff] ^ TE2[(s3 >>> 8) & 0xff] ^ TE3[s0 & 0xff] ^
        roundKeys[k + 1]) >>>
      0;
    const t2 =
      (TE0[s2 >>> 24] ^ TE1[(s3 >>> 16) & 0xff] ^ TE2[(s0 >>> 8) & 0xff] ^ TE3[s1 & 0xff] ^
        roundKeys[k + 2]) >>>
      0;
    const t3 =
      (TE0[s3 >>> 24] ^ TE1[(s0 >>> 16) & 0xff] ^ TE2[(s1 >>> 8) & 0xff] ^ TE3[s2 & 0xff] ^
        roundKeys[k + 3]) >>>
      0;
    s0 = t0;
    s1 = t1;
    s2 = t2;
    s3 = t3;
    k += 4;
  }

  const o0 =
    ((SBOX[s0 >>> 24] << 24) |
      (SBOX[(s1 >>> 16) & 0xff] << 16) |
      (SBOX[(s2 >>> 8) & 0xff] << 8) |
      SBOX[s3 & 0xff]) ^
    roundKeys[k];
  const o1 =
    ((SBOX[s1 >>> 24] << 24) |
      (SBOX[(s2 >>> 16) & 0xff] << 16) |
      (SBOX[(s3 >>> 8) & 0xff] << 8) |
      SBOX[s0 & 0xff]) ^
    roundKeys[k + 1];
  const o2 =
    ((SBOX[s2 >>> 24] << 24) |
      (SBOX[(s3 >>> 16) & 0xff] << 16) |
      (SBOX[(s0 >>> 8) & 0xff] << 8) |
      SBOX[s1 & 0xff]) ^
    roundKeys[k + 2];
  const o3 =
    ((SBOX[s3 >>> 24] << 24) |
      (SBOX[(s0 >>> 16) & 0xff] << 16) |
      (SBOX[(s1 >>> 8) & 0xff] << 8) |
      SBOX[s2 & 0xff]) ^
    roundKeys[k + 3];

  const words = [o0 >>> 0, o1 >>> 0, o2 >>> 0, o3 >>> 0];
  for (let i = 0; i < 4; i++) {
    const word = words[i];
    output[i * 4] = (word >>> 24) & 0xff;
    output[i * 4 + 1] = (word >>> 16) & 0xff;
    output[i * 4 + 2] = (word >>> 8) & 0xff;
    output[i * 4 + 3] = word & 0xff;
  }
}

// --- GHASH: умножение в GF(2^128) на 4 словах (big-endian) -------------------

type Block = Uint32Array; // длина 4

/** out = x * h в GF(2^128); out не должен совпадать с h */
function gfMultiply(x: Block, h: Block, out: Block): void {
  let z0 = 0;
  let z1 = 0;
  let z2 = 0;
  let z3 = 0;
  let v0 = h[0] >>> 0;
  let v1 = h[1] >>> 0;
  let v2 = h[2] >>> 0;
  let v3 = h[3] >>> 0;

  for (let wordIndex = 0; wordIndex < 4; wordIndex++) {
    const word = x[wordIndex] >>> 0;
    for (let bit = 31; bit >= 0; bit--) {
      if ((word >>> bit) & 1) {
        z0 ^= v0;
        z1 ^= v1;
        z2 ^= v2;
        z3 ^= v3;
      }
      const lsb = v3 & 1;
      v3 = ((v3 >>> 1) | ((v2 & 1) << 31)) >>> 0;
      v2 = ((v2 >>> 1) | ((v1 & 1) << 31)) >>> 0;
      v1 = ((v1 >>> 1) | ((v0 & 1) << 31)) >>> 0;
      v0 = ((v0 >>> 1) ^ (lsb ? 0xe1000000 : 0)) >>> 0;
    }
  }

  out[0] = z0 >>> 0;
  out[1] = z1 >>> 0;
  out[2] = z2 >>> 0;
  out[3] = z3 >>> 0;
}

function blockFromBytes(bytes: Uint8Array, offset: number): Block {
  const block = new Uint32Array(4);
  const p = offset;
  const get = (i: number): number => (p + i < bytes.length ? bytes[p + i] : 0);
  block[0] = ((get(0) << 24) | (get(1) << 16) | (get(2) << 8) | get(3)) >>> 0;
  block[1] = ((get(4) << 24) | (get(5) << 16) | (get(6) << 8) | get(7)) >>> 0;
  block[2] = ((get(8) << 24) | (get(9) << 16) | (get(10) << 8) | get(11)) >>> 0;
  block[3] = ((get(12) << 24) | (get(13) << 16) | (get(14) << 8) | get(15)) >>> 0;
  return block;
}

/** GHASH для GCM без AAD: S = GHASH(0 || C || len(C)) */
function ghash(h: Block, ciphertext: Uint8Array, tagOut: Uint8Array): void {
  const y = new Uint32Array(4);
  const product = new Uint32Array(4);
  const block = new Uint32Array(4);

  for (let offset = 0; offset < ciphertext.length; offset += 16) {
    const b = blockFromBytes(ciphertext, offset);
    y[0] ^= b[0];
    y[1] ^= b[1];
    y[2] ^= b[2];
    y[3] ^= b[3];
    gfMultiply(y, h, product);
    y.set(product);
  }

  // блок длины: 64 бита AAD (0) || 64 бита длины шифротекста в битах
  const bitLength = BigInt(ciphertext.length) * 8n;
  block[0] = 0;
  block[1] = 0;
  block[2] = Number((bitLength >> 32n) & 0xffffffffn) >>> 0;
  block[3] = Number(bitLength & 0xffffffffn) >>> 0;
  y[0] ^= block[0];
  y[1] ^= block[1];
  y[2] ^= block[2];
  y[3] ^= block[3];
  gfMultiply(y, h, product);

  tagOut[0] = (product[0] >>> 24) & 0xff;
  tagOut[1] = (product[0] >>> 16) & 0xff;
  tagOut[2] = (product[0] >>> 8) & 0xff;
  tagOut[3] = product[0] & 0xff;
  tagOut[4] = (product[1] >>> 24) & 0xff;
  tagOut[5] = (product[1] >>> 16) & 0xff;
  tagOut[6] = (product[1] >>> 8) & 0xff;
  tagOut[7] = product[1] & 0xff;
  tagOut[8] = (product[2] >>> 24) & 0xff;
  tagOut[9] = (product[2] >>> 16) & 0xff;
  tagOut[10] = (product[2] >>> 8) & 0xff;
  tagOut[11] = product[2] & 0xff;
  tagOut[12] = (product[3] >>> 24) & 0xff;
  tagOut[13] = (product[3] >>> 16) & 0xff;
  tagOut[14] = (product[3] >>> 8) & 0xff;
  tagOut[15] = product[3] & 0xff;
}

function incrementCounter(counter: Uint8Array): void {
  for (let i = 15; i >= 12; i--) {
    counter[i] = (counter[i] + 1) & 0xff;
    if (counter[i] !== 0) break;
  }
}

/** GCM: шифрование. Возвращает ciphertext || tag (как Web Crypto). */
export function aesGcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (iv.length !== 12) throw new Error('GCM: ожидается IV 12 байт');
  const roundKeys = aesExpandKey(key);

  // H = E_K(0^128)
  const zeroBlock = new Uint8Array(new ArrayBuffer(16));
  const h = new Uint8Array(new ArrayBuffer(16));
  const hBlock = new Uint32Array(4);
  aesEncryptBlock(roundKeys, zeroBlock, h);
  hBlock[0] = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  hBlock[1] = ((h[4] << 24) | (h[5] << 16) | (h[6] << 8) | h[7]) >>> 0;
  hBlock[2] = ((h[8] << 24) | (h[9] << 16) | (h[10] << 8) | h[11]) >>> 0;
  hBlock[3] = ((h[12] << 24) | (h[13] << 16) | (h[14] << 8) | h[15]) >>> 0;

  // J0 = IV || 0x00000001
  const j0 = new Uint8Array(new ArrayBuffer(16));
  j0.set(iv, 0);
  j0[15] = 1;

  const counter = new Uint8Array(new ArrayBuffer(16));
  counter.set(j0);
  const keystream = new Uint8Array(new ArrayBuffer(16));
  const out = new Uint8Array(new ArrayBuffer(plaintext.length + 16));

  let offset = 0;
  while (offset < plaintext.length) {
    incrementCounter(counter);
    aesEncryptBlock(roundKeys, counter, keystream);
    const remaining = plaintext.length - offset;
    const chunk = remaining < 16 ? remaining : 16;
    for (let i = 0; i < chunk; i++) out[offset + i] = plaintext[offset + i] ^ keystream[i];
    offset += chunk;
  }

  // tag = E_K(J0) ^ GHASH(H, C)
  const tag = new Uint8Array(new ArrayBuffer(16));
  ghash(hBlock, out.subarray(0, plaintext.length), tag);
  const encryptedJ0 = new Uint8Array(new ArrayBuffer(16));
  aesEncryptBlock(roundKeys, j0, encryptedJ0);
  for (let i = 0; i < 16; i++) out[plaintext.length + i] = tag[i] ^ encryptedJ0[i];

  return out;
}

/** GCM: расшифровка. Вход — ciphertext || tag. Бросает при неверном теге. */
export function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (iv.length !== 12) throw new Error('GCM: ожидается IV 12 байт');
  if (data.length < 16) throw new Error('GCM: данные короче тега');
  const roundKeys = aesExpandKey(key);

  const zeroBlock = new Uint8Array(new ArrayBuffer(16));
  const h = new Uint8Array(new ArrayBuffer(16));
  const hBlock = new Uint32Array(4);
  aesEncryptBlock(roundKeys, zeroBlock, h);
  hBlock[0] = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  hBlock[1] = ((h[4] << 24) | (h[5] << 16) | (h[6] << 8) | h[7]) >>> 0;
  hBlock[2] = ((h[8] << 24) | (h[9] << 16) | (h[10] << 8) | h[11]) >>> 0;
  hBlock[3] = ((h[12] << 24) | (h[13] << 16) | (h[14] << 8) | h[15]) >>> 0;

  const ciphertext = data.subarray(0, data.length - 16);
  const receivedTag = data.subarray(data.length - 16);

  const j0 = new Uint8Array(new ArrayBuffer(16));
  j0.set(iv, 0);
  j0[15] = 1;

  const tag = new Uint8Array(new ArrayBuffer(16));
  ghash(hBlock, ciphertext, tag);
  const encryptedJ0 = new Uint8Array(new ArrayBuffer(16));
  aesEncryptBlock(roundKeys, j0, encryptedJ0);
  for (let i = 0; i < 16; i++) tag[i] ^= encryptedJ0[i];

  if (!constantTimeEqual(tag, receivedTag)) {
    throw new Error('GCM: неверный тег аутентификации');
  }

  const counter = new Uint8Array(new ArrayBuffer(16));
  counter.set(j0);
  const keystream = new Uint8Array(new ArrayBuffer(16));
  const out = new Uint8Array(new ArrayBuffer(ciphertext.length));

  let offset = 0;
  while (offset < ciphertext.length) {
    incrementCounter(counter);
    aesEncryptBlock(roundKeys, counter, keystream);
    const remaining = ciphertext.length - offset;
    const chunk = remaining < 16 ? remaining : 16;
    for (let i = 0; i < chunk; i++) out[offset + i] = ciphertext[offset + i] ^ keystream[i];
    offset += chunk;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ECDH P-256
// ---------------------------------------------------------------------------

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const A = P - 3n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

function mod(value: bigint, modulus: bigint = P): bigint {
  const r = value % modulus;
  return r >= 0n ? r : r + modulus;
}

function modInverse(value: bigint, modulus: bigint): bigint {
  let oldR = mod(value, modulus);
  let r = modulus;
  let oldS = 1n;
  let s = 0n;
  while (r !== 0n) {
    const q = oldR / r;
    const nextR = oldR - q * r;
    oldR = r;
    r = nextR;
    const nextS = oldS - q * s;
    oldS = s;
    s = nextS;
  }
  if (oldR !== 1n) throw new Error('Точка не лежит на кривой');
  return mod(oldS, modulus);
}

interface AffinePoint {
  x: bigint;
  y: bigint;
}

interface JacobianPoint {
  x: bigint;
  y: bigint;
  z: bigint;
}

const INFINITY: JacobianPoint = { x: 0n, y: 1n, z: 0n };

function isInfinity(p: JacobianPoint): boolean {
  return p.z === 0n;
}

function jacobianDouble(p: JacobianPoint): JacobianPoint {
  if (isInfinity(p) || p.y === 0n) return INFINITY;
  const yy = mod(p.y * p.y);
  const s = mod(4n * p.x * yy);
  const zz = mod(p.z * p.z);
  const m = mod(3n * p.x * p.x + A * mod(zz * zz));
  const x3 = mod(m * m - 2n * s);
  const y3 = mod(m * (s - x3) - 8n * yy * yy);
  const z3 = mod(2n * p.y * p.z);
  return { x: x3, y: y3, z: z3 };
}

function jacobianAdd(p: JacobianPoint, q: JacobianPoint): JacobianPoint {
  if (isInfinity(p)) return q;
  if (isInfinity(q)) return p;

  const z1z1 = mod(p.z * p.z);
  const z2z2 = mod(q.z * q.z);
  const u1 = mod(p.x * z2z2);
  const u2 = mod(q.x * z1z1);
  const s1 = mod(p.y * z2z2 * q.z);
  const s2 = mod(q.y * z1z1 * p.z);

  if (u1 === u2) {
    if (s1 !== s2) return INFINITY; // P + (-P)
    return jacobianDouble(p);
  }

  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const hh = mod(h * h);
  const hhh = mod(h * hh);
  const x3 = mod(r * r - hhh - 2n * u1 * hh);
  const y3 = mod(r * (u1 * hh - x3) - s1 * hhh);
  const z3 = mod(h * p.z * q.z);
  return { x: x3, y: y3, z: z3 };
}

function scalarMultiply(k: bigint, point: AffinePoint): AffinePoint {
  let result = INFINITY;
  let addend: JacobianPoint = { x: point.x, y: point.y, z: 1n };
  let scalar = mod(k, N);
  while (scalar > 0n) {
    if (scalar & 1n) result = jacobianAdd(result, addend);
    addend = jacobianDouble(addend);
    scalar >>= 1n;
  }
  if (isInfinity(result)) throw new Error('Результат умножения — бесконечность');
  const zInv = modInverse(result.z, P);
  const zInv2 = mod(zInv * zInv);
  return { x: mod(result.x * zInv2), y: mod(result.y * zInv2 * zInv) };
}

function isOnCurve(point: AffinePoint): boolean {
  if (point.x < 0n || point.x >= P || point.y < 0n || point.y >= P) return false;
  const left = mod(point.y * point.y);
  const right = mod(point.x * point.x * point.x + A * point.x + B);
  return left === right;
}

function pointFromJwk(jwk: JsonWebKey): AffinePoint {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('Некорректный публичный ключ');
  }
  const point = { x: bytesToBigInt(fromBase64Url(jwk.x)), y: bytesToBigInt(fromBase64Url(jwk.y)) };
  if (!isOnCurve(point)) throw new Error('Публичный ключ не лежит на кривой P-256');
  return point;
}

function pointToJwk(point: AffinePoint): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: toBase64Url(bigIntToBytes(point.x, 32)),
    y: toBase64Url(bigIntToBytes(point.y, 32)),
  };
}

/** Случайный скаляр d ∈ [1, n-1] */
function randomScalar(): bigint {
  for (;;) {
    const candidate = bytesToBigInt(randomBytes(32));
    if (candidate >= 1n && candidate < N) return candidate;
  }
}

export interface FallbackKeyPair {
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

/** Пара ключей ECDH P-256 в формате JWK (совместима с Web Crypto) */
export function generateKeyPairJwk(): FallbackKeyPair {
  const d = randomScalar();
  const point = scalarMultiply(d, { x: GX, y: GY });
  const publicKeyJwk = pointToJwk(point);
  return {
    publicKeyJwk,
    privateKeyJwk: { ...publicKeyJwk, d: toBase64Url(bigIntToBytes(d, 32)) },
  };
}

/** Публичный ключ, выведенный из приватного: d * G */
export function publicKeyFromPrivate(privateJwk: JsonWebKey): JsonWebKey | null {
  if (typeof privateJwk.d !== 'string' || !privateJwk.d) return null;
  const d = bytesToBigInt(fromBase64Url(privateJwk.d));
  if (d < 1n || d >= N) return null;
  return pointToJwk(scalarMultiply(d, { x: GX, y: GY }));
}

/** Общий секрет ECDH — X-координата, 32 байта (ровно то, что даёт Web Crypto) */
export function deriveSharedSecret(
  privateJwk: JsonWebKey,
  publicJwk: JsonWebKey,
): Uint8Array<ArrayBuffer> {
  if (typeof privateJwk.d !== 'string' || !privateJwk.d) {
    throw new Error('Приватный ключ некорректен');
  }
  const d = bytesToBigInt(fromBase64Url(privateJwk.d));
  if (d < 1n || d >= N) throw new Error('Приватный ключ вне диапазона P-256');
  const peer = pointFromJwk(publicJwk);
  const shared = scalarMultiply(d, peer);
  return bigIntToBytes(shared.x, 32);
}

/** Для тестов и диагностики: зафиксировать склейку байтов без копирования */
export function joinBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return concatBytes(...parts);
}
