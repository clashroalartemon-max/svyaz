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
import { supabase, setSupabaseUser, setSessionToken } from './supabase';
import { emit } from './bus';
import { safeError } from './logging';
import { autoAssignRankForGroup } from './ranks';
import { broadcastChat, broadcastMessage, sendTyping } from './realtime';
import {
  clearPrivateKey,
  decryptEnvelope,
  decryptEnvelopeToString,
  decryptGroupEnvelope,
  decryptPrivateKeyWithPassword,
  derivePublicKeyJwk,
  encryptFor,
  encryptPrivateKeyWithPassword,
  generateUserKeys,
  generateMasterKey,
  encryptSecretWithPassword,
  decryptSecretWithPassword,
  encryptWithMasterKey,
  decryptWithMasterKey,
  getKeyPairStatus,
  getPrivateKey,
  hashPassword,
  isCryptoAvailable,
  savePrivateKey,
} from './crypto';
import type { KeyPairStatus } from './crypto';
import type {
  Broadcast,
  Chat,
  ChatKind,
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
  military_rank: string | null;
  position: string | null;
  role_level: number | null;
  username: string | null;
  public_key_jwk: JsonWebKey | null;
  encrypted_private_key: string | null;
  avatar_url: string | null;
  department: string | null;
  phone: string | null;
  status: string | null;
  bio: string | null;
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
    rank: row.military_rank ?? undefined,
    position: row.position ?? undefined,
    roleLevel: row.role_level ?? 1,
    username: row.username ?? undefined,
    department: row.department ?? undefined,
    phone: row.phone ?? undefined,
    status: row.status ?? undefined,
    bio: row.bio ?? undefined,
    publicKeyJwk: row.public_key_jwk ?? {},
    avatarUrl: row.avatar_url ?? undefined,
    createdAt: Number(row.created_at ?? 0),
  };
}

/**
 * SELECT-поля публичного профиля. Зашифрованный приватный ключ сюда не входит:
 * колонка закрыта на уровне прав, а сам ключ выдаётся только функции входа.
 */
const PROFILE_PUBLIC_FIELDS =
  'id,login,full_name,group_name,role,military_rank,position,role_level,username,public_key_jwk,avatar_url,department,phone,status,bio,created_at';

// Поля без status/bio: схема может быть обновлена не полностью.
const PROFILE_EXTRAS_PUBLIC_FIELDS =
  'id,login,full_name,group_name,role,military_rank,position,role_level,username,public_key_jwk,avatar_url,department,phone,created_at';

// Резервный набор полей: живая база может быть ещё без новых колонок
// (department/phone). Тогда приложение продолжает работать, а новые
// возможности включаются после применения schema.sql.
const PROFILE_BASE_PUBLIC_FIELDS =
  'id,login,full_name,group_name,role,military_rank,position,role_level,username,public_key_jwk,avatar_url,created_at';

/** Поддерживает ли живая база новые колонки профиля (department, phone). */
let profileExtrasSupported: boolean | null = null;
async function ensureProfileExtras(): Promise<boolean> {
  if (profileExtrasSupported !== null) return profileExtrasSupported;
  try {
    const { error } = await supabase().from('profiles').select('department,phone').limit(1);
    profileExtrasSupported = !error;
  } catch {
    profileExtrasSupported = false;
  }
  return profileExtrasSupported;
}

/** Статус и био включаются флагом схемы, чтобы не ловить 400 на старых базах. */
let profileSocialSupported: boolean | null = null;
async function ensureProfileSocial(): Promise<boolean> {
  if (profileSocialSupported !== null) return profileSocialSupported;
  profileSocialSupported = await hasFeature('profile_social');
  return profileSocialSupported;
}

/**
 * Возможности схемы (`app_settings.schema_features`). Позволяет не вызывать
 * ещё не установленные RPC: иначе в консоли появлялись бы 404, а операции
 * падали бы в резервный путь с лишней задержкой.
 */
let schemaFeaturesCache: string | null = null;

async function schemaFeatures(): Promise<string> {
  if (schemaFeaturesCache !== null) return schemaFeaturesCache;
  try {
    const rows = (await unwrap(
      supabase().from('app_settings').select('value').eq('key', 'schema_features').limit(1),
    )) as { value: string }[];
    schemaFeaturesCache = (rows ?? [])[0]?.value ?? '';
  } catch {
    schemaFeaturesCache = '';
  }
  return schemaFeaturesCache;
}

async function hasFeature(name: string): Promise<boolean> {
  const list = (await schemaFeatures()).split(',').map((s) => s.trim());
  return list.includes(name);
}

/**
 * Выдать серверный токен после проверки пароля. Пока обновлённая схема не
 * применена, вход работает по старому заголовку; после применения
 * x-user-id больше не принимается.
 */
async function startSession(login: string, passwordHash: string): Promise<void> {
  if (!(await hasFeature('auth_tokens'))) return;
  try {
    const token = await unwrap<string>(
      supabase().rpc('issue_session_token', {
        p_login: login,
        p_hash: passwordHash,
      }),
    );
    if (!token) throw new Error('пустой токен');
    setSessionToken(token);
  } catch (error) {
    console.warn('Не удалось выдать сессионный токен', safeError(error));
    throw new Error('Не удалось создать защищённую сессию. Повторите вход.');
  }
}

/** Убрать из строки профиля новые колонки, если их нет в базе. */
function profileRowForWrite(row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row };
  if (profileExtrasSupported === false) {
    delete copy.department;
    delete copy.phone;
  }
  if (profileSocialSupported !== true) {
    delete copy.status;
    delete copy.bio;
  }
  return copy;
}

/** Поля публичного профиля с учётом фактической схемы базы. */
async function publicProfileFields(): Promise<string> {
  const extras = await ensureProfileExtras();
  const social = await ensureProfileSocial();
  if (social) return PROFILE_PUBLIC_FIELDS;
  return extras ? PROFILE_EXTRAS_PUBLIC_FIELDS : PROFILE_BASE_PUBLIC_FIELDS;
}

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

  // Генерируем пару ключей ECDH и сразу шифруем приватный ключ паролем,
  // чтобы он был переносимым между устройствами (см. encrypted_private_key).
  const { publicKeyJwk, privateKeyJwk } = await generateUserKeys();
  const encryptedPrivateKey = await encryptPrivateKeyWithPassword(
    privateKeyJwk,
    `${login}:${input.password}`,
  );

  return {
    profile: {
      id: uid(),
      login,
      full_name: input.fullName.trim(),
      group_name: input.group.trim(),
      role: input.role,
      military_rank: null,
      position: null,
      role_level: input.role === 'admin' ? 10 : 1,
      username: null,
      public_key_jwk: publicKeyJwk,
      encrypted_private_key: encryptedPrivateKey,
      avatar_url: null,
      department: null,
      phone: null,
      status: null,
      bio: null,
      created_at: Date.now(),
    },
    passwordHash: await hashPassword(login, input.password),
  };
}

// Пакетный seed (createUsersBatch) использует ту же prepareProfile, которая теперь
// генерирует ключи и шифрует приватную часть паролем.

export async function createUser(input: NewUserInput): Promise<User> {
  const { profile, passwordHash } = await prepareProfile(input);
  await ensureProfileExtras();
  await ensureProfileSocial();
  const data = await unwrap<ProfileRow>(
    supabase()
      .from('profiles')
      .insert(profileRowForWrite(profile as unknown as Record<string, unknown>))
      .select(await publicProfileFields())
      .single(),
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
  await ensureProfileExtras();
  await ensureProfileSocial();
  const publicFields = await publicProfileFields();
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows
      .slice(i, i + 100)
      .map((r) => profileRowForWrite(r.profile as unknown as Record<string, unknown>));
    const data = await unwrap<ProfileRow[]>(
      supabase().from('profiles').insert(chunk).select(publicFields),
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
        .select(await publicProfileFields())
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
    supabase().from('profiles').select(await publicProfileFields()).eq('login', normalized).limit(1),
  );
  const row = ((data ?? []) as ProfileRow[])[0];
  return row ? rowToUser(row) : null;
}

export async function getUserById(id: string): Promise<User | null> {
  const data = await unwrap(
    supabase().from('profiles').select(await publicProfileFields()).eq('id', id).limit(1),
  );
  const row = ((data ?? []) as ProfileRow[])[0];
  return row ? rowToUser(row) : null;
}

export interface DepartmentRow {
  id: string;
  name: string;
  kind: string;
}

export interface PositionRow {
  id: string;
  name: string;
  departmentId: string | null;
  roleLevel: number;
}

/** Все подразделения структуры университета (отсортированы по важности). */
export async function getDepartments(): Promise<DepartmentRow[]> {
  const rows = (await unwrap(
    supabase().from('departments').select('id,name,kind').order('sort_order', { ascending: true }),
  )) as { id: string; name: string; kind: string }[];
  return (rows ?? []).map((r) => ({ id: r.id, name: r.name, kind: r.kind }));
}

/** Все должности структуры (имя + подразделение + уровень прав). */
export async function getPositions(): Promise<PositionRow[]> {
  const rows = (await unwrap(
    supabase().from('positions').select('id,name,department_id,role_level').order('role_level', { ascending: false }),
  )) as { id: string; name: string; department_id: string | null; role_level: number }[];
  return (rows ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    departmentId: r.department_id,
    roleLevel: r.role_level,
  }));
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
 * Поиск по точному совпадению ника (username). Возвращает null, если ник
 * не найден — интерфейс показывает сообщение «Ник не найден».
 */
export async function searchUserByUsername(username: string): Promise<User | null> {
  const normalized = normalizeLogin(username);
  if (!normalized) return null;
  const data = await unwrap(
    supabase().from('profiles').select(await publicProfileFields()).eq('username', normalized).limit(1),
  );
  const row = ((data ?? []) as ProfileRow[])[0];
  return row ? rowToUser(row) : null;
}

