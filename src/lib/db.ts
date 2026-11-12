/**
 * Слой данных «Связи» поверх Supabase.
 *
 * Раньше всё лежало в localStorage — из-за этого два устройства жили в двух
 * разных мирах. Теперь общий источник правды — Postgres в Supabase, а локально
 * остаются только приватные ключи шифрования (они не должны покидать устройство)
 * и текущая сессия.
 *
 * Имена функций и их сигнатуры сохранены: компоненты не пришлось переписывать.
 */

import * as storage from './storage';
import { supabase, setSupabaseUser } from './supabase';
import { emit } from './bus';
import { broadcastChat, broadcastMessage, sendTyping } from './realtime';
import {
  decryptEnvelope,
  decryptEnvelopeToString,
  encryptFor,
  generateUserKeys,
  getKeyPairStatus,
  getPrivateKey,
  hashPassword,
  isCryptoAvailable,
  savePrivateKey,
} from './crypto';
import type { KeyPairStatus } from './crypto';
import type {
  Chat,
  ChatListItem,
  EnvelopeFields,
  Message,
  MessageStatus,
  MessageType,
  Role,
  ThemeMode,
  User,
} from '../types';
import type { TypingPayload } from './bus';

// Клиент должен знать, кто мы, ещё до первого запроса (RLS читает x-user-id).
setSupabaseUser(storage.getCurrentUserId());

// Сессия живёт в localStorage: вход/выход в одной вкладке подхватывают остальные.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== storage.CURRENT_USER_KEY) return;
    const next = storage.getCurrentUserId();
    setSupabaseUser(next);
    emit('auth:changed', next);
  });
}

const KEYS_REV = '3';

export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

/** Нормализация ФИО/группы для поиска: регистр, ё→е, лишние пробелы */
function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

/**
 * ID для всех таблиц (profiles, chats, messages, media).
 * Колонки в Supabase имеют тип uuid, поэтому fallback обязан возвращать
 * именно UUID v4 в каноническом формате — иначе Postgres отклонит вставку.
 * randomUUID есть только в secure context (https/localhost), поэтому для
 * http://<IP> собираем v4 вручную из getRandomValues.
 *
 * Экспорт: идентификаторы не должны генерироваться заново в компонентах,
 * иначе легко получить невалидный UUID, который Postgres отклонит
 * (ошибка `invalid input syntax for type uuid`).
 */
export function uid(): string {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    if (typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // версия 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // вариант RFC 4122
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  }
  // Последний резерв (очень старый браузер): тоже валидный UUID v4.
  const hex = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
  return hex;
}

/**
 * Достаём data или бросаем ошибку с текстом от Supabase.
 * data типизирован как unknown: supabase-js без сгенерированных типов БД
 * выводит объединение с GenericStringError, и прямое приведение к строке
 * таблицы ломает tsc.
 */
async function unwrap<T>(
  promise: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data as T;
}

// --- пользователи -------------------------------------------------------------
// Пароль в profiles НЕ лежит: он в отдельной таблице credentials, которую
// нельзя прочитать через REST (RLS без политик). Проверка и смена пароля —
// только через SECURITY DEFINER-функции verify_login / change_password.

interface ProfileRow {
  id: string;
  login: string;
  full_name: string;
  group_name: string;
  role: Role;
  public_key_jwk: JsonWebKey | null;
  avatar_url: string | null;
  created_at: number | string;
}

interface CredentialsRow {
  profile_id: string;
  password_hash: string;
}

function rowToUser(row: ProfileRow): User {
  return {
    id: row.id,
    login: row.login,
    fullName: row.full_name,
    group: row.group_name,
    role: row.role,
    publicKeyJwk: row.public_key_jwk ?? {},
    avatarUrl: row.avatar_url ?? undefined,
    createdAt: Number(row.created_at ?? 0),
  };
}

const PROFILE_FIELDS = 'id,login,full_name,group_name,role,public_key_jwk,avatar_url,created_at';

export interface NewUserInput {
  login: string;
  password: string;
  fullName: string;
  group: string;
  role: Role;
}

interface PreparedProfile {
  profile: ProfileRow;
  passwordHash: string;
}

async function prepareProfile(input: NewUserInput): Promise<PreparedProfile> {
  const login = normalizeLogin(input.login);
  if (!login) throw new Error('Логин не может быть пустым');
  if (!input.password) throw new Error('Пароль не может быть пустым');
  return {
    profile: {
      id: uid(),
      login,
      full_name: input.fullName.trim(),
      group_name: input.group.trim(),
      role: input.role,
      public_key_jwk: null,
      avatar_url: null,
      created_at: Date.now(),
    },
    passwordHash: await hashPassword(login, input.password),
  };
}

export async function createUser(input: NewUserInput): Promise<User> {
  const { profile, passwordHash } = await prepareProfile(input);
  const data = await unwrap<ProfileRow>(
    supabase().from('profiles').insert(profile).select(PROFILE_FIELDS).single(),
  );
  const { error } = await supabase()
    .from('credentials')
    .insert({ profile_id: profile.id, password_hash: passwordHash });
  if (error) {
    // Войти в профиль без пароля всё равно нельзя; RLS не даёт удалить чужую
    // строку, поэтому просто сообщаем об ошибке.
    throw new Error(error.message);
  }
  return rowToUser(data);
}

/**
 * Пакетное создание (seed). Уже существующие логины пропускаются, поэтому
 * операция идемпотентна и её можно запускать повторно.
 */
