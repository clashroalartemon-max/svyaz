/** Опрос в сообщении: `[poll]{"q":"…","options":["…","…"]}`. */
export const POLL_PREFIX = '[poll]';

export interface Poll {
  q: string;
  options: string[];
}

export function encodePoll(poll: Poll): string {
  return `${POLL_PREFIX}${JSON.stringify(poll)}`;
}

export function parsePoll(text: string): Poll | null {
  if (!text.startsWith(POLL_PREFIX)) return null;
  try {
    const value = JSON.parse(text.slice(POLL_PREFIX.length)) as Poll;
    if (!value || typeof value.q !== 'string' || !Array.isArray(value.options)) return null;
    return { q: value.q.slice(0, 200), options: value.options.slice(0, 6).map(String) };
  } catch {
    return null;
  }
}

export function pollVoteKey(messageId: string): string {
  return `svyaz.pollVote.${messageId}`;
}