/**
 * Вход. Пароль хэшируется на клиенте (SHA-256 от «логин:пароль»), на сервер
 * уходит только хэш — RPC verify_login ищет профиль с таким хэшем и возвращает
 * профиль вместе с encrypted_private_key (зашифрованным приватным ключом).
 *
 * Далее расшифровываем приватный ключ введённым паролем и кладём его в
 * localStorage текущей сессии — так ключ становится переносимым: старые
 * сообщения прочитаются с любого устройства.
 */
export interface LoginAttemptMeta {
  ip?: string;
  device?: string;
  geo?: string;
  lat?: number;
  lng?: number;
}

/** Серверный журнал входов и счётчик ошибок (RPC record_login_attempt). */
export async function recordLoginAttempt(
  login: string,
  success: boolean,
  meta: LoginAttemptMeta = {},
  reason?: string,
  forceBlock = false,
): Promise<{ blocked?: boolean; attempts?: number; reason?: string } | null> {
  try {
    const data = await unwrap<Record<string, unknown>>(
      supabase().rpc('record_login_attempt', {
        p_login: login,
        p_success: success,
        p_ip: meta.ip ?? null,
        p_device: meta.device ?? null,
        p_geo: meta.geo ?? null,
        p_lat: meta.lat ?? null,
        p_lng: meta.lng ?? null,
        p_block_reason: reason ?? null,
        p_force_block: forceBlock,
      }),
    );
    return (data ?? null) as { blocked?: boolean; attempts?: number; reason?: string } | null;
  } catch (error) {
    console.warn('login attempt logging failed', safeError(error));
    return null;
  }
}

/** Текущее состояние блокировки по логину (нет колонок — считаем свободным). */
export async function getLoginSecurity(
  login: string,
): Promise<{
  blocked: boolean;
  reason: string | null;
  lastLat: number | null;
  lastLng: number | null;
  lastDevice: string | null;
} | null> {
  try {
    const rows = (await unwrap(
      supabase()
        .from('profiles')
        .select('blocked,block_reason,last_lat,last_lng,last_device')
        .eq('login', login)
        .limit(1),
    )) as Array<{
      blocked?: boolean;
      block_reason?: string | null;
      last_lat?: number | null;
      last_lng?: number | null;
      last_device?: string | null;
    }>;
    const row = (rows ?? [])[0];
    if (!row) return null;
    return {
      blocked: row.blocked === true,
      reason: row.block_reason ?? null,
      lastLat: row.last_lat ?? null,
      lastLng: row.last_lng ?? null,
      lastDevice: row.last_device ?? null,
    };
  } catch {
    return null;
  }
}

function distanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const rad = (value: number) => (value * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface LoginEvent { id: number; login: string; success: boolean; reason: string | null; ip: string | null; device: string | null; geo: string | null; createdAt: number; }

export async function getLoginEvents(limit = 100): Promise<LoginEvent[]> {
  const rows = (await unwrap(
    supabase().from('login_events').select('id,login,success,reason,ip,device,geo,created_at').order('created_at', { ascending: false }).limit(limit),
  )) as Array<Record<string, unknown>>;
  return (rows ?? []).map((row) => ({
    id: Number(row.id),
    login: String(row.login ?? ''),
    success: row.success === true,
    reason: (row.reason as string | null) ?? null,
    ip: (row.ip as string | null) ?? null,
    device: (row.device as string | null) ?? null,
    geo: (row.geo as string | null) ?? null,
    createdAt: Number(row.created_at ?? 0),
  }));
}

export async function adminSetUserBlocked(userId: string, blocked: boolean, reason?: string): Promise<void> {
  const ok = await unwrap<boolean>(
    supabase().rpc('set_user_blocked', { p_user: userId, p_blocked: blocked, p_reason: reason ?? null }),
  );
  if (!ok) throw new Error('Не удалось изменить блокировку');
}

export async function verifyLogin(
  login: string,
  password: string,
  meta: LoginAttemptMeta = {},
): Promise<User | null> {
  const normalized = normalizeLogin(login);
  if (!normalized) return null;
  const security = await getLoginSecurity(normalized);
  if (security?.blocked) {
    await recordLoginAttempt(normalized, false, meta, security.reason ?? 'Аккаунт заблокирован');
    throw new Error(`Аккаунт заблокирован${security.reason ? `: ${security.reason}` : ''}`);
  }
  if (
    security?.lastLat != null &&
    security.lastLng != null &&
    meta.lat != null &&
    meta.lng != null &&
    security.lastDevice &&
    meta.device &&
    security.lastDevice !== meta.device &&
    distanceKm(security.lastLat, security.lastLng, meta.lat, meta.lng) > 1000
  ) {
    const reason = 'Подозрительный вход: новое устройство и другая геолокация';
    await recordLoginAttempt(normalized, false, meta, reason, true);
    throw new Error(`Аккаунт заблокирован: ${reason}. Свяжитесь с администратором.`);
  }
  const hash = await hashPassword(normalized, password);
  const data = await unwrap<ProfileRow[]>(
    supabase().rpc('verify_login', { p_login: normalized, p_hash: hash }),
  );
  const row = (data ?? [])[0];
  if (!row) {
    await recordLoginAttempt(normalized, false, meta, 'Неверный логин или пароль');
    return null;
  }

  const user = rowToUser(row);
  await startSession(normalized, hash);
  const state = await recordLoginAttempt(normalized, true, meta);
  if (state?.blocked) {
    throw new Error(`Аккаунт заблокирован${state.reason ? `: ${state.reason}` : ''}`);
  }
  try {
    await syncMasterHistory(row.id, normalized, password);
  } catch (error) {
    console.warn('master key sync failed', safeError(error));
  }

  // Переносимость ключа: если в базе есть зашифрованный приватный ключ —
  // расшифровываем его текущим паролем и кладём в localStorage.
  if (isCryptoAvailable()) {
    try {
      if (row.encrypted_private_key) {
        const privateJwk = await decryptPrivateKeyWithPassword(
          row.encrypted_private_key,
          `${normalized}:${password}`,
        );
        savePrivateKey(row.id, privateJwk);
      } else if (!getPrivateKey(row.id)) {
        // Старый профиль без зашифрованного ключа: генерируем пару и сохраняем
        // зашифрованную копию в базу — со следующего входа ключ переносим.
        const { publicKeyJwk, privateKeyJwk } = await generateUserKeys();
        const encrypted = await encryptPrivateKeyWithPassword(
          privateKeyJwk,
          `${normalized}:${password}`,
        );
        savePrivateKey(row.id, privateKeyJwk);
        await supabase()
          .from('profiles')
          .update({ encrypted_private_key: encrypted, public_key_jwk: publicKeyJwk })
          .eq('id', row.id)
          .then(({ error }) => {
            if (error) console.warn('Не удалось сохранить зашифрованный ключ', error.message);
          });
      }
    } catch (error) {
      // Ключ не совпал с паролем — это отдельный сбой; продолжаем вход с
      // публичным ключом (часть сообщений может не расшифроваться).
      console.warn('Не удалось восстановить приватный ключ при входе', safeError(error));
    }
  }

  // Гарантия наличия ключа: если после входа у пользователя в базе по-прежнему
  // нет валидного публичного ключа (например, колонка encrypted_private_key ещё
  // не появилась в живой базе, а у seed-профиля public_key_jwk пуст), создаём
  // свежую пару и сохраняем её — иначе с ним нельзя будет связаться.
  if (isCryptoAvailable() && (!user.publicKeyJwk || !user.publicKeyJwk.x || !user.publicKeyJwk.y)) {
    try {
      const { publicKeyJwk, privateKeyJwk } = await generateUserKeys();
      const encrypted = await encryptPrivateKeyWithPassword(
        privateKeyJwk,
        `${normalized}:${password}`,
      );
      savePrivateKey(row.id, privateKeyJwk);
      await supabase()
        .from('profiles')
        .update({ encrypted_private_key: encrypted, public_key_jwk: publicKeyJwk })
        .eq('id', row.id)
        .then(({ error }) => {
          if (error) console.warn('Не удалось сохранить ключ при входе', error.message);
        });
    } catch (error) {
      console.warn('Не удалось сгенерировать ключ при входе', error);
    }
  }

  return user;
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

  // change_password стирает старые токены — выдаём новый до записи ключа,
  // иначе обновление профиля ниже уже не пройдёт RLS.
  await startSession(user.login, nextHash);

  // Перешифровываем приватный ключ новым паролем, если он зашифрован в базе.
  await reencryptPrivateKeyForUser(userId, user.login, currentPassword, newPassword);
  await rewrapMasterKey(userId, user.login, currentPassword, newPassword);
}

/** Переобернуть мастер-ключ новым паролем (сам мастер-ключ не меняется). */
async function rewrapMasterKey(
  userId: string,
  login: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (!isCryptoAvailable()) return;
  try {
    const rows = (await unwrap(
      supabase()
        .from('profiles')
        .select('master_key_wrapped')
        .eq('id', userId)
        .limit(1),
    )) as Array<{ master_key_wrapped?: string }>;
    const wrapped = (rows ?? [])[0]?.master_key_wrapped;
    if (!wrapped) return;
    const master = await decryptSecretWithPassword(wrapped, `${login}:${currentPassword}`);
    const next = await encryptSecretWithPassword(master, `${login}:${newPassword}`);
    await supabase().from('profiles').update({ master_key_wrapped: next }).eq('id', userId);
  } catch (error) {
    console.warn('master key rewrap failed', safeError(error));
  }
}

/**
 * Перешифровать приватный ключ пользователя новым паролем и обновить
 * профиль. Ключ берётся из localStorage текущей сессии либо (если его ещё нет)
 * из зашифрованной копии в профиле.
 */
async function reencryptPrivateKeyForUser(
  userId: string,
  login: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (!isCryptoAvailable()) return;

  let privateJwk = getPrivateKey(userId);
  if (!privateJwk) {
    // Восстанавливаем зашифрованный ключ старым паролем. Основной путь —
    // RPC get_encrypted_key (колонка закрыта на чтение); если функции ещё
    // нет в базе, откатываемся на прямое чтение для совместимости.
    try {
      const currentHash = await hashPassword(login, currentPassword);
      let encrypted: string | null = null;
      if (await hasFeature('rpc_key')) {
        try {
          encrypted = await unwrap<string | null>(
            supabase().rpc('get_encrypted_key', {
              p_profile: userId,
              p_hash: currentHash,
            }),
          );
        } catch {
          encrypted = null;
        }
      }
      if (!encrypted) {
        const full = (await unwrap<ProfileRow[]>(
          supabase()
            .from('profiles')
            .select('encrypted_private_key')
            .eq('id', userId)
            .limit(1),
        )) as ProfileRow[];
        encrypted = (full ?? [])[0]?.encrypted_private_key ?? null;
      }
      if (encrypted) {
        privateJwk = await decryptPrivateKeyWithPassword(
          encrypted,
          `${login}:${currentPassword}`,
        );
      }
    } catch (error) {
      console.warn('Не удалось расшифровать ключ при смене пароля', safeError(error));
      return;
    }
  }
  if (!privateJwk) return;

  try {
    const encrypted = await encryptPrivateKeyWithPassword(
      privateJwk,
      `${login}:${newPassword}`,
    );
    const { error } = await supabase()
      .from('profiles')
      .update({ encrypted_private_key: encrypted })
      .eq('id', userId);
    if (error) throw new Error(error.message);
    savePrivateKey(userId, privateJwk);
  } catch (error) {
    console.warn('Не удалось перешифровать приватный ключ', safeError(error));
  }
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

  // Если локально уже есть приватный ключ, НИКОГДА не пересоздаём его:
  // пересоздание делает нечитаемыми все сообщения, зашифрованные этим
  // ключом (включая свежие групповые). Вместо этого приводим публичный ключ
  // в БД в соответствие с существующим приватным.
  const privateJwk = getPrivateKey(userId);
  if (privateJwk) {
    const publicKeyJwk = (await derivePublicKeyJwk(privateJwk)) ?? user.publicKeyJwk;
    if (!publicKeyJwk || !publicKeyJwk.x || !publicKeyJwk.y) return user;
    const { error } = await supabase()
      .from('profiles')
      .update({ public_key_jwk: publicKeyJwk })
      .eq('id', userId);
    if (error) throw new Error(error.message);
    emit('keys:updated', { userId });
    return { ...user, publicKeyJwk };
  }

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
  kind?: string | null;
  title?: string | null;
  target?: string | null;
}

function rowToChat(row: ChatRow, participants: string[]): Chat {
  return {
    id: row.id,
    participants,
    createdAt: Number(row.created_at ?? 0),
    ownerId: row.owner_id ?? undefined,
    saved: row.saved === true,
    secret: row.secret === true,
    kind: (row.kind as ChatKind | undefined) ?? undefined,
    title: row.title ?? undefined,
    target: row.target ?? undefined,
  };
}

const CHAT_FIELDS = 'id,created_at,saved,owner_id,secret,kind,title,target';

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
  const row: ChatRow = {
    id: chatId,
    created_at: Date.now(),
    saved: false,
    owner_id: a,
    secret: false,
  };

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

/**
 * Создать групповой чат. Участники — владелец и выбранные пользователи.
 * Пустой список допустим: чат можно наполнить позже из настроек.
 */
export async function createGroupChat(
  ownerId: string,
  title: string,
  memberIds: string[],
): Promise<Chat> {
  const members = Array.from(new Set(memberIds.filter((id) => id && id !== ownerId)));
  const chatId = uid();
  const cleanTitle = title.trim() || 'Групповой чат';
  const row: ChatRow = {
    id: chatId,
    created_at: Date.now(),
    saved: false,
    owner_id: ownerId,
    secret: false,
    kind: 'group',
    title: cleanTitle,
    target: null,
  };

  const { error: chatError } = await supabase().from('chats').insert(row);
  if (chatError) throw new Error(chatError.message);

  const all = [ownerId, ...members];
  const { error: partsError } = await supabase()
    .from('chat_participants')
    .insert(all.map((id) => ({ chat_id: chatId, user_id: id })));
  if (partsError) throw new Error(partsError.message);

  emit('chat:updated', { chatId });
  void broadcastChat(chatId);
  return rowToChat(row, all);
}

/**
 * Добавить участников в существующий чат. Повторные добавления игнорируются.
 * Возвращает число реально добавленных людей.
 */
export async function addChatParticipants(
  chatId: string,
  userIds: string[],
): Promise<number> {
  const wanted = Array.from(new Set(userIds.filter(Boolean)));
  if (wanted.length === 0) return 0;

  const existing = (await unwrap(
    supabase().from('chat_participants').select('user_id').eq('chat_id', chatId),
  )) as { user_id: string }[];
  const have = new Set((existing ?? []).map((r) => r.user_id));
  const toAdd = wanted.filter((id) => !have.has(id));
  if (toAdd.length === 0) return 0;

  const { error } = await supabase()
    .from('chat_participants')
    .insert(toAdd.map((id) => ({ chat_id: chatId, user_id: id })));
  if (error) throw new Error(error.message);

  emit('chat:updated', { chatId });
  void broadcastChat(chatId);
  return toAdd.length;
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

/**
 * Автоматические чаты взвода (Ч.3): вызывается при входе/старте. Серверная
 * функция ensure_auto_chats создаёт недостающие чаты (взвод, командир, курсовой,
 * преподаватели) и возвращает их id. После этого список чатов перечитывается.
 */
export async function ensureAutoChats(userId: string): Promise<string[]> {
  try {
    const data = await unwrap<string[]>(supabase().rpc('ensure_auto_chats', { p_user: userId }));
    const ids = (data ?? []).filter(Boolean);
    if (ids.length > 0) {
      emit('chat:updated', {});
      void broadcastChat(ids[0]);
    }
    return ids;
  } catch (e) {
    console.warn('ensureAutoChats failed', e);
    return [];
  }
}

/**
 * Создать общий чат с выбранным взводом (Ч.3.3). Разрешено пользователям
 * с role_level > 1. Возвращает id чата (нового или уже существующего).
 */
export async function createSquadGroupChat(userId: string, squad: string): Promise<string | null> {
  try {
    const data = await unwrap<string>(supabase().rpc('create_squad_group_chat', {
      p_creator: userId,
      p_squad: squad.trim(),
    }));
    const id = data ?? null;
    if (id) {
      emit('chat:updated', {});
      void broadcastChat(id);
    }
    return id;
  } catch (e) {
    console.warn('createSquadGroupChat failed', e);
    return null;
  }
}

/** Список взводов (групп) в системе — для выбора целевого взвода */
export async function getSquadList(): Promise<string[]> {
  const users = await getAllUsers();
  const squads = new Set<string>();
  for (const u of users) {
    const g = u.group.trim();
    if (!g) continue;
    squads.add(g.endsWith('взвод') ? g : `${g} взвод`);
  }
  return Array.from(squads).sort((a, b) => a.localeCompare(b, 'ru'));
}

/** Создать оповещение (рассылка). НЕ создаёт чат — сохраняет запись в broadcasts
 *  и адресует получателям. Доступно пользователям с role_level > 1.
 *  Для custom получатели передаются в targetUserIds (выбор из контактов). */
export async function sendBroadcast(
  userId: string,
  targetType: 'squad' | 'course' | 'faculty' | 'university' | 'custom',
  targetValue: string,
  title: string,
  targetUserIds?: string[],
): Promise<string | null> {
  try {
    const data = await unwrap<string>(
      supabase().rpc('send_broadcast', {
        p_sender: userId,
        p_target_type: targetType,
        p_target_value: targetValue,
        p_text: title,
        p_target_user_ids: targetUserIds ?? [],
      }),
    );
    const id = data ?? null;
    if (id) emit('broadcast:new', {});
    return id;
  } catch (e) {
    console.warn('sendBroadcast failed', e);
    return null;
  }
}

/** Список оповещений, адресованных пользователю (отправителю или получателю). */
export async function getMyBroadcasts(userId: string): Promise<Broadcast[]> {
  const fields = 'id,sender_id,target_type,target_value,text,target_user_ids,created_at';
  type Row = {
    id: string;
    sender_id: string;
    target_type: string;
    target_value: string | null;
    text: string;
    target_user_ids: string[] | null;
    created_at: number | string;
  };

  const collected = new Map<string, Row>();

  // 1. Свои оповещения.
  try {
    const sent = (await unwrap(
      supabase()
        .from('broadcasts')
        .select(fields)
        .eq('sender_id', userId)
        .order('created_at', { ascending: false })
        .limit(200),
    )) as Row[];
    for (const row of sent ?? []) collected.set(row.id, row);
  } catch {
    /* покажем хотя бы полученные */
  }

  // 2. Полученные: сначала id из леджера получателей, затем сами оповещения.
  // Подзапрос внутри or() PostgREST не поддерживает — он парсит его как uuid.
  try {
    const recipients = (await unwrap(
      supabase().from('broadcast_recipients').select('broadcast_id').eq('user_id', userId),
    )) as { broadcast_id: string }[];
    const ids = Array.from(new Set((recipients ?? []).map((r) => r.broadcast_id)));
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const rows = (await unwrap(
        supabase()
          .from('broadcasts')
          .select(fields)
          .in('id', chunk)
          .order('created_at', { ascending: false })
          .limit(200),
      )) as Row[];
      for (const row of rows ?? []) collected.set(row.id, row);
    }
  } catch {
    /* оповещения придут при следующем открытии */
  }

  return Array.from(collected.values())
    .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))
    .slice(0, 200)
    .map((r) => ({
      id: r.id,
      senderId: r.sender_id,
      targetType: r.target_type as Broadcast['targetType'],
      targetValue: r.target_value ?? undefined,
      text: r.text,
      targetUserIds: r.target_user_ids ?? undefined,
      createdAt: Number(r.created_at ?? 0),
    }));
}

