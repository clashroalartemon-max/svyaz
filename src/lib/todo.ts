/** Список задач в сообщении: `[todo]{"items":["…","…"]}`. */
export const TODO_PREFIX = '[todo]';

export interface TodoList {
  items: string[];
}

export function encodeTodo(items: string[]): string {
  return `${TODO_PREFIX}${JSON.stringify({ items })}`;
}

export function parseTodo(text: string): TodoList | null {
  if (!text.startsWith(TODO_PREFIX)) return null;
  try {
    const value = JSON.parse(text.slice(TODO_PREFIX.length)) as TodoList;
    if (!value || !Array.isArray(value.items)) return null;
    return { items: value.items.slice(0, 20).map(String) };
  } catch {
    return null;
  }
}

export function todoDoneKey(messageId: string): string {
  return `svyaz.todoDone.${messageId}`;
}