export async function createUsersBatch(
  inputs: NewUserInput[],
  onProgress?: (created: number, total: number) => void,
): Promise<User[]> {
  const existing = new Set((await getAllUsers()).map((u) => normalizeLogin(u.login)));
  const rows: PreparedProfile[] = [];

  for (const input of inputs) {
    const login = normalizeLogin(input.login);
    if (!login || existing.has(login)) continue;
    existing.add(login);
    rows.push(await prepareProfile(input));
    if (onProgress) onProgress(rows.length, inputs.length);
  }
  if (rows.length === 0) return [];

  const inserted: ProfileRow[] = [];
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100).map((r) => r.profile);
    const data = await unwrap<ProfileRow[]>(
      supabase().from('profiles').insert(chunk).select(PROFILE_FIELDS),
    );
    inserted.push(...(data ?? []));
  }
  for (let i = 0; i < rows.length; i += 100) {
    const chunk: CredentialsRow[] = rows.slice(i, i + 100).map((r) => ({
      profile_id: r.profile.id,
      password_hash: r.passwordHash,
    }));
    const { error } = await supabase().from('credentials').insert(chunk);
    // Профили без пароля останутся недоступными для входа — сообщаем об ошибке.
    if (error) throw new Error(error.message);
  }
  emit('chat:updated', {});
  return inserted.map(rowToUser);
}

/**
 * Серверный seed: одна SECURITY DEFINER-функция создаёт admin и cadet001..200.
 * Возвращает, сколько записей создано в этот раз (повторный вызов — 0).
 */
export async function seedUsers(): Promise<number> {
  const value = await unwrap<number>(supabase().rpc('seed_svyaz_users'));
  return Number(value ?? 0);
}

export function markKeyMigrationDone(): void {
  storage.writeJson(storage.KEYS.keysRev, KEYS_REV);
}

export async function countProfiles(): Promise<number> {
  const { count, error } = await supabase()
    .from('profiles')
    .select('id', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  return count ?? 0;
}

const PROFILES_PAGE_SIZE = 500;

/**
 * Все профили, без ограничения на количество.
 *
 * Один select может быть обрезан настройкой PostgREST «max rows» — именно
 * поэтому поиск иногда показывал не всех найденных. Читаем страницами, пока
 * сервер не вернёт пустую: срез по количеству строк больше не применяется.
 */
export async function getAllUsers(): Promise<User[]> {
  const all: ProfileRow[] = [];
  const seen = new Set<string>();
  let from = 0;

  // Потолок страниц — только защита от бесконечного цикла, не лимит выдачи.
  for (let page = 0; page < 1000; page += 1) {
    const rows = (await unwrap(
      supabase()
        .from('profiles')
        .select(PROFILE_FIELDS)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PROFILES_PAGE_SIZE - 1),
    )) as ProfileRow[];

    if (!rows || rows.length === 0) break;

    // Если сервер игнорирует range и отдаёт те же строки — останавливаемся.
    const fresh = rows.filter((row) => !seen.has(row.id));
    if (fresh.length === 0) break;
    for (const row of fresh) {
      seen.add(row.id);
      all.push(row);
    }
    from += rows.length;
  }

  return all.map(rowToUser);
}

export async function findUserByLogin(login: string): Promise<User | null> {
  const normalized = normalizeLogin(login);
  if (!normalized) return null;
  const data = await unwrap(
    supabase().from('profiles').select(PROFILE_FIELDS).eq('login', normalized).limit(1),
  );
  const row = ((data ?? []) as ProfileRow[])[0];
  return row ? rowToUser(row) : null;
}

export async function getUserById(id: string): Promise<User | null> {
  const data = await unwrap(
    supabase().from('profiles').select(PROFILE_FIELDS).eq('id', id).limit(1),
  );
  const row = ((data ?? []) as ProfileRow[])[0];
  return row ? rowToUser(row) : null;
}

/**
 * Точное совпадение ФИО и взвода; группа принимает и «1», и «1 взвод».
 *
 * Важно: результат НЕ обрезается ни здесь, ни в getAllUsers. Если под запрос
 * подходят 20 человек — вернутся все 20.
 */
export async function searchUsers(query: { fullName: string; group: string }): Promise<User[]> {
  const me = storage.getCurrentUserId();
  const fullName = normalizeSearchText(query.fullName);
  const group = normalizeSearchText(query.group);
  // Пустая форма не должна выдавать всю базу.
  if (!fullName && !group) return [];
  const groupDigits = (group.match(/\d+/) ?? [''])[0];

  return (await getAllUsers()).filter((u) => {
    if (u.id === me) return false;
    // Незаполненное поле не фильтрует: можно искать только по ФИО или взводу.
    if (fullName && normalizeSearchText(u.fullName) !== fullName) return false;
    if (!group) return true;
    const userGroup = normalizeSearchText(u.group);
    if (userGroup === group) return true;
    const userDigits = (userGroup.match(/\d+/) ?? [''])[0];
    return groupDigits !== '' && userDigits === groupDigits;
  });
}

/**
 * Вход. Пароль хэшируется на клиенте (SHA-256 от «логин:пароль»), на сервер
 * уходит только хэш — RPC verify_login ищет профиль с таким хэшем.
 */
export async function verifyLogin(login: string, password: string): Promise<User | null> {
  const normalized = normalizeLogin(login);
  if (!normalized) return null;
  const hash = await hashPassword(normalized, password);
  const data = await unwrap<ProfileRow[]>(
    supabase().rpc('verify_login', { p_login: normalized, p_hash: hash }),
  );
  const row = (data ?? [])[0];
  return row ? rowToUser(row) : null;
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await getUserById(userId);
  if (!user) throw new Error('Пользователь не найден');
  if (newPassword.length < 6) throw new Error('Новый пароль короче 6 символов');
  const currentHash = await hashPassword(user.login, currentPassword);
  const nextHash = await hashPassword(user.login, newPassword);
  const ok = await unwrap<boolean>(
    supabase().rpc('change_password', {
      p_profile: userId,
      p_current_hash: currentHash,
      p_new_hash: nextHash,
    }),
  );
  if (!ok) throw new Error('Текущий пароль неверен');
}

/**
 * Гарантирует рабочую пару ключей ТЕКУЩЕГО пользователя: приватный ключ лежит
 * только в этом браузере, публичный — в профиле Supabase.
 *
 * Ключ собеседника создать нельзя (его приватная часть должна остаться у него),
 * поэтому для чужого id функция просто возвращает профиль.
 */
