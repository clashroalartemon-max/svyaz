/**
 * Разрешает импорты без расширения (./crypto → ./crypto.ts) для Node.
 * Нужен только тестам: в приложении этим занимается Vite.
 */

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.[a-zA-Z0-9]+$/.test(specifier)
  ) {
    for (const candidate of [`${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`]) {
      try {
        return await nextResolve(candidate, context);
      } catch {
        /* пробуем следующий вариант */
      }
    }
  }
  return nextResolve(specifier, context);
}