// --- архив чатов -----------------------------------------------------------------

/** CHAT_ARCHIVE_IDS — заархивированные id чатов текущего пользователя */
export async function getArchivedChatIds(userId: string): Promise<string[]> {
  const rows = (await unwrap(
    supabase().from('chat_archive').select('chat_id').eq('user_id', userId),
  )) as { chat_id: string }[];
  return (rows ?? []).map((r) => r.chat_id);
}

/** Заархивировать чат (скрыть из основного списка, оставить доступным) */
export async function archiveChat(userId: string, chatId: string): Promise<void> {
  const { error } = await supabase()
    .from('chat_archive')
    .upsert({ user_id: userId, chat_id: chatId, archived_at: Date.now() }, { onConflict: 'user_id,chat_id' });
  if (error) throw new Error(error.message);
  emit('chat:updated', { chatId });
}

/** Разархивировать чат */
export async function unarchiveChat(userId: string, chatId: string): Promise<void> {
  const { error } = await supabase()
    .from('chat_archive')
    .delete()
    .eq('user_id', userId)
    .eq('chat_id', chatId);
  if (error) throw new Error(error.message);
  emit('chat:updated', { chatId });
}

// --- контакты -------------------------------------------------------------------

export interface ContactEntry {
  userId: string;
  folder: string;
  user: User;
  addedAt: number;
}

/** Все контакты пользователя: профили людей + папка */
export async function getContacts(userId: string): Promise<ContactEntry[]> {
  const rows = (await unwrap(
    supabase().from('contacts').select('user_id,folder,created_at').eq('owner_id', userId),
  )) as { user_id: string; folder: string; created_at: number | string }[];
  if (!rows || rows.length === 0) return [];

  const profiles = (await unwrap(
    supabase().from('profiles').select(await publicProfileFields()).in('id', rows.map((r) => r.user_id)),
  )) as ProfileRow[];
  const byId = new Map(profiles.map((p) => [p.id, rowToUser(p)]));

  return rows
    .map((r) => {
      const u = byId.get(r.user_id);
      return u
        ? { userId: r.user_id, folder: r.folder || 'Общие', user: u, addedAt: Number(r.created_at ?? 0) }
        : null;
    })
    .filter((x): x is ContactEntry => x !== null)
    .sort((a, b) => a.user.fullName.localeCompare(b.user.fullName, 'ru'));
}

/** Добавить пользователя в контакты (в папку «Общие») */
export async function addContact(ownerId: string, userId: string): Promise<void> {
  const { error } = await supabase()
    .from('contacts')
    .upsert({ owner_id: ownerId, user_id: userId, folder: 'Общие', created_at: Date.now() }, { onConflict: 'owner_id,user_id' });
  if (error) throw new Error(error.message);
  emit('chat:updated', {});
}

/** Убрать из контактов */
export async function removeContact(ownerId: string, userId: string): Promise<void> {
  const { error } = await supabase()
    .from('contacts')
    .delete()
    .eq('owner_id', ownerId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  emit('chat:updated', {});
}

/** Перенести контакт в другую папку (drag-and-drop) */
export async function moveContactToFolder(ownerId: string, userId: string, folder: string): Promise<void> {
  const { error } = await supabase()
    .from('contacts')
    .update({ folder })
    .eq('owner_id', ownerId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  emit('chat:updated', {});
}

/** Все id пользователей, которых пользователь добавил в контакты */
export async function getContactIds(ownerId: string): Promise<Set<string>> {
  const rows = (await unwrap(
    supabase().from('contacts').select('user_id').eq('owner_id', ownerId),
  )) as { user_id: string }[];
  return new Set((rows ?? []).map((r) => r.user_id));
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
  deleted_for: string[] | null;
  storage_path: string | null;
  group_keys: Record<string, { w: string; i: string }> | null;
  created_at: number | string;
}

const MESSAGE_FIELDS =
  'id,chat_id,sender_id,ciphertext,iv,wrapped_key,wrapped_key_iv,wrapped_self_key,' +
  'wrapped_self_key_iv,reply_to_id,type,mime_type,duration,waveform,status,edited_at,deleted,' +
  'deleted_for,storage_path,group_keys,created_at';

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
    deletedFor: row.deleted_for ?? undefined,
    storagePath: row.storage_path ?? undefined,
    groupKeys: row.group_keys ?? undefined,
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
        supabase().from('profiles').select(await publicProfileFields()).in('id', peerIds),
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
    // Групповой — только чат, где реально несколько участников, либо
    // очевидно групповые kind (squad/teachers/group/broadcast). Личные
    // авточаты «С командиром взвода» (commander) и «С курсовым» (course)
    // имеют ровно двух участников и должны показывать имя собеседника.
    const groupedKind = row.kind === 'squad' || row.kind === 'teachers' || row.kind === 'group' || row.kind === 'broadcast';
    const isGroup = groupedKind || chatParts.length > 2;
    let peer: User | undefined;
    if (isGroup) {
      // Групповой чат: «собеседник» — заголовок/взвод, чтобы список чатов имел имя.
      peer = {
        id: row.id,
        login: '',
        fullName: row.title ?? 'Групповой чат',
        group: row.target ?? '',
        role: 'cadet',
        publicKeyJwk: {},
        createdAt: 0,
      };
    } else {
      const peerId = chatParts.find((id) => id !== userId) ?? userId;
      peer = byId.get(peerId);
    }
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

  // Дедупликация: авточаты (взвод, командир, курс, преподаватели) могли
  // завестись дважды с разными id и даже без target. Ключ — тип + номер:
  // «152 взвод» и target «152» дают один ключ. Из дублей оставляем чат,
  // где больше участников, затем — с более свежим сообщением.
  const autoIndex = new Map<string, number>();
  const deduped: typeof list = [];
  for (const item of list) {
    const kind = item.chat.kind ?? '';
    const isAuto =
      kind === 'squad' ||
      kind === 'commander' ||
      kind === 'course' ||
      kind === 'teachers' ||
      kind === 'group';
    if (!isAuto) {
      deduped.push(item);
      continue;
    }
    const raw = item.chat.target || item.chat.title || '';
    const digits = (raw.match(/\d+/) ?? [''])[0];
    // «group» и «squad» — один и тот же чат взвода: сводим к общему ключу.
    const keyKind = kind === 'group' ? 'squad' : kind;
    const autoKey = `${keyKind}:${digits}`;
    const existing = autoIndex.get(autoKey);
    if (existing === undefined) {
      autoIndex.set(autoKey, deduped.length);
      deduped.push(item);
      continue;
    }
    const kept = deduped[existing];
    const keptMembers = kept.chat.participants?.length ?? 0;
    const nextMembers = item.chat.participants?.length ?? 0;
    const keptFresh = kept.lastMessage?.createdAt ?? 0;
    const nextFresh = item.lastMessage?.createdAt ?? 0;
    if (nextMembers > keptMembers || (nextMembers === keptMembers && nextFresh > keptFresh)) {
      deduped[existing] = item;
    }
  }

  deduped.sort((a, b) => {
    const at = a.lastMessage?.createdAt ?? a.chat.createdAt;
    const bt = b.lastMessage?.createdAt ?? b.chat.createdAt;
    return bt - at;
  });
  return deduped;
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

const OFFLINE_QUEUE_KEY = 'svyaz.offlineQueue';

/** Сообщения, ожидающие отправки при возврате сети (переживают перезагрузку) */
export interface QueuedMessage {
  msg: Message;
  queuedAt: number;
}

function hasNetwork(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

function readQueued(): QueuedMessage[] {
  try {
    const raw = window.localStorage.getItem(OFFLINE_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedMessage[]) : [];
  } catch {
    return [];
  }
}

function writeQueued(items: QueuedMessage[]): void {
  try {
    window.localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(items));
  } catch {
    /* не критично */
  }
}

/**
 * Отложенные сообщения из локальной очереди. Лента склеивает их с данными
 * из базы, иначе очередное обновление списка «съедало» бы неотправленное
 * сообщение и оно мигало бы при каждом событии.
 */
export function getQueuedMessages(chatId?: string): Message[] {
  return readQueued()
    .map((q) => q.msg)
    .filter((m) => !chatId || m.chatId === chatId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Немедленно отправить сообщение в Supabase.
 * @returns true, если запись успешна; false при отсутствии сети.
 */
async function insertMessageRowNow(msg: Message): Promise<boolean> {
  if (!hasNetwork()) return false;
  const { error } = await supabase().from('messages').insert(messageToRow(msg));
  if (error) return false;
  return true;
}

/**
 * Оптимистичная отправка: сразу сообщаем своему окну о новом сообщении
 * (полный объект на руках), чтобы оно мгновенно появилось в ленте, а запись
 * в Supabase происходит после. При отсутствии сети сообщение попадает в
 * очередь и отправится автоматически, как только сеть вернётся.
 */
export async function saveMessageOptimistic(
  msg: Message,
  onError?: (error: unknown) => void,
): Promise<void> {
  // Сразу помечаем сообщение «в очереди», если сети заведомо нет: в ленте
  // появится часик, а не ложная галочка «отправлено».
  if (!hasNetwork()) msg.status = 'queued';

  // 1. Мгновенно — в своё окно, без ожидания сети.
  emit('message:new', { chatId: msg.chatId, message: msg });
  emit('chat:updated', { chatId: msg.chatId });
  void broadcastMessage({
    chatId: msg.chatId,
    messageId: msg.id,
    senderId: msg.senderId,
    kind: 'new',
  });

  // 2. Запись в базу: если сети нет или запрос сорвался — ставим в очередь,
  // сообщение не теряется и уйдёт автоматически при возврате сети.
  let written = false;
  try {
    written = await insertMessageRowNow(msg);
  } catch (error) {
    onError?.(error);
    written = false;
  }
  if (!written) {
    msg.status = 'queued';
    const queued: QueuedMessage[] = readQueued();
    queued.push({ msg, queuedAt: Date.now() });
    writeQueued(queued);
    emit('message:updated', { chatId: msg.chatId, messageId: msg.id });
  }
}

/** Забрать и отправить все отложенные сообщения (вызывается при online). */
export async function flushOfflineQueue(): Promise<number> {
  const queued = readQueued();
  if (queued.length === 0) return 0;
  const toSend = [...queued];
  writeQueued([]);

  let sent = 0;
  const remaining: QueuedMessage[] = [];
  for (const item of toSend) {
    try {
      // Если запись не удалась (сеть всё ещё нет) — вернём в конец очереди.
      if (!(await insertMessageRowNow(item.msg))) {
        remaining.push(item);
        continue;
      }
      // Полная синхронизация: другие устройства и эта лента перечитают.
      if (item.msg.status === 'queued') {
        await supabase()
          .from('messages')
          .update({ status: 'sent' })
          .eq('id', item.msg.id)
          .then(({ error }) => {
            if (error) console.warn('flush queue status', error.message);
          });
      }
      emit('message:updated', { chatId: item.msg.chatId, messageId: item.msg.id });
      sent += 1;
    } catch {
      remaining.push(item);
    }
  }
  if (remaining.length > 0) writeQueued([...remaining, ...readQueued()]);
  return sent;
}

// Глобальный обработчик: при возврате сети досылаем очередь и уведомляем чат.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void flushOfflineQueue().then(() => {
      emit('chat:updated', {});
    });
  });
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
    // «queued» — клиентский статус (офлайн-очередь). В базе допустимы только
    // sent/delivered/read, поэтому при записи превращаем его в sent.
    status: msg.status === 'queued' ? 'sent' : (msg.status ?? 'sent'),
    deleted_for: msg.deletedFor ?? [],
    storage_path: msg.storagePath ?? null,
    group_keys: msg.groupKeys ?? null,
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
  if (patch.groupKeys !== undefined) row.group_keys = patch.groupKeys;
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
  if (await hasFeature('rpc_status')) {
    try {
      await unwrap(supabase().rpc('mark_delivered', { p_user: userId }));
      emit('message:updated', {});
      void broadcastMessage({ chatId: '', kind: 'updated' });
      return;
    } catch {
      /* RPC объявлен, но недоступен — уходим в резервный путь */
    }
  }

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
  if (await hasFeature('rpc_status')) {
    try {
      await unwrap(
        supabase().rpc('mark_chat_read', { p_chat: chatId, p_user: userId }),
      );
      emit('message:updated', { chatId });
      void broadcastMessage({ chatId, kind: 'updated' });
      return;
    } catch {
      /* резервный путь ниже */
    }
  }

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
/**
 * «Удалить у себя»: сообщение скрывается только для вызывающего пользователя
 * (добавляем его id в deleted_for), контент/медиа при этом остаются на месте —
 * собеседник видит сообщение в обычном виде.
 */