export async function ensureUserKeyPair(userId: string): Promise<User | null> {
  const user = await getUserById(userId);
  if (!user) return null;
  if (storage.getCurrentUserId() !== userId) return user;
  if (!isCryptoAvailable()) return user;

  let status: KeyPairStatus;
  try {
    status = await getKeyPairStatus(userId, user.publicKeyJwk);
  } catch {
    return user;
  }
  if (status === 'ok') return user;

  const { publicKeyJwk, privateKeyJwk } = await generateUserKeys();
  savePrivateKey(userId, privateKeyJwk);
  const { error } = await supabase()
    .from('profiles')
    .update({ public_key_jwk: publicKeyJwk })
    .eq('id', userId);
  if (error) throw new Error(error.message);

  emit('keys:updated', { userId });
  return { ...user, publicKeyJwk };
}

/** Однократная проверка ключей текущего пользователя при старте */
export async function repairAllUserKeys(): Promise<number> {
  if (storage.readJson<string>(storage.KEYS.keysRev) === KEYS_REV) return 0;
  if (!isCryptoAvailable()) return 0;

  const userId = storage.getCurrentUserId();
  let repaired = 0;
  if (userId) {
    const before = await getMyKeyStatus(userId);
    if (before !== 'ok') {
      await ensureUserKeyPair(userId);
      repaired = 1;
    }
  }
  markKeyMigrationDone();
  return repaired;
}

// --- чаты ---------------------------------------------------------------------

interface ChatRow {
  id: string;
  created_at: number | string;
  saved: boolean;
  owner_id: string | null;
  secret?: boolean | null;
}

function rowToChat(row: ChatRow, participants: string[]): Chat {
  const pair: [string, string] = [participants[0], participants[1] ?? participants[0]];
  return {
    id: row.id,
    participants: pair,
    createdAt: Number(row.created_at ?? 0),
    saved: row.saved === true,
    secret: row.secret === true,
  };
}

const CHAT_FIELDS = 'id,created_at,saved,owner_id,secret';

async function loadChat(chatId: string): Promise<Chat | null> {
  const data = (await unwrap(
    supabase().from('chats').select(CHAT_FIELDS).eq('id', chatId).limit(1),
  )) as ChatRow[];
  const row = (data ?? [])[0];
  if (!row) return null;
  const parts = (await unwrap(
    supabase().from('chat_participants').select('user_id').eq('chat_id', chatId),
  )) as { user_id: string }[];
  return rowToChat(row, (parts ?? []).map((p) => p.user_id));
}

interface ParticipantRow {
  chat_id: string;
  user_id: string;
}

/** Найти существующий личный чат двух пользователей (ровно два участника). */
async function findDirectChat(a: string, b: string): Promise<Chat | null> {
  if (a === b) return null;

  const mine = (await unwrap(
    supabase().from('chat_participants').select('chat_id').eq('user_id', a),
  )) as { chat_id: string }[];
  const ids = Array.from(new Set((mine ?? []).map((r) => r.chat_id).filter(Boolean)));
  if (ids.length === 0) return null;

  const rows = (await unwrap(
    supabase().from('chats').select(CHAT_FIELDS).in('id', ids).eq('saved', false),
  )) as ChatRow[];
  if (!rows || rows.length === 0) return null;

  const parts = (await unwrap(
    supabase()
      .from('chat_participants')
      .select('chat_id,user_id')
      .in('chat_id', rows.map((r) => r.id)),
  )) as ParticipantRow[];

  const byChat = new Map<string, string[]>();
  for (const p of parts ?? []) {
    const list = byChat.get(p.chat_id) ?? [];
    list.push(p.user_id);
    byChat.set(p.chat_id, list);
  }

  const match = rows
    .filter((row) => {
      const users = byChat.get(row.id) ?? [];
      return users.length === 2 && users.includes(a) && users.includes(b);
    })
    // Если в базе уже есть дубль (старая гонка) — открываем самый первый.
    .sort((x, y) => Number(x.created_at ?? 0) - Number(y.created_at ?? 0))[0];

  return match ? rowToChat(match, [a, b]) : null;
}

/**
 * Открыть личный чат: найти существующий 1:1 или создать новый.
 *
 * 1. Ищем чат, где участники — ровно эти двое. Нашли — возвращаем его.
 * 2. Не нашли — создаём строку в chats и обоих в chat_participants.
 *    id генерируется через crypto.randomUUID() (см. uid).
 * 3. Отправляем broadcast: второе устройство перечитывает список чатов и
 *    видит диалог сразу, без повторного нажатия «Открыть чат».
 */
export async function getOrCreateChat(a: string, b: string): Promise<Chat> {
  if (a === b) return ensureSavedChat(a);

  const existing = await findDirectChat(a, b);
  if (existing) return existing;

  const chatId = uid();
  const row: ChatRow = { id: chatId, created_at: Date.now(), saved: false, owner_id: null, secret: false };

  const { error: chatError } = await supabase().from('chats').insert(row);
  if (chatError) throw new Error(chatError.message);

  const { error: partsError } = await supabase()
    .from('chat_participants')
    .insert([
      { chat_id: chatId, user_id: a },
      { chat_id: chatId, user_id: b },
    ]);
  if (partsError) throw new Error(partsError.message);

  emit('chat:updated', { chatId });
  void broadcastChat(chatId);
  return rowToChat(row, [a, b]);
}

/** Включить/выключить секретный чат (сообщения автоудаляются через 24 ч) */
export async function setChatSecret(chatId: string, secret: boolean): Promise<void> {
  const { error } = await supabase().from('chats').update({ secret }).eq('id', chatId);
  if (error) throw new Error(error.message);
  emit('chat:updated', { chatId });
  void broadcastChat(chatId);
}

