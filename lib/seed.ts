/**
 * Первоначальное наполнение базы Supabase: админ + 200 курсантов.
 *
 * Раньше 201 учётная запись создавалась на клиенте и складывалась в localStorage.
 * Теперь пользователи живут в общей базе, а создаёт их серверная функция
 * public.seed_svyaz_users() (см. supabase/schema.sql):
 *  • один вызов вместо 201 запроса — быстро даже на мобильном интернете;
 *  • функция идемпотентна: повторный запуск досоздаёт только отсутствующих;
 *  • пароли хэшируются на сервере тем же SHA-256(login:password), что и при входе.
 *
 * Клиент только просит базу наполниться и сообщает прогресс.
 */

import { countProfiles, seedUsers } from './db';

export const CADETS_COUNT = 200;
export const TOTAL_ACCOUNTS = CADETS_COUNT + 1;

export interface SeedResult {
  /** сколько пользователей создано в этот раз */
  created: number;
  /** всего пользователей в базе после сида */
  total: number;
  /** база была пуста и создаётся с нуля */
  fresh: boolean;
}

export interface SeedOptions {
  onProgress?: (created: number, total: number) => void;
}

/**
 * На каждом старте делается только один лёгкий count — если 201 профиль уже
 * на месте, ничего не пишется. Серверный сид выполняется, только когда база
 * пустая или неполная (первый запуск, новая среда).
 */
export async function seedIfNeeded(options: SeedOptions = {}): Promise<SeedResult> {
  const total = await countProfiles();
  const fresh = total === 0;
  if (!fresh && total >= TOTAL_ACCOUNTS) {
    return { created: 0, total, fresh: false };
  }

  options.onProgress?.(0, TOTAL_ACCOUNTS);
  const created = await seedUsers();

  if (created > 0) {
    console.log(
      `База Supabase наполнена: ${created} новых учётных записей. ` +
        'Логины: cadet001..cadet200 (пароль test1234), admin (admin12345)',
    );
  }

  return { created, total: await countProfiles(), fresh };
}
