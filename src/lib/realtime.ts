/**
 * Realtime вместо BroadcastChannel и опроса localStorage.
 *
 * Один канал Supabase Realtime в режиме broadcast:
 *  • 'message' — автор после записи в базу сообщает «в чате X появилось новое
 *    сообщение»; получатель перечитывает чат обычным запросом, который
 *    фильтруется RLS (чужие чаты он не увидит);
 *  • 'typing' — «печатает…».
 *
 * Почему broadcast, а не postgres_changes: у postgres_changes RLS проверяется
 * под ролью anon без наших заголовков, и строгие политики просто не отдали бы
 * события. Broadcast идёт через websocket и не требует ослаблять RLS.
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { emit, on } from './bus';
import type { TypingPayload } from './bus';

let channel: RealtimeChannel | null = null;
let running = false;

export interface MessageBroadcast {
  chatId: string;
  messageId?: string;
  senderId?: string;
  /** new — новое сообщение, updated — правка/статус/удаление */
  kind?: 'new' | 'updated';
}

export interface ChatBroadcast {
  chatId: string;
}

/**
 * Открыть подписку. Повторный вызов безопасен.
 *
 * Почему broadcast, а не postgres_changes: у postgres_changes RLS проверяется
 * под ролью anon без заголовка x-user-id, и строгие политики просто не отдали
 * бы события. Broadcast идёт через websocket и не требует ослаблять RLS.
 */
export function startRealtime(): void {
  if (running) return;
  try {
    channel = supabase()
      .channel('svyaz-events')
      .on('broadcast', { event: 'message' }, ({ payload }) => {
        const data = payload as MessageBroadcast | undefined;
        if (data?.kind === 'updated') {
          emit('message:updated', { chatId: data.chatId, messageId: data.messageId });
        } else if (data?.chatId) {
          emit('message:new', {
            chatId: data.chatId,
            messageId: data.messageId,
            senderId: data.senderId,
          });
        } else {
          // изменение без привязки к чату (статус, правка) — обновляем списки
          emit('chat:updated', {});
        }
        if (data?.chatId) emit('chat:updated', { chatId: data.chatId });
      })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        emit('typing', payload as TypingPayload);
      })
      .on('broadcast', { event: 'chat' }, ({ payload }) => {
        const data = payload as ChatBroadcast | undefined;
        // Новый чат создан на другом устройстве — перечитываем список.
        emit('chat:updated', data?.chatId ? { chatId: data.chatId } : {});
      })
      .subscribe();
    running = true;
  } catch (error) {
    running = false;
    console.warn('Realtime недоступен', error);
  }
}

export function stopRealtime(): void {
  if (channel) void channel.unsubscribe();
  channel = null;
  running = false;
}

/** Сообщить остальным устройствам, что в чате появилось сообщение */
export async function broadcastMessage(data: MessageBroadcast): Promise<void> {
  if (!channel) return;
  try {
    await channel.send({ type: 'broadcast', event: 'message', payload: data });
  } catch {
    /* не критично: получатель увидит сообщение при следующем открытии чата */
  }
}

/**
 * Сообщить остальным устройствам, что создан новый чат.
 * Получатель просто перечитывает свой список — RLS покажет ему только те
 * чаты, где он участник.
 */
export async function broadcastChat(chatId: string): Promise<void> {
  if (!channel) return;
  try {
    const payload: ChatBroadcast = { chatId };
    await channel.send({ type: 'broadcast', event: 'chat', payload });
  } catch {
    /* не критично: чат появится при следующем обновлении списка */
  }
}

/** Отправить «печатает…» */
export async function sendTyping(payload: TypingPayload): Promise<void> {
  if (!channel) return;
  try {
    await channel.send({ type: 'broadcast', event: 'typing', payload });
  } catch {
    /* не критично */
  }
}

/** При смене пользователя подписку пересоздаём */
export function bindRealtimeToAuth(): () => void {
  return on('auth:changed', () => {
    stopRealtime();
    startRealtime();
  });
}