/** Системный чат «Избранное» (переписка с самим собой) */
export async function ensureSavedChat(userId: string): Promise<Chat> {
  const rows = (await unwrap(
    supabase().from('chats').select(CHAT_FIELDS).eq('saved', true).eq('owner_id', userId).limit(1),
  )) as ChatRow[];
  const existing = (rows ?? [])[0];
  if (existing) return rowToChat(existing, [userId, userId]);

  const chatId = uid();
  const row: ChatRow = { id: chatId, created_at: Date.now(), saved: true, owner_id: userId, secret: false };
  const { error } = await supabase().from('chats').insert(row);
  if (error) throw new Error(error.message);
  const { error: partsError } = await supabase()
    .from('chat_participants')
    .insert({ chat_id: chatId, user_id: userId });
  if (partsError) throw new Error(partsError.message);
  emit('chat:updated', { chatId });
  return rowToChat(row, [userId, userId]);
}

export async function getChatById(id: string): Promise<Chat | null> {
  return loadChat(id);
}

interface MessageRow {
  id: string;
  chat_id: string;
  sender_id: string;
  ciphertext: string;
  iv: string;
  wrapped_key: string | null;
  wrapped_key_iv: string | null;
  wrapped_self_key: string | null;
  wrapped_self_key_iv: string | null;
  reply_to_id: string | null;
  type: MessageType;
  mime_type: string | null;
  duration: number | null;
  waveform: number[] | null;
  status: MessageStatus;
  edited_at: number | null;
  deleted: boolean | null;
  created_at: number | string;
}

const MESSAGE_FIELDS =
  'id,chat_id,sender_id,ciphertext,iv,wrapped_key,wrapped_key_iv,wrapped_self_key,' +
  'wrapped_self_key_iv,reply_to_id,type,mime_type,duration,waveform,status,edited_at,deleted,created_at';

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    ciphertext: row.ciphertext ?? '',
    iv: row.iv ?? '',
    wrappedKey: row.wrapped_key ?? undefined,
    wrappedKeyIv: row.wrapped_key_iv ?? undefined,
    wrappedSelfKey: row.wrapped_self_key ?? undefined,
    wrappedSelfKeyIv: row.wrapped_self_key_iv ?? undefined,
    replyToId: row.reply_to_id ?? undefined,
    type: row.type,
    mimeType: row.mime_type ?? undefined,
    duration: row.duration ?? undefined,
    waveform: row.waveform ?? undefined,
    status: row.status ?? 'sent',
    editedAt: row.edited_at ?? undefined,
    deleted: row.deleted === true,
    createdAt: Number(row.created_at ?? 0),
  };
}

function envelopeToRow(envelope: EnvelopeFields): Record<string, unknown> {
  return {
    ciphertext: envelope.ciphertext ?? '',
    iv: envelope.iv ?? '',
    wrapped_key: envelope.wrappedKey ?? null,
    wrapped_key_iv: envelope.wrappedKeyIv ?? null,
    wrapped_self_key: envelope.wrappedSelfKey ?? null,
    wrapped_self_key_iv: envelope.wrappedSelfKeyIv ?? null,
  };
}

/** Список чатов пользователя с последним сообщением и непрочитанными */
export async function getUserChats(userId: string): Promise<ChatListItem[]> {
  const parts = (await unwrap(
    supabase().from('chat_participants').select('chat_id').eq('user_id', userId),
  )) as { chat_id: string }[];
  const ids = (parts ?? []).map((p) => p.chat_id);
  if (ids.length === 0) return [];

  const chats = (await unwrap(
    supabase().from('chats').select(CHAT_FIELDS).in('id', ids),
  )) as ChatRow[];
  const allParts = (await unwrap(
    supabase().from('chat_participants').select('chat_id,user_id').in('chat_id', ids),
  )) as { chat_id: string; user_id: string }[];
  const peerIds = Array.from(
    new Set((allParts ?? []).map((p) => p.user_id).filter((id) => id !== userId)),
  );
  const profiles = peerIds.length
    ? ((await unwrap(
        supabase().from('profiles').select(PROFILE_FIELDS).in('id', peerIds),
      )) as ProfileRow[])
    : [];
  const byId = new Map(profiles.map((p) => [p.id, rowToUser(p)]));

  const messages = (await unwrap(
    supabase()
      .from('messages')
      .select(MESSAGE_FIELDS)
      .in('chat_id', ids)
      .order('created_at', { ascending: false })
      .limit(2000),
  )) as MessageRow[];

  const reads = (await unwrap(
    supabase().from('read_state').select('chat_id,last_read_at').eq('user_id', userId).in('chat_id', ids),
  )) as { chat_id: string; last_read_at: number | string }[];
  const readMap = new Map((reads ?? []).map((r) => [r.chat_id, Number(r.last_read_at ?? 0)]));

  const list: ChatListItem[] = [];
  for (const row of chats ?? []) {
    const chatParts = (allParts ?? [])
      .filter((p) => p.chat_id === row.id)
      .map((p) => p.user_id);
    const chat = rowToChat(row, chatParts);
    const peerId = chatParts.find((id) => id !== userId) ?? userId;
    const peer = byId.get(peerId);
    if (!peer) continue;

    const chatMessages = (messages ?? []).filter((m) => m.chat_id === row.id);
    const lastRow = chatMessages[0] ?? null;
    const lastRead = readMap.get(row.id) ?? 0;
    const unread = chatMessages.filter(
      (m) => m.sender_id !== userId && Number(m.created_at ?? 0) > lastRead && !m.deleted,
    ).length;

    list.push({
      chat,
      peer,
      lastMessage: lastRow ? rowToMessage(lastRow) : null,
      unread,
    });
  }

  list.sort((a, b) => {
    const at = a.lastMessage?.createdAt ?? a.chat.createdAt;
    const bt = b.lastMessage?.createdAt ?? b.chat.createdAt;
    return bt - at;
  });
  return list;
}

// --- сообщения ----------------------------------------------------------------

export async function getMessages(chatId: string): Promise<Message[]> {
  const rows = (await unwrap(
    supabase()
      .from('messages')
      .select(MESSAGE_FIELDS)
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true }),
  )) as MessageRow[];
  return (rows ?? []).map(rowToMessage);
}

