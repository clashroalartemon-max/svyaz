/**
 * Локальная проверка механизма RLS + сессионных токенов на настоящем
 * PostgreSQL (PGlite, WASM). Supabase SQL Editor недоступен, поэтому схема
 * воспроизводится в миниатюре: те же таблицы, функции и политики.
 *
 * Ожидаемый результат:
 *   tokenA_messages = 0  — чужой чат не виден;
 *   spoof_messages  = 0  — подделка x-user-id без токена не работает;
 *   tokenB_messages = 1  — владелец чата видит своё сообщение.
 *
 * Запуск: node scripts/rls-pglite-test.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'scripts', 'rls-pglite-test.log');
writeFileSync(LOG, '');
function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  appendFileSync(LOG, `${text}\n`);
}

const schema = `
create table profiles (
  id uuid primary key,
  login text unique not null,
  role text not null default 'cadet'
);
create table credentials (
  profile_id uuid primary key references profiles(id) on delete cascade,
  password_hash text not null
);
create table auth_tokens (
  token_hash text primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  expires_at bigint not null
);
create table chats (
  id uuid primary key,
  owner_id uuid references profiles(id) on delete set null
);
create table chat_participants (
  chat_id uuid references chats(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  primary key (chat_id, user_id)
);
create table messages (
  id uuid primary key,
  chat_id uuid references chats(id) on delete cascade,
  sender_id uuid references profiles(id) on delete cascade,
  ciphertext text not null default ''
);

create or replace function current_user_id() returns uuid
language sql stable security definer set search_path = public as $$
  select t.user_id
    from auth_tokens t
   where t.token_hash = encode(
           sha256(convert_to(
             coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-session-token', ''),
             'UTF8'
           )),
           'hex'
         )
     and t.expires_at > (extract(epoch from now()) * 1000)::bigint
   limit 1
$$;

create or replace function issue_session_token(p_login text, p_hash text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
  v_token text;
begin
  select c.profile_id into v_user
    from credentials c join profiles p on p.id = c.profile_id
   where p.login = lower(trim(p_login))
     and lower(trim(c.password_hash)) = lower(trim(p_hash))
   limit 1;
  if v_user is null then
    raise exception 'invalid credentials';
  end if;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into auth_tokens (token_hash, user_id, expires_at)
  values (
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    v_user,
    (extract(epoch from now()) * 1000)::bigint + 30::bigint * 24 * 60 * 60 * 1000
  );
  return v_token;
end;
$$;

create or replace function is_chat_member(p_chat uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from chat_participants
     where chat_id = p_chat and user_id = p_user
  )
$$;

alter table profiles enable row level security;
alter table credentials enable row level security;
alter table auth_tokens enable row level security;
alter table chats enable row level security;
alter table chat_participants enable row level security;
alter table messages enable row level security;

create policy profiles_select on profiles for select using (true);
create policy chats_select on chats for select
  using (is_chat_member(id, current_user_id()));
create policy messages_select on messages for select
  using (is_chat_member(chat_id, current_user_id()));
`;

const db = new PGlite();
const result = { tokenA_messages: null, spoof_messages: null, tokenB_messages: null, secure: false };

try {
  await db.exec(schema);

  await db.exec(`
    insert into profiles (id, login, role) values
      ('11111111-1111-4111-8111-111111111111', 'alice', 'cadet'),
      ('22222222-2222-4222-8222-222222222222', 'bob', 'cadet');
    insert into credentials (profile_id, password_hash) values
      ('11111111-1111-4111-8111-111111111111', 'hash-alice'),
      ('22222222-2222-4222-8222-222222222222', 'hash-bob');
    insert into chats (id, owner_id) values ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222');
    insert into chat_participants (chat_id, user_id) values
      ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222');
    insert into messages (id, chat_id, sender_id, ciphertext) values
      ('44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333',
       '22222222-2222-4222-8222-222222222222', 'secret');
  `);

  const { rows: aliceToken } = await db.query(`select issue_session_token('alice','hash-alice') as token`);
  const { rows: bobToken } = await db.query(`select issue_session_token('bob','hash-bob') as token`);

  await db.exec(`create role anon; grant usage on schema public to anon;
                 grant select on all tables in schema public to anon;`);

  async function countAs(headers) {
    await db.exec(`reset role; select set_config('request.headers', '${JSON.stringify(headers)}', false); set role anon;`);
    const { rows } = await db.query('select count(*)::int as n from messages');
    return rows[0].n;
  }

  result.tokenA_messages = await countAs({ 'x-session-token': aliceToken[0].token });
  result.spoof_messages = await countAs({
    'x-user-id': '22222222-2222-4222-8222-222222222222',
  });
  result.tokenB_messages = await countAs({ 'x-session-token': bobToken[0].token });
  result.secure =
    result.tokenA_messages === 0 && result.spoof_messages === 0 && result.tokenB_messages === 1;

  log(`alice (токен, чужой чат): сообщений ${result.tokenA_messages}`);
  log(`подделка x-user-id без токена: сообщений ${result.spoof_messages}`);
  log(`bob (токен, свой чат): сообщений ${result.tokenB_messages}`);
  log(result.secure ? 'РЕЗУЛЬТАТ: RLS + токены работают' : 'РЕЗУЛЬТАТ: проверка не пройдена');
} catch (error) {
  result.error = String(error?.message ?? error);
  log(`ОШИБКА: ${result.error}`);
  log(`STACK: ${error?.stack ?? ''}`);
} finally {
  await db.close();
  log(`ИТОГ: ${JSON.stringify(result)}`);
  process.exit(result.secure ? 0 : 1);
}