export async function softDeleteMessage(msg: Message, userId: string): Promise<void> {
  let done = false;
  if (await hasFeature('rpc_hide')) {
    try {
      await unwrap(supabase().rpc('hide_message', { p_msg: msg.id, p_user: userId }));
      done = true;
    } catch {
      done = false;
    }
  }
  if (!done) {
    const deletedFor = Array.from(new Set([...(msg.deletedFor ?? []), userId]));
    const { error } = await supabase()
      .from('messages')
      .update({ deleted_for: deletedFor })
      .eq('id', msg.id);
    if (error) throw new Error(error.message);
  }
  emit('message:updated', { messageId: msg.id, chatId: msg.chatId });
  void broadcastMessage({ chatId: msg.chatId, messageId: msg.id, kind: 'updated' });
}

/**
 * «Удалить у всех» — доступно отправителю в течение 15 минут после отправки.
 * Удаляет и из БД, и файл из Supabase Storage (если медиа в bucket 'media').
 */
export async function deleteMessageForAll(msg: Message, userId: string): Promise<void> {
  if (msg.senderId !== userId) throw new Error('Удалять можно только свои сообщения');
  const elapsed = Date.now() - msg.createdAt;
  if (elapsed > 15 * 60 * 1000) throw new Error('Удалить у всех можно только в течение 15 минут после отправки');
  // Полное удаление строки — исчезает и у собеседника, и из экспорта.
  await supabase().from('media').delete().eq('msg_id', msg.id);
  if (msg.storagePath) await deleteStoredMedia(msg.storagePath).catch(() => {});
  const { error } = await supabase().from('messages').delete().eq('id', msg.id);
  if (error) throw new Error(error.message);
  emit('message:updated', { messageId: msg.id, chatId: msg.chatId });
  void broadcastMessage({ chatId: msg.chatId, messageId: msg.id, kind: 'updated' });
}

/** Скрыть историю чата ТОЛЬКО у себя (у собеседников сообщения остаются). */
export async function clearChatHistory(chatId: string, userId: string): Promise<void> {
  let done = false;
  if (await hasFeature('rpc_hide')) {
    try {
      await unwrap(supabase().rpc('hide_chat', { p_chat: chatId, p_user: userId }));
      done = true;
    } catch {
      done = false;
    }
  }
  if (!done) {
    // Совместимость со старой базой: помечаем сообщения по одному,
    // ничего не удаляя у других участников и не трогая медиа.
    const list = await getMessages(chatId);
    for (const m of list) {
      if ((m.deletedFor ?? []).includes(userId)) continue;
      const deletedFor = [...(m.deletedFor ?? []), userId];
      await supabase().from('messages').update({ deleted_for: deletedFor }).eq('id', m.id);
    }
    await supabase()
      .from('read_state')
      .delete()
      .eq('chat_id', chatId)
      .eq('user_id', userId);
  }
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
  /** групповое шифрование: ключ контента для каждого участника */
  groupKeys?: Record<string, { w: string; i: string }>;
  createdAt: number;
}

/**
 * Медиа-сообщение.
 *
 * Новые медиа загружаются в Supabase Storage (bucket 'media') зашифрованным
 * файлом, в messages сохраняется storage_path. Порядок важен: RLS на media/
 * Storage разрешает вставку только участнику чата, а участником он становится
 * по строке messages. Поэтому сначала сообщение, потом файл; и только после
 * успеха обоих — уведомление собеседнику, чтобы он не открыл сообщение,
 * у которого ещё нет медиа.
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
    groupKeys: meta.groupKeys,
    status: 'sent',
    createdAt: meta.createdAt,
    ciphertext: '',
    iv: '',
  };
  // 1. Сначала строка сообщения: политики RLS на Storage и таблицу media
  // разрешают запись только участнику существующего сообщения.
  await insertMessageRow(msg);

  let stored = false;
  try {
    // Новые медиа всегда идут в Storage; в messages кладём только ссылку.
    const storagePath = await uploadStoredMedia(meta.id, envelope);
    const { error } = await supabase()
      .from('messages')
      .update({ storage_path: storagePath })
      .eq('id', meta.id);
    if (error) throw new Error(error.message);
    msg.storagePath = storagePath;
    stored = true;
  } catch {
    // Если Storage недоступен (bucket не создан) — фолбэк на старую схему
    // хранения в таблице media, чтобы отправка не падала целиком.
    try {
      await saveMedia(meta.id, { ...envelope, mimeType: meta.mimeType });
      stored = true;
    } catch (error) {
      // Не оставляем в ленте сообщение без медиа: убираем строку и сообщаем.
      await supabase().from('messages').delete().eq('id', meta.id);
      throw error;
    }
  }

  if (stored) announceMessage(msg);
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

// --- медиа в Supabase Storage (bucket 'media') ------------------------------------
// Новые медиа шифруются на клиенте и загружаются в Storage как двоичный файл,
// чтобы не раздувать базу (200 пользователей × base64 быстро съели бы бесплатные
// 1 ГБ). В таблице messages храним только storage_path (URL), а старые сообщения
// продолжают читаться из таблицы media (фолбэк).

const MEDIA_BUCKET = 'media';

function mediaPath(msgId: string): string {
  return `chat/${msgId}.bin`;
}

/**
 * Загрузить зашифрованное медиа в Storage. Возвращает public URL объекта.
 * Файл двоичный (шифротекст + iv + обёрнутые ключи сложены в один буфер),
 * имя выводится из id сообщения — перезапись безопасна (upsert).
 */
export async function uploadStoredMedia(msgId: string, envelope: EnvelopeFields): Promise<string> {
  const payload = JSON.stringify({
    v: 1,
    ...envelope,
  });
  const blob = new Blob([payload], { type: 'application/octet-stream' });
  const path = mediaPath(msgId);
  const { error } = await supabase().storage.from(MEDIA_BUCKET).upload(path, blob, {
    upsert: true,
    contentType: 'application/octet-stream',
  });
  if (error) throw new Error(error.message);
  // Храним именно путь: бакет приватный, публичный URL не откроется,
  // а download() по пути работает для участников чата.
  return path;
}

/** Получить URL объекта в Storage по его public URL (для скачивания). */
function storageObjectPathFromUrl(url: string): string | null {
  const marker = '/object/public/';
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return url.slice(idx + marker.length).replace(`${MEDIA_BUCKET}/`, '');
}

/** Удалить зашифрованный файл медиа из Storage (обратная операция к uploadStoredMedia). */
export async function deleteStoredMedia(pathOrUrl: string): Promise<void> {
  const path = pathOrUrl.includes('/object/public/')
    ? (storageObjectPathFromUrl(pathOrUrl) ?? pathOrUrl)
    : pathOrUrl;
  if (!path) return;
  const { error } = await supabase().storage.from(MEDIA_BUCKET).remove([path]);
  if (error) throw new Error(error.message);
}

