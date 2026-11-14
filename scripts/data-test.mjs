/**
 * УСТАРЕЛО. Тест писался для версии, где весь data-слой лежал в localStorage.
 * После перехода на Supabase (src/lib/db.ts) проверки требуют живой базы,
 * поэтому скрипт заменён заглушкой.
 *
 * Как проверить текущую версию:
 *   1. выполните supabase/schema.sql в Supabase → SQL Editor;
 *   2. npm run dev;
 *   3. войдите cadet001 / test1234 и cadet002 / test1234 в двух браузерах;
 *   4. отправьте сообщение — оно должно появиться на втором устройстве.
 */

console.error(
  'scripts/data-test.mjs устарел: data-слой переведён на Supabase. ' +
    'Выполните supabase/schema.sql и проверьте приложение вручную.',
);
process.exit(0);