export async function getMessageById(msgId: string): Promise<Message | null> {
  const rows = (await unwrap(
    supabase().from('messages').select(MESSAGE_FIELDS).eq('id', msgId).limit(1),
  )) as MessageRow[];
  const row = (rows ?? [])[0];
  return row ? rowToMessage(row) : null;
}

export async function saveMessage(msg: Message): Promise<void> {
  await insertMessageRow(msg);
  announceMessage(msg);
}

/**
 * Оптимистичная отправка: сразу сообщаем своему окну о новом сообщении
 * (полный объект на руках), чтобы оно мгновенно появилось в ленте, а запись
 * в Supabase происходит после. При ошибке сети вызывается rollback.
 */
export async function saveMessageOptimistic(
  msg: Message,
  onError?: (error: unknown) => void,
): Promise<void> {
  // 1. Мгновенно — в своё окно, без ожидания сети.
  emit('message:new', { chatId: msg.chatId, message: msg });
  emit('chat:updated', { chatId: msg.chatId });
  void broadcastMessage({
    chatId: msg.chatId,
    messageId: msg.id,
    senderId: msg.senderId,
    kind: 'new',
  });
  try {
    // 2. Пишем в базу.
    await insertMessageRow(msg);
  } catch (error) {
    onError?.(error);
    throw error;
  }
}

/** Строка сообщения без побочных эффектов (нужна медиа-сообщениям) */
function messageToRow(msg: Message): Record<string, unknown> {
  return {
    id: msg.id,
    chat_id: msg.chatId,
    sender_id: msg.senderId,
    type: msg.type,
    mime_type: msg.mimeType ?? null,
    // В базе duration integer (секунды), а запись даёт дробное число.
    duration: msg.duration === undefined ? null : Math.round(msg.duration),
    waveform: msg.waveform ?? null,
    reply_to_id: msg.replyToId ?? null,
    status: msg.status ?? 'sent',
    created_at: msg.createdAt,
    ...envelopeToRow(msg),
  };
}

async function insertMessageRow(msg: Message): Promise<void> {
  const { error } = await supabase().from('messages').insert(messageToRow(msg));
  if (error) throw new Error(error.message);
}

/** Сообщить своему окну и другим устройствам о новом сообщении */
function announceMessage(msg: Message): void {
  emit('message:new', { chatId: msg.chatId, messageId: msg.id, senderId: msg.senderId });
  emit('chat:updated', { chatId: msg.chatId });
  void broadcastMessage({
    chatId: msg.chatId,
    messageId: msg.id,
    senderId: msg.senderId,
    kind: 'new',
  });
}

export async function updateMessage(
  msgId: string,
  patch: Partial<Omit<Message, 'id' | 'chatId' | 'senderId'>>,
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.ciphertext !== undefined) row.ciphertext = patch.ciphertext;
  if (patch.iv !== undefined) row.iv = patch.iv;
  if (patch.wrappedKey !== undefined) row.wrapped_key = patch.wrappedKey;
  if (patch.wrappedKeyIv !== undefined) row.wrapped_key_iv = patch.wrappedKeyIv;
  if (patch.wrappedSelfKey !== undefined) row.wrapped_self_key = patch.wrappedSelfKey;
  if (patch.wrappedSelfKeyIv !== undefined) row.wrapped_self_key_iv = patch.wrappedSelfKeyIv;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.editedAt !== undefined) row.edited_at = patch.editedAt;
  if (patch.deleted !== undefined) row.deleted = patch.deleted;
  if (patch.duration !== undefined) row.duration = Math.round(patch.duration);
  if (patch.waveform !== undefined) row.waveform = patch.waveform;
  if (Object.keys(row).length === 0) return;

  const { error } = await supabase().from('messages').update(row).eq('id', msgId);
  if (error) throw new Error(error.message);
  // chatId нужен, чтобы другие устройства перечитали именно этот чат.
  const chatId = (await getMessageById(msgId))?.chatId ?? '';
  emit('message:updated', { messageId: msgId, chatId });
  void broadcastMessage({ chatId, messageId: msgId, kind: 'updated' });
}

export async function setMessageStatus(msgId: string, status: MessageStatus): Promise<void> {
  const { error } = await supabase().from('messages').update({ status }).eq('id', msgId);
  if (error) throw new Error(error.message);
  const chatId = (await getMessageById(msgId))?.chatId ?? '';
  emit('message:updated', { messageId: msgId, chatId });
  void broadcastMessage({ chatId, messageId: msgId, kind: 'updated' });
}

/** Все входящие в моих чатах: sent → delivered */
export async function markMessagesDelivered(userId: string): Promise<void> {
  const parts = (await unwrap(
    supabase().from('chat_participants').select('chat_id').eq('user_id', userId),
  )) as { chat_id: string }[];
  const ids = (parts ?? []).map((p) => p.chat_id);
  if (ids.length === 0) return;

  const { error } = await supabase()
    .from('messages')
    .update({ status: 'delivered' })
    .in('chat_id', ids)
    .neq('sender_id', userId)
    .eq('status', 'sent');
  if (error) throw new Error(error.message);
  emit('message:updated', {});
  void broadcastMessage({ chatId: '', kind: 'updated' });
}

export async function markChatRead(chatId: string, userId: string): Promise<void> {
  const { error } = await supabase()
    .from('messages')
    .update({ status: 'read' })
    .eq('chat_id', chatId)
    .neq('sender_id', userId)
    .neq('status', 'read');
  if (error) throw new Error(error.message);

  const messages = await getMessages(chatId);
  const last = messages.reduce<Message | null>(
    (acc, m) => (acc === null || m.createdAt > acc.createdAt ? m : acc),
    null,
  );
  const { error: readError } = await supabase()
    .from('read_state')
    .upsert(
      { user_id: userId, chat_id: chatId, last_read_at: last ? last.createdAt : Date.now() },
      { onConflict: 'user_id,chat_id' },
    );
  if (readError) throw new Error(readError.message);
  emit('message:updated', { chatId });
  void broadcastMessage({ chatId, kind: 'updated' });
}

