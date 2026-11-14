/**
 * Мини-разметка сообщений: **жирный**, *курсив*, __подчёркнутый__,
 * ~~зачёркнутый~~, ||спойлер||, `код`.
 * Возвращает плоский список токенов — рендер не использует dangerouslySetInnerHTML.
 */
export type TextTokenType =
  | 'text'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'spoiler'
  | 'code';

export interface TextToken {
  type: TextTokenType;
  value: string;
}

const PATTERN =
  /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\|\|[^|]+\|\||`[^`]+`|\*[^*]+\*|_[^_]+_)/g;

export function parseFormatting(input: string): TextToken[] {
  if (!input) return [];
  const tokens: TextToken[] = [];
  let lastIndex = 0;
  for (const match of input.matchAll(PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ type: 'text', value: input.slice(lastIndex, index) });
    }
    const raw = match[0];
    if (raw.startsWith('**')) {
      tokens.push({ type: 'bold', value: raw.slice(2, -2) });
    } else if (raw.startsWith('__')) {
      tokens.push({ type: 'underline', value: raw.slice(2, -2) });
    } else if (raw.startsWith('~~')) {
      tokens.push({ type: 'strike', value: raw.slice(2, -2) });
    } else if (raw.startsWith('||')) {
      tokens.push({ type: 'spoiler', value: raw.slice(2, -2) });
    } else if (raw.startsWith('`')) {
      tokens.push({ type: 'code', value: raw.slice(1, -1) });
    } else {
      tokens.push({ type: 'italic', value: raw.slice(1, -1) });
    }
    lastIndex = index + raw.length;
  }
  if (lastIndex < input.length) {
    tokens.push({ type: 'text', value: input.slice(lastIndex) });
  }
  return tokens;
}
