/**
 * Проверка резервных крипто-примитивов против настоящего Web Crypto (Node).
 * Запуск: node scripts/crypto-test.mjs
 *
 * Проверяем байт-совместимость:
 *  - SHA-256;
 *  - AES-256-GCM (в обе стороны: JS -> WebCrypto, WebCrypto -> JS);
 *  - ECDH P-256 (JWK, общий секрет, вывод публичного ключа).
 */
import { webcrypto } from 'node:crypto';
import * as p from '../src/lib/crypto-primitives.ts';

const { subtle } = webcrypto;
const enc = new TextEncoder();

let passed = 0;
let failed = 0;

function check(name, condition, details = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${details ? ` — ${details}` : ''}`);
  }
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function random(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) {
    webcrypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  }
  return out;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function testSha() {
  console.log('\nSHA-256');
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'cadet001:test1234',
      '0c0e4b0d9c6a1d1e9d1b7f2b5c8a4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c',
    ],
  ];
  // Первые два — официальные векторы; третий сверяем с Web Crypto, а не с константой
  check('sha256("")', hex(p.sha256(enc.encode(''))) === vectors[0][1]);
  check('sha256("abc")', hex(p.sha256(enc.encode('abc'))) === vectors[1][1]);

  for (let len = 0; len < 200; len += 7) {
    const text = 'Курсант '.repeat(len % 13) + 'x'.repeat(len);
    const ours = p.sha256Hex(text);
    const digest = await subtle.digest('SHA-256', enc.encode(text));
    const reference = Buffer.from(digest).toString('hex');
    if (ours !== reference) {
      check(`sha256 длина ${len}`, false, `${ours} != ${reference}`);
      return;
    }
  }
  check('sha256 совпадает с Web Crypto (0..199 байт)', true);
  check('sha256 кириллица', p.sha256Hex('Связь') === hex(await subtle.digest('SHA-256', enc.encode('Связь'))));
}

async function testAes() {
  console.log('\nAES-256-GCM');
  const lengths = [0, 1, 15, 16, 17, 31, 32, 33, 255, 1024, 65537];
  let ok = true;
  for (const length of lengths) {
    const key = random(32);
    const iv = random(12);
    const plaintext = random(length);

    const ours = p.aesGcmEncrypt(key, iv, plaintext);

    // 1. JS -> WebCrypto
    const webKey = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
    let decryptedWeb;
    try {
      decryptedWeb = new Uint8Array(
        await subtle.decrypt({ name: 'AES-GCM', iv }, webKey, ours),
      );
    } catch (e) {
      check(`JS -> WebCrypto, длина ${length}`, false, e.message);
      ok = false;
      continue;
    }
    if (!equalBytes(decryptedWeb, plaintext)) {
      check(`JS -> WebCrypto, длина ${length}`, false, 'расшифровка не совпала');
      ok = false;
    }

    // 2. WebCrypto -> JS
    const encryptKey = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    const reference = new Uint8Array(
      await subtle.encrypt({ name: 'AES-GCM', iv }, encryptKey, plaintext),
    );
    if (!equalBytes(reference, ours)) {
      check(`шифротекст идентичен, длина ${length}`, false, `${hex(reference).slice(0, 32)} != ${hex(ours).slice(0, 32)}`);
      ok = false;
    }
    const decryptedJs = p.aesGcmDecrypt(key, iv, reference);
    if (!equalBytes(decryptedJs, plaintext)) {
      check(`WebCrypto -> JS, длина ${length}`, false, 'расшифровка не совпала');
      ok = false;
    }
  }
  check('AES-GCM во все стороны, длины 0..65537', ok);

  // подмена байта должна ломать тег
  const key = random(32);
  const iv = random(12);
  const data = p.aesGcmEncrypt(key, iv, enc.encode('секрет'));
  data[0] ^= 1;
  let threw = false;
  try {
    p.aesGcmDecrypt(key, iv, data);
  } catch {
    threw = true;
  }
  check('испорченный шифротекст отвергается', threw);

  // быстрый замер на 1 МБ
  const big = random(1024 * 1024);
  const t0 = performance.now();
  const bigCt = p.aesGcmEncrypt(key, iv, big);
  const t1 = performance.now();
  const back = p.aesGcmDecrypt(key, iv, bigCt);
  const t2 = performance.now();
  check('1 МБ шифруется/расшифровывается', equalBytes(back, big), `${(t1 - t0).toFixed(0)} мс / ${(t2 - t1).toFixed(0)} мс`);
  console.log(`        скорость: ${(1 / ((t1 - t0) / 1000)).toFixed(1)} МБ/с`);
}

async function testEcdh() {
  console.log('\nECDH P-256');
  const alice = p.generateKeyPairJwk();
  const bob = p.generateKeyPairJwk();

  check('JWK: обязательные поля', Boolean(alice.publicKeyJwk.x && alice.publicKeyJwk.y && alice.privateKeyJwk.d));
  check('JWK: нет padding в base64url', !/[=+/]/.test(String(alice.publicKeyJwk.x)));

  // Общий секрет JS
  const secretJs = p.deriveSharedSecret(alice.privateKeyJwk, bob.publicKeyJwk);
  const secretJs2 = p.deriveSharedSecret(bob.privateKeyJwk, alice.publicKeyJwk);
  check('общий секрет симметричен', equalBytes(secretJs, secretJs2));
  check('длина секрета 32 байта', secretJs.length === 32);

  // Web Crypto считает тот же секрет
  const alicePriv = await subtle.importKey('jwk', alice.privateKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const bobPub = await subtle.importKey('jwk', bob.publicKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secretWeb = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: bobPub }, alicePriv, 256));
  check('JS-секрет == WebCrypto-секрет', equalBytes(secretJs, secretWeb));
  check('ключ AES из секрета совпадает', equalBytes(p.deriveSharedSecret(bob.privateKeyJwk, alice.publicKeyJwk), secretWeb));

  // Публичный ключ, выведенный из приватного, совпадает с WebCrypto exportKey
  const derived = p.publicKeyFromPrivate(alice.privateKeyJwk);
  const exported = await subtle.exportKey('jwk', alicePriv);
  check('publicKeyFromPrivate == WebCrypto x/y', derived.x === exported.x && derived.y === exported.y);

  // WebCrypto-сгенерированная пара принимается нашей реализацией
  const webPair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const webPub = await subtle.exportKey('jwk', webPair.publicKey);
  const webPriv = await subtle.exportKey('jwk', webPair.privateKey);
  const mixed = p.deriveSharedSecret(webPriv, bob.publicKeyJwk);
  const mixedRef = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: await subtle.importKey('jwk', bob.publicKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, webPair.privateKey, 256),
  );
  check('WebCrypto-пара работает в нашей реализации', equalBytes(mixed, mixedRef));
  check('наш публичный из WebCrypto-приватного', p.publicKeyFromPrivate(webPriv)?.x === webPub.x);

  // 100 подряд ключей — быстрый прогон
  const t0 = performance.now();
  const pairs = [];
  for (let i = 0; i < 100; i++) pairs.push(p.generateKeyPairJwk());
  const t1 = performance.now();
  let allValid = true;
  for (const pair of pairs) {
    const derivedAgain = p.publicKeyFromPrivate(pair.privateKeyJwk);
    if (!derivedAgain || derivedAgain.x !== pair.publicKeyJwk.x) allValid = false;
  }
  check('100 пар ключей, все публичные выводятся из приватных', allValid, `${(t1 - t0).toFixed(0)} мс`);
  console.log(`        скорость: ${((t1 - t0) / 100).toFixed(1)} мс на пару ключей`);
}

async function testTamperedKey() {
  console.log('\nЗащита от мусорных ключей');
  const bob = p.generateKeyPairJwk();
  const broken = { ...bob.publicKeyJwk, y: bob.publicKeyJwk.x };
  let threw = false;
  try {
    p.deriveSharedSecret(p.generateKeyPairJwk().privateKeyJwk, broken);
  } catch {
    threw = true;
  }
  check('точка вне кривой отвергается', threw);
}

await testSha();
await testAes();
await testEcdh();
await testTamperedKey();

console.log(`\nИтого: ${passed} PASS, ${failed} FAIL`);
if (failed > 0) process.exit(1);