/** Мягкое удаление: стираем шифротекст и медиа, оставляем «Сообщение удалено» */
export async function softDeleteMessage(msg: Message): Promise<void> {
  await supabase().from('media').delete().eq('msg_id', msg.id);
  const { error } = await supabase()
    .from('messages')
    .update({
      deleted: true,
      ciphertext: '',
      iv: '',
      wrapped_key: null,
      wrapped_key_iv: null,
      wrapped_self_key: null,
      wrapped_self_key_iv: null,
      duration: null,
      waveform: null,
    })
    .eq('id', msg.id);
  if (error) throw new Error(error.message);
  emit('message:updated', { messageId: msg.id, chatId: msg.chatId });
  void broadcastMessage({ chatId: msg.chatId, messageId: msg.id, kind: 'updated' });
}

/** «Удалить у всех» — доступно отправителю в течение 15 минут после отправки. */
export async function deleteMessageForAll(msg: Message, userId: string): Promise<void> {
  if (msg.senderId !== userId) throw new Error('Удалять можно только свои сообщения');
  const elapsed = Date.now() - msg.createdAt;
  if (elapsed > 15 * 60 * 1000) throw new Error('Удалить у всех можно только в течение 15 минут после отправки');
  // Полное удаление строки — исчезает и у собеседника, и из экспорта.
  await supabase().from('media').delete().eq('msg_id', msg.id);
  const { error } = await supabase().from('messages').delete().eq('id', msg.id);
  if (error) throw new Error(error.message);
  emit('message:updated', { messageId: msg.id, chatId: msg.chatId });
  void broadcastMessage({ chatId: msg.chatId, messageId: msg.id, kind: 'updated' });
}

/** Полная очистка истории чата */
export async function clearChatHistory(chatId: string, userId: string): Promise<void> {
  await supabase().from('media').delete().in(
    'msg_id',
    ((await getMessages(chatId)) ?? []).map((m) => m.id),
  );
  await supabase().from('messages').delete().eq('chat_id', chatId);
  await supabase().from('read_state').delete().eq('chat_id', chatId).eq('user_id', userId);
  emit('chat:cleared', { chatId });
  emit('chat:updated', { chatId });
  void broadcastMessage({ chatId, kind: 'updated' });
}

// --- медиа --------------------------------------------------------------------

export interface StoredMedia extends EnvelopeFields {
  mimeType: string;
}

interface MediaRow {
  msg_id: string;
  ciphertext: string;
  iv: string;
  wrapped_key: string | null;
  wrapped_key_iv: string | null;
  wrapped_self_key: string | null;
  wrapped_self_key_iv: string | null;
  mime_type: string;
}

export async function saveMedia(msgId: string, media: StoredMedia): Promise<void> {
  const row: MediaRow = {
    msg_id: msgId,
    ciphertext: media.ciphertext,
    iv: media.iv,
    wrapped_key: media.wrappedKey ?? null,
    wrapped_key_iv: media.wrappedKeyIv ?? null,
    wrapped_self_key: media.wrappedSelfKey ?? null,
    wrapped_self_key_iv: media.wrappedSelfKeyIv ?? null,
    mime_type: media.mimeType,
  };
  const { error } = await supabase().from('media').upsert(row, { onConflict: 'msg_id' });
  if (error) throw new Error(error.message);
}

export async function getMedia(msgId: string): Promise<StoredMedia | null> {
  const rows = (await unwrap(
    supabase().from('media').select('*').eq('msg_id', msgId).limit(1),
  )) as MediaRow[];
  const row = (rows ?? [])[0];
  if (!row) return null;
  return {
    ciphertext: row.ciphertext,
    iv: row.iv,
    wrappedKey: row.wrapped_key ?? undefined,
    wrappedKeyIv: row.wrapped_key_iv ?? undefined,
    wrappedSelfKey: row.wrapped_self_key ?? undefined,
    wrappedSelfKeyIv: row.wrapped_self_key_iv ?? undefined,
    mimeType: row.mime_type,
  };
}

export interface MediaMessageMeta {
  id: string;
  chatId: string;
  senderId: string;
  type: MessageType;
  replyToId?: string;
  mimeType: string;
  duration?: number;
  waveform?: number[];
  createdAt: number;
}

/**
 * Медиа-сообщение.
 *
 * Порядок важен: RLS на media разрешает вставку только участнику чата,
 * а участником он становится по строке messages. Поэтому сначала сообщение,
 * потом файл; и только после успеха обоих — уведомление собеседнику, чтобы
 * он не открыл сообщение, у которого ещё нет медиа.
 */
export async function saveMediaMessage(
  meta: MediaMessageMeta,
  envelope: EnvelopeFields,
): Promise<void> {
  const msg: Message = {
    id: meta.id,
    chatId: meta.chatId,
    senderId: meta.senderId,
    type: meta.type,
    replyToId: meta.replyToId,
    mimeType: meta.mimeType,
    duration: meta.duration,
    waveform: meta.waveform,
    status: 'sent',
    createdAt: meta.createdAt,
    ciphertext: '',
    iv: '',
  };
  await insertMessageRow(msg);
  try {
    await saveMedia(meta.id, { ...envelope, mimeType: meta.mimeType });
  } catch (error) {
    // Без медиа сообщение бесполезно — убираем, чтобы не висело пустым.
    await supabase().from('messages').delete().eq('id', meta.id);
    throw error;
  }
  announceMessage(msg);
}

/** Публичный ключ собеседника в чате (для чтения своих сообщений старого формата) */
async function getPeerPublicKeyJwk(chatId: string, userId: string): Promise<JsonWebKey | null> {
  const chat = await getChatById(chatId);
  if (!chat) return null;
  const peerId = chat.participants[0] === userId ? chat.participants[1] : chat.participants[0];
  const peer = await getUserById(peerId);
  return peer?.publicKeyJwk ?? null;
}