/**
 * Скачать и собрать EnvelopeFields из Storage. Возвращает null, если объекта
 * нет или он повреждён.
 */
export async function getStoredMediaEnvelope(pathOrUrl: string): Promise<EnvelopeFields | null> {
  try {
    const path = pathOrUrl.includes('/object/public/')
      ? (storageObjectPathFromUrl(pathOrUrl) ?? pathOrUrl)
      : pathOrUrl;
    const { data, error } = await supabase().storage.from(MEDIA_BUCKET).download(path);
    if (error || !data) return null;
    const text = await data.text();
    const parsed = JSON.parse(text) as EnvelopeFields & { v?: number };
    if (!parsed.ciphertext || !parsed.iv) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Расшифрованное медиа в виде Blob. Если медиа лежит в Storage и объекта там
 * нет, бросает ошибку с пометкой `.code === 'MEDIA_NOT_FOUND'` — интерфейс
 * показывает «Файл недоступен» вместо бесконечной «Загрузка…».
 */
export async function getDecryptedMediaBlob(
  msg: Message,
  userId: string,
): Promise<Blob | null> {
  // 1) Новый формат: медиа в Storage.
  if (msg.storagePath) {
    const envelope = await getStoredMediaEnvelope(msg.storagePath);
    if (!envelope) throw new MediaNotFoundError();
    return decryptEnvelopeToBlob(msg, userId, envelope);
  }
  // 2) Старый формат: медиа в таблице media.
  const stored = await getMedia(msg.id);
  if (!stored) return null;
  return decryptEnvelopeToBlob(msg, userId, stored);
}

/** Маркер-ошибка: зашифрованный файл не найден в Storage. */
class MediaNotFoundError extends Error {
  code = 'MEDIA_NOT_FOUND' as const;
}

async function decryptEnvelopeToBlob(
  msg: Message,
  userId: string,
  envelope: EnvelopeFields,
): Promise<Blob | null> {
  const sender = await getUserById(msg.senderId);
  if (!sender) return null;
  const peerPublicKeyJwk = await getPeerPublicKeyJwk(msg.chatId, userId);
  try {
    const buf = await decryptEnvelope({
      myId: userId,
      own: msg.senderId === userId,
      senderPublicKeyJwk: sender.publicKeyJwk,
      peerPublicKeyJwk: peerPublicKeyJwk ?? undefined,
      envelope,
    });
    return new Blob([buf], { type: msg.mimeType ?? 'application/octet-stream' });
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
  // Групповое сообщение: расшифровываем через groupKeys[userId]
  if (msg.groupKeys) {
    try {
      const bytes = await decryptGroupEnvelope({
        myId: userId,
        senderPublicKeyJwk: sender.publicKeyJwk,
        groupKeys: msg.groupKeys,
        envelope: msg,
      });
      return new TextDecoder().decode(bytes);
    } catch (err) {
      console.warn('readMessageText group decrypt failed', safeError(err));
      return null;
    }
  }
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

/** Последний визит и разрешение показывать его другим. */
export async function getPresence(
  userId: string,
): Promise<{ lastSeen: number; showLastSeen: boolean } | null> {
  try {
    const rows = (await unwrap(
      supabase()
        .from('presence')
        .select('last_seen,show_last_seen')
        .eq('user_id', userId)
        .limit(1),
    )) as { last_seen: number | string; show_last_seen?: boolean }[];
    const row = (rows ?? [])[0];
    if (!row) return null;
    return { lastSeen: Number(row.last_seen ?? 0), showLastSeen: row.show_last_seen !== false };
  } catch {
    // Старая схема без show_last_seen: считаем, что показывать разрешено.
    try {
      const rows = (await unwrap(
        supabase().from('presence').select('last_seen').eq('user_id', userId).limit(1),
      )) as { last_seen: number | string }[];
      const row = (rows ?? [])[0];
      if (!row) return null;
      return { lastSeen: Number(row.last_seen ?? 0), showLastSeen: true };
    } catch {
      return null;
    }
  }
}

/** Сохранить настройку «показывать время последнего визита». */
export async function setLastSeenVisible(userId: string, visible: boolean): Promise<boolean> {
  const { error } = await supabase()
    .from('presence')
    .upsert(
      { user_id: userId, last_seen: Date.now(), show_last_seen: visible },
      { onConflict: 'user_id' },
    );
  if (error) {
    console.warn('last seen visibility update failed', error.message);
    return false;
  }
  return true;
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
  const uid = getCurrentUserId();
  const token = storage.getSessionToken();
  if (token) {
    try {
      void supabase().rpc('revoke_session_token', { p_token: token });
    } catch {
      /* старая база без RPC — токена там всё равно нет */
    }
    setSessionToken(null);
  }
  // Безопасность: при выходе убираем с устройства приватный ключ E2EE,
  // кэш сообщений и неотправленную очередь — следующий пользователь
  // за этим компьютером не получит доступ к переписке.
  if (uid) clearPrivateKey(uid);
  storage.setCurrentUserId(null);
  clearLocalMessageCache();
  writeQueued([]);
  setSupabaseUser(null);
  emit('auth:changed', null);
}

/**
 * После обновления схемы старые сессии (без токена) недействительны:
 * если токена нет, а пользователь сохранён — разлогиниваемся, чтобы человек
 * вошёл заново и получил подписанную сессию.
 */
export async function ensureSessionToken(): Promise<void> {
  if (!(await hasFeature('auth_tokens'))) return;
  if (storage.getSessionToken()) return;
  if (storage.getCurrentUserId()) logout();
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

// --- админ-панель --------------------------------------------------------------

/** Является ли текущий пользователь админом (используется для гварда страницы) */
export async function isCurrentUserAdmin(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const user = await getUserById(userId);
  return user?.role === 'admin';
}

/**
 * Сбросить пароль пользователя от имени админа. Так как админ не знает старого
 * пароля, старый зашифрованный приватный ключ становится неразбираемым —
 * поэтому генерируем свежую пару ECDH и шифруем её новым паролем.
 */
export async function adminResetPassword(
  userId: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < 6) throw new Error('Новый пароль короче 6 символов');
  const user = await getUserById(userId);
  if (!user) throw new Error('Пользователь не найден');
  const newHash = await hashPassword(user.login, newPassword);

  // Свежая пара ключей + зашифрованный новым паролем приватный ключ.
  let ok = false;
  if (isCryptoAvailable()) {
    const { publicKeyJwk, privateKeyJwk } = await generateUserKeys();
    const encrypted = await encryptPrivateKeyWithPassword(
      privateKeyJwk,
      `${user.login}:${newPassword}`,
    );
    const { error } = await supabase()
      .from('profiles')
      .update({ encrypted_private_key: encrypted, public_key_jwk: publicKeyJwk })
      .eq('id', userId);
    if (error) throw new Error(error.message);
  }

  const data = await unwrap<boolean>(
    supabase().rpc('admin_reset_password', {
      p_profile: userId,
      p_new_hash: newHash,
    }),
  );
  ok = Boolean(data);
  if (!ok) throw new Error('Нет прав администратора или пользователь не найден');
}

/** Обновить ФИО, группу, звание, должность и уровень прав (только админ) */
export async function adminUpdateProfile(
  userId: string,
  fullName: string,
  group: string,
  rank: string,
  position: string,
  roleLevel: number,
  department?: string,
): Promise<void> {
  const ok = await unwrap<boolean>(
    supabase().rpc('admin_update_profile', {
      p_profile: userId,
      p_full_name: fullName.trim(),
      p_group: group.trim(),
      p_rank: rank.trim(),
      p_position: position.trim(),
      p_role_level: roleLevel,
      p_department: department?.trim() ?? '',
    }),
  );
  if (!ok) throw new Error('Нет прав администратора или пользователь не найден');
}

/** Установить уникальный ник текущего пользователя (очистка — пустой строкой) */
export async function setMyUsername(username: string): Promise<void> {
  const ok = await unwrap<boolean>(supabase().rpc('set_username', { p_username: username.trim() }));
  if (!ok) throw new Error('Этот ник уже занят');
}

/** Статус и «О себе» текущего пользователя. */
export async function updateMyProfile(patch: {
  status?: string;
  bio?: string;
}): Promise<void> {
  if (!(await ensureProfileSocial())) {
    throw new Error('Статусы появятся после обновления схемы (profile_social)');
  }
  const id = storage.getCurrentUserId();
  if (!id) throw new Error('Нет активной сессии');
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status.trim() || null;
  if (patch.bio !== undefined) row.bio = patch.bio.trim() || null;
  if (Object.keys(row).length === 0) return;
  const { error } = await supabase().from('profiles').update(row).eq('id', id);
  if (error) throw new Error(error.message);
  emit('profile:updated', { userId: id });
}

/** Кто прочитал чат: last_read_at по каждому участнику (RLS — только свои чаты). */
export async function getChatReaders(
  chatId: string,
): Promise<Array<{ userId: string; lastReadAt: number }>> {
  const rows = (await unwrap(
    supabase()
      .from('read_state')
      .select('user_id,last_read_at')
      .eq('chat_id', chatId),
  )) as Array<{ user_id: string; last_read_at: number | string }>;
  return (rows ?? []).map((row) => ({
    userId: row.user_id,
    lastReadAt: Number(row.last_read_at ?? 0),
  }));
}

/** Полное удаление пользователя и всех его данных (только админ) */
export async function adminDeleteUser(userId: string): Promise<void> {
  const ok = await unwrap<boolean>(supabase().rpc('admin_delete_user', { p_profile: userId }));
  if (!ok) throw new Error('Нет прав администратора или пользователь не найден');
}

/** Сбросить все сессии пользователя (только админ) */
export async function adminLogoutUser(userId: string): Promise<void> {
  const ok = await unwrap<boolean>(supabase().rpc('admin_logout_user', { p_profile: userId }));
  if (!ok) throw new Error('Нет прав администратора или пользователь не найден');
}

/**
 * «Починить ключи»: сгенерировать и сохранить публичный ключ для пользователя
 * (или для всех сразу), у кого его нет. Админ не знает пароля пользователя,
 * поэтому приватная часть здесь не создаётся — её пользователь получит сам при
 * следующем входе (см. verifyLogin), что сохраняет принцип E2EE. Публичного
 * ключа достаточно, чтобы другие могли с ним связаться.
 *
 * Возвращает количество пользователей, которым ключ был создан.
 */
export async function adminFixKeys(
  userId: string | 'all',
): Promise<{ fixed: number; processed: number }> {
  const targets = userId === 'all' ? await getAllUsers() : [await getUserById(userId)];
  const valid = targets.filter((u): u is User => Boolean(u && u.id));

  let fixed = 0;
  let processed = 0;
  for (const u of valid) {
    const hasKey = Boolean(u.publicKeyJwk && u.publicKeyJwk.x && u.publicKeyJwk.y);
    if (hasKey) continue;
    processed += 1;
    if (!isCryptoAvailable()) continue;
    const { publicKeyJwk } = await generateUserKeys();
    const { error } = await supabase()
      .from('profiles')
      .update({ public_key_jwk: publicKeyJwk })
      .eq('id', u.id);
    if (error) throw new Error(`Не удалось починить ключи для ${u.login}: ${error.message}`);
    fixed += 1;
  }
  return { fixed, processed };
}

export function hasMyPrivateKey(userId: string): boolean {
  return getPrivateKey(userId) !== null;
}

export async function syncMasterHistory(
  userId: string,
  login: string,
  password: string,
): Promise<boolean> {
  const pass = `${login}:${password}`;
  const rows = (await unwrap(
    supabase().from('profiles').select('master_key_wrapped,private_key_master').eq('id', userId).limit(1),
  )) as Array<{ master_key_wrapped?: string; private_key_master?: string }>;
  const row = (rows ?? [])[0] ?? {};
  let masterKeyB64 = '';
  if (row.master_key_wrapped) {
    masterKeyB64 = await decryptSecretWithPassword(row.master_key_wrapped, pass);
  } else {
    masterKeyB64 = generateMasterKey();
    const wrapped = await encryptSecretWithPassword(masterKeyB64, pass);
    await supabase().from('profiles').update({ master_key_wrapped: wrapped }).eq('id', userId);
  }
  let restored = false;
  if (row.private_key_master) {
    const json = await decryptWithMasterKey(row.private_key_master, masterKeyB64);
    savePrivateKey(userId, JSON.parse(json) as JsonWebKey);
    restored = true;
  } else {
    const jwk = getPrivateKey(userId);
    if (jwk) {
      const encrypted = await encryptWithMasterKey(JSON.stringify(jwk), masterKeyB64);
      await supabase().from('profiles').update({ private_key_master: encrypted }).eq('id', userId);
    }
  }
  try {
    sessionStorage.setItem(`svyaz.master.`, masterKeyB64);
  } catch {
    /* приватный режим */
  }
  return restored;
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

// =====================================================================
// Админ-панель: журнал действий, статистика, чаты, оповещения,
// структура и настройки системы.
// =====================================================================

export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: string | null;
  createdAt: number;
}

/** Записать событие в журнал действий (не роняет вызывающий код при ошибке). */
export async function logAudit(
  actorId: string | null,
  action: string,
  targetType?: string | null,
  targetId?: string | null,
  details?: string | null,
): Promise<void> {
  if (!actorId) return;
  try {
    await supabase().rpc('log_audit', {
      p_actor: actorId,
      p_action: action,
      p_target_type: targetType ?? null,
      p_target_id: targetId ?? null,
      p_details: details ?? null,
    });
  } catch (e) {
    console.warn('logAudit failed', e);
  }
}

/** Журнал действий с фильтрами (админ). */export async function getAuditLog(filters: {
  actor?: string;
  action?: string;
  from?: number;
  to?: number;
  limit?: number;
}): Promise<AuditEntry[]> {
  let query = supabase()
    .from('audit_log')
    .select('id,actor_id,actor_name,action,target_type,target_id,details,created_at')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? 300);
  if (filters.actor?.trim()) query = query.ilike('actor_name', `%${filters.actor.trim()}%`);
  if (filters.action?.trim()) query = query.ilike('action', `%${filters.action.trim()}%`);
  if (filters.from) query = query.gte('created_at', filters.from);
  if (filters.to) query = query.lte('created_at', filters.to);
  const rows = (await unwrap(query)) as Array<{
    id: string;
    actor_id: string | null;
    actor_name: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    details: string | null;
    created_at: number | string;
  }>;
  return (rows ?? []).map((r) => ({
    id: r.id,
    actorId: r.actor_id,
    actorName: r.actor_name,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    details: r.details,
    createdAt: Number(r.created_at ?? 0),
  }));
}

/** Резервная копия доступных админу данных (без E2EE-сообщений). */
export async function exportBackup(): Promise<Record<string, unknown>> {
  const [users, departments, audit] = await Promise.all([
    getAllUsers(),
    getDepartments(),
    getAuditLog({ limit: 1000 }),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    users,
    departments,
    audit,
    note: 'Сообщения и файлы не включены: они зашифрованы на устройствах пользователей.',
  };
}

export interface AdminStats {
  usersTotal: number;
  usersOnline: number;
  usersOffline: number;
  messagesToday: number;
  messagesWeek: number;
  activeChats: number;
  /** 7 дней: { label, count } — для мини-графика */
  activity: Array<{ label: string; count: number }>;
}

/** Статистика для дашборда админ-панели. */
export async function getAdminStats(): Promise<AdminStats> {
  const now = Date.now();
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const todayMs = startToday.getTime();
  const weekMs = now - 7 * 24 * 60 * 60 * 1000;

  const users = (await unwrap(supabase().from('profiles').select('id'))) as { id: string }[];
  const presence = (await unwrap(
    supabase().from('presence').select('user_id,last_seen'),
  )) as { user_id: string; last_seen: number | string }[];

  const onlineThreshold = now - 5 * 60 * 1000; // 5 минут — считаем онлайн
  const onlineIds = new Set(
    (presence ?? [])
      .filter((p) => Number(p.last_seen ?? 0) > onlineThreshold)
      .map((p) => p.user_id),
  );

  const msgsToday = (await unwrap(
    supabase().from('messages').select('id').gte('created_at', todayMs),
  )) as { id: string }[];
  const msgsWeek = (await unwrap(
    supabase().from('messages').select('id').gte('created_at', weekMs),
  )) as { id: string }[];

  const weekChats = (await unwrap(
    supabase().from('messages').select('chat_id').gte('created_at', weekMs),
  )) as { chat_id: string }[];
  const activeChats = new Set((weekChats ?? []).map((m) => m.chat_id)).size;

  // Активность по дням за 7 дней.
  const weekMessages = (await unwrap(
    supabase().from('messages').select('created_at').gte('created_at', weekMs),
  )) as { created_at: number | string }[];
  const activity: Array<{ label: string; count: number }> = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const from = d.getTime();
    const to = from + 24 * 60 * 60 * 1000;
    const count = (weekMessages ?? []).filter((m) => {
      const t = Number(m.created_at ?? 0);
      return t >= from && t < to;
    }).length;
    activity.push({
      label: d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
      count,
    });
  }

  const total = (users ?? []).length;
  return {
    usersTotal: total,
    usersOnline: onlineIds.size,
    usersOffline: Math.max(0, total - onlineIds.size),
    messagesToday: (msgsToday ?? []).length,
    messagesWeek: (msgsWeek ?? []).length,
    activeChats,
    activity,
  };
}

export interface AdminChatRow {
  id: string;
  kind: string;
  title: string | null;
  target: string | null;
  createdAt: number;
  pinned: boolean;
  participants: string[];
  messageCount: number;
}

/** Все чаты системы (админ): участники, число сообщений, закрепление. */
export async function adminGetChats(): Promise<AdminChatRow[]> {
  // Основной путь — security definer RPC: RLS обычного select показал бы
  // администратору только чаты, где он сам участник.
  try {
    const rows = (await unwrap(
      supabase().rpc('admin_list_chats', { p_limit: 500 }),
    )) as Array<{
      id: string;
      created_at: number | string;
      kind: string | null;
      title: string | null;
      target: string | null;
      pinned: boolean | null;
      participants: string[] | null;
      message_count: number | null;
    }>;
    if (rows && rows.length > 0) {
      return rows.map((c) => ({
        id: c.id,
        kind: c.kind ?? 'direct',
        title: c.title,
        target: c.target,
        createdAt: Number(c.created_at ?? 0),
        pinned: Boolean(c.pinned),
        participants: c.participants ?? [],
        messageCount: Number(c.message_count ?? 0),
      }));
    }
  } catch {
    /* функция ещё не создана в живой базе — уходим на прямой запрос */
  }

  const hasPinned = await ensureChatsPinned();
  let q = supabase()
    .from('chats')
    .select(hasPinned ? 'id,created_at,kind,title,target,pinned' : 'id,created_at,kind,title,target')
    .order('created_at', { ascending: false })
    .limit(500);
  const chats = (await unwrap(q)) as Array<{
    id: string;
    created_at: number | string;
    kind: string | null;
    title: string | null;
    target: string | null;
    pinned?: boolean | null;
  }>;
  const ids = (chats ?? []).map((c) => c.id);
  if (ids.length === 0) return [];

  const parts = (await unwrap(
    supabase().from('chat_participants').select('chat_id,user_id').in('chat_id', ids),
  )) as { chat_id: string; user_id: string }[];
  const msgs = (await unwrap(
    supabase().from('messages').select('chat_id').in('chat_id', ids),
  )) as { chat_id: string }[];

  const partsByChat = new Map<string, string[]>();
  for (const p of parts ?? []) {
    const arr = partsByChat.get(p.chat_id) ?? [];
    arr.push(p.user_id);
    partsByChat.set(p.chat_id, arr);
  }
  const countByChat = new Map<string, number>();
  for (const m of msgs ?? []) {
    countByChat.set(m.chat_id, (countByChat.get(m.chat_id) ?? 0) + 1);
  }

  return (chats ?? []).map((c) => ({
    id: c.id,
    kind: c.kind ?? 'direct',
    title: c.title,
    target: c.target,
    createdAt: Number(c.created_at ?? 0),
    pinned: Boolean(c.pinned),
    participants: partsByChat.get(c.id) ?? [],
    messageCount: countByChat.get(c.id) ?? 0,
  }));
}

/** Есть ли в живой базе колонка chats.pinned. */
let chatsPinnedSupported: boolean | null = null;
async function ensureChatsPinned(): Promise<boolean> {
  if (chatsPinnedSupported !== null) return chatsPinnedSupported;
  try {
    const { error } = await supabase().from('chats').select('pinned').limit(1);
    chatsPinnedSupported = !error;
  } catch {
    chatsPinnedSupported = false;
  }
  return chatsPinnedSupported;
}

/** Удалить чат со всеми сообщениями (для всех участников). */
export async function adminDeleteChat(chatId: string): Promise<void> {
  const { error } = await supabase().from('chats').delete().eq('id', chatId);
  if (error) throw new Error(error.message);
}

/** Объединить дубли авточатов (SQL-функция admin_merge_duplicate_chats). */
export async function adminMergeDuplicateChats(): Promise<number> {
  if (!(await hasFeature('merge_chats'))) {
    throw new Error('Функция объединения не установлена — выполните schema.sql');
  }
  const data = await unwrap(supabase().rpc('admin_merge_duplicate_chats'));
  return Number(data ?? 0);
}

export interface AdminActivityPoint {
  day: string;
  count: number;
}

/** Активность сообщений по дням (по умолчанию 30 дней). */
export async function getAdminActivity(days = 30): Promise<AdminActivityPoint[]> {
  // Не дёргаем отсутствующую функцию: иначе в консоли будет 404, пока
  // обновлённый schema.sql не выполнен. Наличие фичи отмечается в app_settings.
  if (!(await hasFeature('admin_activity'))) {
    throw new Error('Функция графика ещё не установлена (выполните schema.sql)');
  }

  const rows = (await unwrap(
    supabase().rpc('admin_activity', { p_days: days }),
  )) as Array<{ day: string; count: number | string }>;
  return (rows ?? []).map((r) => ({ day: r.day, count: Number(r.count ?? 0) }));
}

/** Закрепить / открепить чат. */
export async function adminToggleChatPin(chatId: string, pinned: boolean): Promise<void> {
  const { error } = await supabase().from('chats').update({ pinned }).eq('id', chatId);
  if (error) throw new Error(error.message);
  emit('chat:updated', { chatId });
}

export interface AdminBroadcastRow {
  id: string;
  senderId: string;
  senderName: string;
  targetType: string;
  targetValue: string | null;
  text: string;
  createdAt: number;
  recipients: number;
  readCount: number;
}

/** Все оповещения системы с числом получателей и прочтений (админ). */
export async function adminGetBroadcasts(): Promise<AdminBroadcastRow[]> {
  const rows = (await unwrap(
    supabase()
      .from('broadcasts')
      .select('id,sender_id,target_type,target_value,text,created_at')
      .order('created_at', { ascending: false })
      .limit(300),
  )) as Array<{
    id: string;
    sender_id: string;
    target_type: string;
    target_value: string | null;
    text: string;
    created_at: number | string;
  }>;
  if (!rows || rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const recipients = (await unwrap(
    supabase().from('broadcast_recipients').select('broadcast_id,read_at').in('broadcast_id', ids),
  )) as { broadcast_id: string; read_at: number | string | null }[];

  const totalByB = new Map<string, number>();
  const readByB = new Map<string, number>();
  for (const r of recipients ?? []) {
    totalByB.set(r.broadcast_id, (totalByB.get(r.broadcast_id) ?? 0) + 1);
    if (r.read_at) readByB.set(r.broadcast_id, (readByB.get(r.broadcast_id) ?? 0) + 1);
  }

  const senderIds = Array.from(new Set(rows.map((r) => r.sender_id)));
  const profiles = (await unwrap(
    supabase().from('profiles').select('id,full_name').in('id', senderIds),
  )) as { id: string; full_name: string }[];
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

  return rows.map((r) => ({
    id: r.id,
    senderId: r.sender_id,
    senderName: nameById.get(r.sender_id) ?? '—',
    targetType: r.target_type,
    targetValue: r.target_value,
    text: r.text,
    createdAt: Number(r.created_at ?? 0),
    recipients: totalByB.get(r.id) ?? 0,
    readCount: readByB.get(r.id) ?? 0,
  }));
}

/** Удалить оповещение у всех получателей. */
export async function adminDeleteBroadcast(id: string): Promise<void> {
  const { error } = await supabase().from('broadcasts').delete().eq('id', id);
  if (error) throw new Error(error.message);
  emit('broadcast:new', {});
}

/** Изменить текст оповещения (если ещё не прочитано получателями). */
export async function adminUpdateBroadcastText(id: string, text: string): Promise<void> {
  const { error } = await supabase()
    .from('broadcasts')
    .update({ text: text.trim() })
    .eq('id', id);
  if (error) throw new Error(error.message);
  emit('broadcast:new', {});
}

export interface AppSettings {
  registrationEnabled: boolean;
  chatsDisabled: boolean;
  /** технический режим: диагностические подписи для администратора */
  techMode: boolean;
  mainAdminId: string;
}

/** Настройки системы. */
export async function getAppSettings(): Promise<AppSettings> {
  const rows = (await unwrap(
    supabase().from('app_settings').select('key,value'),
  )) as { key: string; value: string }[];
  const map = new Map((rows ?? []).map((r) => [r.key, r.value]));
  return {
    registrationEnabled: map.get('registration_enabled') === 'true',
    chatsDisabled: map.get('chats_disabled') === 'true',
    techMode: map.get('tech_mode') === 'true',
    mainAdminId: map.get('main_admin_id') ?? '',
  };
}

/** Изменить настройку системы (админ). */
export async function setAppSetting(key: string, value: string): Promise<void> {
  const { error } = await supabase()
    .from('app_settings')
    .upsert({ key, value, updated_at: Date.now() }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  emit('settings:changed', { key, value });
}

/** Добавить подразделение. */
export async function adminAddDepartment(name: string, kind = 'department'): Promise<void> {
  const { error } = await supabase()
    .from('departments')
    .insert({ id: uid(), name: name.trim(), kind, sort_order: 999 });
  if (error) throw new Error(error.message);
}

/** Переименовать подразделение. */
export async function adminRenameDepartment(id: string, name: string): Promise<void> {
  const { error } = await supabase()
    .from('departments')
    .update({ name: name.trim() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/** Удалить подразделение. */
export async function adminDeleteDepartment(id: string): Promise<void> {
  const { error } = await supabase().from('departments').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/** Пакетная смена взвода/группы у выбранных пользователей. */
export async function adminBulkMoveGroup(userIds: string[], group: string): Promise<void> {
  if (userIds.length === 0) return;
  const { error } = await supabase()
    .from('profiles')
    .update({ group_name: group.trim() })
    .in('id', userIds);
  if (error) throw new Error(error.message);
}

/** Пакетное удаление пользователей (только админ). */
export async function adminBulkDelete(userIds: string[]): Promise<void> {
  for (const id of userIds) {
    await adminDeleteUser(id);
  }
}

/** Пакетный сброс пароля выбранным пользователям. */
export async function adminBulkResetPassword(
  userIds: string[],
  newPassword: string,
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const id of userIds) {
    try {
      await adminResetPassword(id, newPassword);
      ok += 1;
    } catch {
      failed += 1;
    }
  }
  return { ok, failed };
}

export interface ImportUserRow {
  fullName: string;
  login: string;
  password: string;
  group: string;
  rank?: string;
  position?: string;
  department?: string;
  roleLevel?: number;
}

/** Импорт пользователей из CSV-строк. Возвращает отчёт по каждой строке. */
export async function adminImportUsers(
  rows: ImportUserRow[],
): Promise<{ created: number; failed: Array<{ login: string; reason: string }> }> {
  let created = 0;
  const failed: Array<{ login: string; reason: string }> = [];
  for (const row of rows) {
    try {
      const login = row.login.trim().toLowerCase();
      if (!login || !row.fullName.trim()) throw new Error('пустое ФИО или логин');
      const exists = (await unwrap(
        supabase().from('profiles').select('id').eq('login', login).limit(1),
      )) as { id: string }[];
      if ((exists ?? []).length > 0) throw new Error('логин занят');

      const password = row.password.trim() || 'test1234';
      const hash = await hashPassword(login, password);
      const id = uid();
      const groupName = row.group?.trim() ?? '';
      const positionName = row.position?.trim() || null;
      const rankName =
        row.rank?.trim() || autoAssignRankForGroup(groupName, positionName);
      const { error: pErr } = await supabase().from('profiles').insert({
        id,
        login,
        full_name: row.fullName.trim(),
        group_name: groupName,
        role: 'cadet',
        military_rank: rankName,
        position: positionName,
        role_level: row.roleLevel ?? 1,
        department: row.department?.trim() || null,
        avatar_url: null,
        created_at: Date.now(),
      });
      if (pErr) throw new Error(pErr.message);

      const { error: cErr } = await supabase()
        .from('credentials')
        .insert({ profile_id: id, password_hash: hash });
      if (cErr) throw new Error(cErr.message);

      created += 1;
    } catch (e) {
      failed.push({ login: row.login, reason: e instanceof Error ? e.message : 'ошибка' });
    }
  }
  return { created, failed };
}