// --- журнал входов -------------------------------------------------------------

export interface SessionRecord {
  id: string;
  deviceName: string;
  createdAt: number;
  lastSeen: number;
}

/** Зарегистрировать текущее устройство при входе (журнал входов) */
export async function registerSession(userId: string): Promise<void> {
  const device = `${detectPlatform()} · ${detectDevice()}`;
  await supabase()
    .from('sessions')
    .insert({
      id: uid(),
      user_id: userId,
      device_name: device,
      created_at: Date.now(),
      last_seen: Date.now(),
    })
    .then(({ error }) => {
      if (error) console.warn('registerSession failed', error.message);
    });
}

/** Список устройств, где выполнен вход */
export async function getMySessions(userId: string): Promise<SessionRecord[]> {
  const rows = (await unwrap(
    supabase()
      .from('sessions')
      .select('id,device_name,created_at,last_seen')
      .eq('user_id', userId)
      .order('last_seen', { ascending: false }),
  )) as { id: string; device_name: string | null; created_at: number | string; last_seen: number | string }[];
  return (rows ?? []).map((r) => ({
    id: r.id,
    deviceName: r.device_name ?? '',
    createdAt: Number(r.created_at ?? 0),
    lastSeen: Number(r.last_seen ?? 0),
  }));
}

/** «Выйти на всех устройствах»: удаляем все сессии кроме текущей */
export async function logoutAllDevicesExcept(
  userId: string,
  keepSessionId: string | null,
): Promise<void> {
  let q = supabase().from('sessions').delete().eq('user_id', userId);
  if (keepSessionId) q = q.neq('id', keepSessionId);
  const { error } = await q;
  if (error) throw new Error(error.message);
}

function detectPlatform(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Устройство';
}

function detectDevice(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Chrome/i.test(ua) && !/Edg/i.test(ua)) return 'Chrome';
  if (/Firefox/i.test(ua)) return 'Firefox';
  if (/Safari/i.test(ua)) return 'Safari';
  if (/Edge|Edg/i.test(ua)) return 'Edge';
  return 'Браузер';
}

// --- аватар (Supabase Storage) --------------------------------------------------

/**
 * Загрузить аватарку: сжать до 256px, сохранить в bucket 'avatars' и обновить
 * profiles.avatar_url. Если файла с таким именем не было — создаём.
 */
export async function uploadAvatar(userId: string, file: Blob): Promise<string> {
  const blob = await downscaleAvatar(file);
  const path = `${userId}.jpg`;
  const { error: upErr } = await supabase()
    .storage
    .from('avatars')
    .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
  if (upErr) throw new Error(upErr.message);

  const { data } = supabase().storage.from('avatars').getPublicUrl(path);
  const url = data.publicUrl;
  const { error } = await supabase().from('profiles').update({ avatar_url: url }).eq('id', userId);
  if (error) throw new Error(error.message);
  emit('avatar:updated', { userId });
  return url;
}

/** Сжать картинку до 256px по большей стороне, качество 0.85 */
async function downscaleAvatar(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const max = 256;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d not supported');
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('avatar compress failed'))), 'image/jpeg', 0.85);
  });
}

// --- буфер: событие смены аватара ------------------------------------------------
// Нужно emit('avatar:updated') — добавим тип события в bus.ts.

/** Расшифрованное медиа в виде Blob */
export async function getDecryptedMediaBlob(msg: Message, userId: string): Promise<Blob | null> {
  const stored = await getMedia(msg.id);
  if (!stored) return null;
  const sender = await getUserById(msg.senderId);
  if (!sender) return null;
  const peerPublicKeyJwk = await getPeerPublicKeyJwk(msg.chatId, userId);
  try {
    const buf = await decryptEnvelope({
      myId: userId,
      own: msg.senderId === userId,
      senderPublicKeyJwk: sender.publicKeyJwk,
      peerPublicKeyJwk: peerPublicKeyJwk ?? undefined,
      envelope: stored,
    });
    return new Blob([buf], { type: stored.mimeType });
  } catch {
    return null;
  }
}

// --- чтение и экспорт ------------------------------------------------------------

/** Расшифровать текст сообщения от имени userId (null, если не удалось) */
export async function readMessageText(msg: Message, userId: string): Promise<string | null> {
  if (msg.deleted || msg.type !== 'text') return null;
  const sender = await getUserById(msg.senderId);
  if (!sender) return null;
  const peerPublicKeyJwk = await getPeerPublicKeyJwk(msg.chatId, userId);
  const attempt = async (senderPublicKeyJwk: JsonWebKey) => {
    return decryptEnvelopeToString({
      myId: userId,
      own: msg.senderId === userId,
      senderPublicKeyJwk,
      peerPublicKeyJwk: peerPublicKeyJwk ?? undefined,
      envelope: msg,
    });
  };
  try {
    return await attempt(sender.publicKeyJwk);
  } catch {
    // Фикс шифрования при повторном входе: если сообщение не расшифровалось
    // ключом из локального профиля, пробуем свежий ключ отправителя из БД —
    // он мог быть пересоздан (repairAllUserKeys) после отправки сообщения.
    try {
      const fresh = await getUserById(msg.senderId);
      if (fresh && fresh.id !== sender.id) {
        return await attempt(fresh.publicKeyJwk);
      }
      return null;
    } catch {
      return null;
    }
  }
}

/** Текстовая расшифрованная история чата (.txt) */
export async function buildChatTranscript(chatId: string, userId: string): Promise<string> {
  const messages = await getMessages(chatId);
  const lines: string[] = [];
  for (const m of messages) {
    const sender = await getUserById(m.senderId);
    const who = m.senderId === userId ? 'Вы' : sender?.fullName ?? m.senderId;
    const at = new Date(m.createdAt).toLocaleString('ru-RU');
    let body = '[медиа]';
    if (m.deleted) body = '[сообщение удалено]';
    else if (m.type === 'text') body = (await readMessageText(m, userId)) ?? '[не расшифровано]';
    lines.push(`[${at}] ${who}: ${body}`);
  }
  return lines.join('\n');
}

export interface ExportedMessage {
  chatTitle: string;
  from: string;
  at: string;
  type: MessageType;
  text: string;
  edited: boolean;
  deleted: boolean;
}

export interface ExportedChat {
  chatId: string;
  title: string;
  peerGroup: string;
  messages: ExportedMessage[];
}

/** Экспорт профиля, чатов и расшифрованной переписки в JSON */
export async function exportUserData(userId: string): Promise<Record<string, unknown>> {
  const user = await getUserById(userId);
  const chats = await getUserChats(userId);

  const chatEntries: ExportedChat[] = [];
  for (const item of chats) {
    const messages = await getMessages(item.chat.id);
    const out: ExportedMessage[] = [];
    for (const m of messages) {
      const sender = await getUserById(m.senderId);
      let text = '';
      if (m.deleted) text = '[Сообщение удалено]';
      else if (m.type === 'text') text = (await readMessageText(m, userId)) ?? '[Не удалось расшифровать]';
      else text = `[${m.type}]`;
      out.push({
        chatTitle: item.chat.saved ? 'Избранное' : item.peer.fullName,
        from: m.senderId === userId ? 'Вы' : sender?.fullName ?? m.senderId,
        at: new Date(m.createdAt).toISOString(),
        type: m.type,
        text,
        edited: m.editedAt !== undefined,
        deleted: m.deleted === true,
      });
    }
    chatEntries.push({
      chatId: item.chat.id,
      title: item.chat.saved ? 'Избранное' : item.peer.fullName,
      peerGroup: item.chat.saved ? user?.group ?? '' : item.peer.group,
      messages: out,
    });
  }

  return {
    app: 'Связь',
    exportedAt: new Date().toISOString(),
    profile: user
      ? {
          login: user.login,
          fullName: user.fullName,
          group: user.group,
          role: user.role,
          createdAt: new Date(user.createdAt).toISOString(),
        }
      : null,
    chats: chatEntries,
  };
}

// --- «печатает» и присутствие -----------------------------------------------------

export function notifyTyping(chatId: string, userId: string): void {
  const payload: TypingPayload = { chatId, userId, until: Date.now() + 2500 };
  void sendTyping(payload);
}

/** Немедленно сообщить собеседнику, что печать прекратилась */
export function stopTyping(chatId: string, userId: string): void {
  const payload: TypingPayload = { chatId, userId, until: Date.now() - 1, stopped: true };
  void sendTyping(payload);
}

/** Пульс присутствия: upsert в presence, другие устройства читают last_seen */
export function touchPresence(userId: string): void {
  void supabase()
    .from('presence')
    .upsert({ user_id: userId, last_seen: Date.now() }, { onConflict: 'user_id' })
    .then(({ error }) => {
      if (error) console.warn('presence upsert failed', error.message);
    });
}

export async function isUserOnline(userId: string): Promise<boolean> {
  const rows = (await unwrap(
    supabase().from('presence').select('last_seen').eq('user_id', userId).limit(1),
  )) as { last_seen: number | string }[];
  const row = (rows ?? [])[0];
  if (!row) return false;
  return Date.now() - Number(row.last_seen ?? 0) < 20000;
}

// --- сессия и тема -------------------------------------------------------------

export function getCurrentUserId(): string | null {
  return storage.getCurrentUserId();
}

export function setCurrentUserId(id: string): void {
  storage.setCurrentUserId(id);
  setSupabaseUser(id);
  emit('auth:changed', id);
}

/** Выход: чистим ТОЛЬКО сессию. Ключи и историю не удаляем. */
export function logout(): void {
  storage.setCurrentUserId(null);
  clearLocalMessageCache();
  setSupabaseUser(null);
  emit('auth:changed', null);
}

/**
 * Локальный кэш сообщений — чтобы следующий пользователь на этом устройстве
 * не увидел чужую переписку. Сообщения хранятся в localStorage под
 * ключами вида `svyaz.chat.<chatId>`. Сами приватные ключи E2EE и профиль
 * НЕ трогаем: они принадлежат конкретному пользователю по идентификатору.
 */
function clearLocalMessageCache(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith('svyaz.chat.')) toRemove.push(key);
    }
    for (const key of toRemove) window.localStorage.removeItem(key);
  } catch {
    /* не критично: кэш частично мог остаться */
  }
}

export function getThemeMode(): ThemeMode {
  const t = storage.readJson<string>(storage.KEYS.theme);
  if (t === 'dark' || t === 'system') return t;
  return 'light';
}

export function setThemeMode(mode: ThemeMode): void {
  storage.writeJson(storage.KEYS.theme, mode);
  emit('theme:changed', mode);
}

export async function getMyPublicKey(userId: string): Promise<JsonWebKey | null> {
  const user = await getUserById(userId);
  return user?.publicKeyJwk ?? null;
}

export function hasMyPrivateKey(userId: string): boolean {
  return getPrivateKey(userId) !== null;
}

export async function getMyKeyStatus(userId: string): Promise<KeyPairStatus> {
  const user = await getUserById(userId);
  return getKeyPairStatus(userId, user?.publicKeyJwk);
}

/** Зашифровать данные для себя (пересылка в «Избранное») */
export async function encryptForSelf(
  userId: string,
  data: string | ArrayBuffer,
): Promise<EnvelopeFields> {
  const user = (await ensureUserKeyPair(userId)) ?? (await getUserById(userId));
  if (!user) throw new Error('Пользователь не найден');
  if (!user.publicKeyJwk?.x) throw new Error('Ключ шифрования пользователя не создан');
  return encryptFor({
    myId: userId,
    myPublicKeyJwk: user.publicKeyJwk,
    peerPublicKeyJwk: user.publicKeyJwk,
    data,
  });
}
